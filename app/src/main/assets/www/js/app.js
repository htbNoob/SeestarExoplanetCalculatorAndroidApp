// UI controller: pages, shared site / instrument pickers, persistence and the
// four tools. Mirrors app.py (Streamlit) for a phone-sized screen.
import { makeInstrument } from "./core.js";
import {
  CAMERA_PRESETS, DEFAULT_CAMERA, DEFAULT_OTA, DEFAULT_PRESET, LIGHTCURVE_PRESETS, MANUAL_OPTION,
  OTA_PRESETS, PRESET_SITES,
} from "./presets.js";
import { computeDarkWindow, isValidTz, localIso, tdbToUtc, utcIso16 } from "./site.js";
import { simulateTransit } from "./lightcurve.js";
import { buildTransitCurves, fetchToiCandidates, fetchTransitingPlanets, findTonightTransits } from "./transits.js";
import { buildEclipseCurves, findTonightEclipses, queryVsx, vsxConeForSite } from "./eb.js";
import { fetchHourlyForecast, summarizeDarkWindowWeather } from "./weather.js";
import { cached } from "./http.js";
import { fmtNum, renderCandidateCurve, renderLightCurve, renderSnrOverview, renderWeather } from "./charts.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- storage
const store = {
  get(k, d) { try { const v = localStorage.getItem("sp:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("sp:" + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- shared state
const state = {
  ota: store.get("ota", DEFAULT_OTA),
  cam: store.get("cam", DEFAULT_CAMERA),
  preset: store.get("sitePreset", DEFAULT_PRESET),
  site: store.get("site", { ...PRESET_SITES[DEFAULT_PRESET] }),
};
if (!OTA_PRESETS[state.ota]) state.ota = DEFAULT_OTA;
if (!CAMERA_PRESETS[state.cam]) state.cam = DEFAULT_CAMERA;
if (state.preset !== MANUAL_OPTION && !PRESET_SITES[state.preset]) state.preset = DEFAULT_PRESET;

const instrument = () => makeInstrument(OTA_PRESETS[state.ota], CAMERA_PRESETS[state.cam]);
const bus = new EventTarget();

// ---------------------------------------------------------------- instrument card
function instrumentCaption(inst) {
  return `${inst.ota.aperture_mm.toFixed(0)} mm aperture, f/${inst.ota.f_ratio.toFixed(1)} · ` +
    `${inst.pixel_scale_arcsec.toFixed(2)}"/px · QE ${(inst.camera.qe * 100).toFixed(0)}% · ` +
    `read noise ${inst.camera.read_noise_e.toFixed(1)} e⁻ · full well ${inst.camera.full_well_e.toFixed(0)} e⁻`;
}

function mountInstrumentCards() {
  for (const slot of $$(".slot-instrument")) {
    slot.innerHTML = `
      <details class="card instrument-card">
        <summary>Instrument <span class="summary-sub"></span></summary>
        <label class="field"><span>Optical tube</span><select data-role="ota"></select></label>
        <label class="field"><span>Camera</span><select data-role="cam"></select></label>
        <p class="caption" data-role="caption"></p>
      </details>`;
    const ota = $('[data-role="ota"]', slot), cam = $('[data-role="cam"]', slot);
    ota.innerHTML = Object.keys(OTA_PRESETS).map((k) => `<option>${esc(k)}</option>`).join("");
    cam.innerHTML = Object.keys(CAMERA_PRESETS).map((k) => `<option>${esc(k)}</option>`).join("");
    ota.addEventListener("change", () => { state.ota = ota.value; store.set("ota", state.ota); syncInstrumentCards(); });
    cam.addEventListener("change", () => { state.cam = cam.value; store.set("cam", state.cam); syncInstrumentCards(); });
  }
  syncInstrumentCards(false);
}

function syncInstrumentCards(notify = true) {
  const inst = instrument();
  for (const slot of $$(".slot-instrument")) {
    $('[data-role="ota"]', slot).value = state.ota;
    $('[data-role="cam"]', slot).value = state.cam;
    $('[data-role="caption"]', slot).textContent = instrumentCaption(inst);
    $(".summary-sub", slot).textContent = inst.name;
  }
  if (notify) bus.dispatchEvent(new Event("instrument"));
}

// ---------------------------------------------------------------- site card
const SITE_FIELDS = [
  ["name", "Site name", "text"], ["lat", "Latitude (° N)", "number"], ["lon", "Longitude (° E)", "number"],
  ["elev_m", "Elevation (m)", "number"], ["tz", "Timezone (IANA)", "text"],
];

function mountSiteCards() {
  for (const slot of $$(".slot-site")) {
    slot.innerHTML = `
      <details class="card site-card">
        <summary>Observer site <span class="summary-sub"></span></summary>
        <label class="field"><span>Observatory</span><select data-role="preset"></select></label>
        <div class="row">
          <button type="button" class="secondary" data-role="gps">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5" fill="currentColor"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3" stroke="currentColor" stroke-width="2"/></svg>
            Use my location</button>
          <span class="caption" data-role="gps-status"></span>
        </div>
        <div class="grid2">
          ${SITE_FIELDS.map(([k, label, type]) => `
            <label class="field" ${k === "name" ? 'style="grid-column: 1 / -1"' : ""}><span>${label}</span>
              <input type="${type}" ${type === "number" ? 'step="any"' : 'autocapitalize="off" autocomplete="off" spellcheck="false"'} data-site="${k}"></label>`).join("")}
        </div>
        <p class="hint" style="margin-top:-6px">Timezone e.g. Europe/Berlin, America/Los_Angeles, Asia/Tokyo – used only to display local times alongside UTC.</p>
        <p class="notice warn" data-role="tz-warn" hidden></p>
      </details>`;
    const preset = $('[data-role="preset"]', slot);
    preset.innerHTML = [...Object.keys(PRESET_SITES), MANUAL_OPTION].map((k) => `<option>${esc(k)}</option>`).join("");
    preset.addEventListener("change", () => applyPreset(preset.value));
    for (const inp of $$("[data-site]", slot)) {
      inp.addEventListener("input", () => {
        const k = inp.dataset.site;
        state.site[k] = inp.type === "number" ? parseFloat(inp.value) : inp.value;
        store.set("site", state.site);
        syncSiteCards(slot);
      });
    }
    $('[data-role="gps"]', slot).addEventListener("click", () => useMyLocation(slot));
  }
  syncSiteCards();
}

function applyPreset(name) {
  $$('[data-role="gps-status"]').forEach((e) => { e.textContent = ""; });
  state.preset = name;
  store.set("sitePreset", name);
  if (name !== MANUAL_OPTION) {
    state.site = { ...PRESET_SITES[name] };
    store.set("site", state.site);
    // Prefill the per-page sky brightness from the preset (still editable).
    for (const f of $$(".sky-field")) { f.value = state.site.sky_mag; store.set(f.id, f.value); }
  }
  syncSiteCards();
}

function syncSiteCards(except) {
  const manual = state.preset === MANUAL_OPTION;
  const s = state.site;
  for (const slot of $$(".slot-site")) {
    $('[data-role="preset"]', slot).value = state.preset;
    $(".summary-sub", slot).textContent = s.name || "";
    for (const inp of $$("[data-site]", slot)) {
      inp.disabled = !manual;
      if (slot !== except) {
        const v = s[inp.dataset.site];
        inp.value = v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? "" : v;
      }
    }
    const warn = $('[data-role="tz-warn"]', slot);
    warn.hidden = isValidTz(s.tz);
    warn.textContent = `Unrecognized timezone '${s.tz}' – falling back to UTC for local-time display.`;
  }
}

function useMyLocation(slot) {
  const status = $('[data-role="gps-status"]', slot);
  if (!navigator.geolocation) { status.textContent = "Location not available on this device."; return; }
  status.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition((pos) => {
    const c = pos.coords;
    state.preset = MANUAL_OPTION;
    store.set("sitePreset", state.preset);
    state.site = {
      name: "My location",
      lat: Math.round(c.latitude * 1e4) / 1e4,
      lon: Math.round(c.longitude * 1e4) / 1e4,
      elev_m: Number.isFinite(c.altitude) && c.altitude !== null ? Math.round(c.altitude) : (state.site.elev_m || 0),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      sky_mag: state.site.sky_mag ?? 18.0,
    };
    store.set("site", state.site);
    syncSiteCards();
    status.textContent = `±${Math.round(c.accuracy)} m`;
  }, (err) => {
    status.textContent = err.code === 1 ? "Location permission denied." : "Couldn't get a location fix.";
  }, { enableHighAccuracy: false, timeout: 20000, maximumAge: 600000 });
}

function currentSite() {
  const s = state.site;
  return { name: s.name || "Custom site", lat: Number(s.lat) || 0, lon: Number(s.lon) || 0,
    elev_m: Number(s.elev_m) || 0, tz: s.tz || "UTC" };
}

// ---------------------------------------------------------------- persisted inputs
function initPersistence() {
  for (const el of $$("[data-persist], .sky-field")) {
    const key = el.dataset.persist || el.id;
    if (el.classList.contains("chips")) continue;
    const saved = store.get(key, undefined);
    if (saved !== undefined) {
      if (el.type === "checkbox") el.checked = !!saved; else el.value = saved;
    } else if (el.classList.contains("sky-field")) {
      el.value = state.site.sky_mag ?? 18.0;
    }
    el.addEventListener(el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input",
      () => store.set(key, el.type === "checkbox" ? el.checked : el.value));
  }
  // range outputs
  for (const out of $$("output[data-for]")) {
    const inp = document.getElementById(out.dataset.for);
    const upd = () => { out.textContent = inp.value; };
    inp.addEventListener("input", upd); upd();
  }
}

function initChips(el, onChange) {
  const opts = el.dataset.options.split(",").map(Number);
  let sel = new Set(store.get(el.dataset.persist, el.dataset.default.split(",").map(Number)));
  el.innerHTML = opts.map((o) => `<button type="button" class="chip" data-v="${o}">${o}</button>`).join("");
  const paint = () => $$(".chip", el).forEach((b) => b.classList.toggle("on", sel.has(Number(b.dataset.v))));
  el.addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    const v = Number(b.dataset.v);
    if (sel.has(v)) sel.delete(v); else sel.add(v);
    store.set(el.dataset.persist, [...sel]); paint(); onChange();
  });
  paint();
  return () => [...sel].sort((a, b) => a - b);
}

const num = (id) => parseFloat(document.getElementById(id).value);
const checked = (id) => document.getElementById(id).checked;

// ---------------------------------------------------------------- navigation
const PAGES = ["snr", "lc", "transits", "eb"];
const onShow = {};
const scrollPos = {};
let currentPage = null;
function route() {
  const id = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "snr";
  if (currentPage) scrollPos[currentPage] = window.scrollY;
  currentPage = id;
  for (const p of PAGES) document.getElementById("page-" + p).hidden = p !== id;
  $$(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.page === id));
  $("#pageSubtitle").textContent = document.getElementById("page-" + id).dataset.title;
  window.scrollTo(0, scrollPos[id] || 0);
  onShow[id] && onShow[id]();
  // charts rendered while hidden need a resize once visible
  requestAnimationFrame(() => $$(`#page-${id} .chart`).forEach((d) => d.data && window.Plotly.Plots.resize(d)));
}

// ================================================================ Page 1: SNR
function initSnrPage() {
  let getMags, getExps, timer = null, dirty = true;
  const render = () => {
    if (document.getElementById("page-snr").hidden) { dirty = true; return; }
    dirty = false;
    renderSnrOverview($("#snr_charts"), {
      refSky: num("snr_sky"), expFixed: num("snr_exp"),
      starMags: getMags().length ? getMags() : [10],
      expTimes: getExps().length ? getExps() : [10],
      instrument: instrument(),
    });
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(render, 120); };
  getMags = initChips($("#snr_mags"), schedule);
  getExps = initChips($("#snr_exps"), schedule);
  $("#snr_sky").addEventListener("input", schedule);
  $("#snr_exp").addEventListener("input", schedule);
  bus.addEventListener("instrument", () => { dirty = true; schedule(); });
  onShow.snr = () => { if (dirty) render(); };
}

// ================================================================ Page 2: Light curve
function initLcPage() {
  const sel = $("#lc_preset");
  sel.innerHTML = Object.keys(LIGHTCURVE_PRESETS).map((k) => `<option>${esc(k)}</option>`).join("");
  const saved = store.get("lc_preset", "Custom");
  sel.value = LIGHTCURVE_PRESETS.hasOwnProperty(saved) ? saved : "Custom";
  const map = { star_mag: "lc_star_mag", k: "lc_k", b_imp: "lc_b", t14_h: "lc_t14", u1: "lc_u1", u2: "lc_u2" };
  sel.addEventListener("change", () => {
    const p = LIGHTCURVE_PRESETS[sel.value];
    if (p) for (const [k, id] of Object.entries(map)) {
      const el = document.getElementById(id); el.value = p[k]; store.set(id, el.value);
    }
    checkGrazing();
  });
  // Editing a parameter by hand switches the preset label back to "Custom".
  for (const id of Object.values(map)) document.getElementById(id).addEventListener("input", () => {
    if (sel.value !== "Custom") { sel.value = "Custom"; store.set("lc_preset", "Custom"); }
  });

  const checkGrazing = () => {
    const k = num("lc_k"), b = num("lc_b");
    $("#lc_grazing").hidden = !(k >= 1 - b && b < 1);
  };
  ["lc_k", "lc_b"].forEach((id) => document.getElementById(id).addEventListener("input", checkGrazing));
  checkGrazing();

  $("#lc_run").addEventListener("click", () => {
    const err = $("#lc_error");
    err.hidden = true;
    const v = {
      star_mag: num("lc_star_mag"), k: num("lc_k"), b_imp: num("lc_b"), t14_h: num("lc_t14"),
      u1: num("lc_u1"), u2: num("lc_u2"), exposure_s: num("lc_exp"), sky_mag: num("lc_sky"),
      obs_hours: num("lc_obs"), bin_min: num("lc_bin"), seed: Math.trunc(num("lc_seed")),
    };
    const bad = Object.entries(v).filter(([, x]) => !Number.isFinite(x)).map(([k]) => k);
    if (bad.length) { err.textContent = "Please fill in all fields with numbers."; err.hidden = false; return; }
    if (v.k < 0.001 || v.k > 0.9 || v.b_imp < 0 || v.b_imp > 1.5 || v.t14_h < 0.05 || v.exposure_s < 0.1 ||
        v.obs_hours < 0.5 || v.bin_min < 0.1) {
      err.textContent = "Out of range: Rp/Rs 0.001–0.9, impact 0–1.5, T14 ≥ 0.05 h, exposure ≥ 0.1 s, window ≥ 0.5 h, bin ≥ 0.1 min.";
      err.hidden = false; return;
    }
    if (v.obs_hours * 3600 / v.exposure_s > 400000) {
      err.textContent = "Too many frames (window / exposure > 400 000) – use a longer exposure or shorter window.";
      err.hidden = false; return;
    }
    if (v.b_imp >= 1 + v.k) {
      err.textContent = "Impact parameter ≥ 1 + Rp/Rs: the planet never crosses the star (no transit).";
      err.hidden = false; return;
    }
    if (checked("lc_randomize")) { v.seed = Math.floor(Math.random() * 1_000_000); }
    const btn = $("#lc_run");
    btn.disabled = true; btn.textContent = "Simulating…";
    setTimeout(() => {
      try {
        const r = simulateTransit({ ...v, instrument: instrument() });
        const out = $("#lc_results");
        out.innerHTML = "";
        out.append(metrics([
          ["Depth", `${r.depth_pct.toFixed(3)}%`, `${r.depth_ppm.toFixed(0)} ppm`],
          ["SNR / frame", r.snr_per_frame.toFixed(1)],
          ["Depth / frame σ", `${r.depth_over_sigma.toFixed(1)}×`],
          ["Max safe exposure", `${r.max_safe_exposure_s.toFixed(0)} s`],
        ]));
        const cap = document.createElement("p");
        cap.className = "caption"; cap.style.margin = "0 4px 12px";
        cap.textContent = `T14 = ${r.t14_h.toFixed(2)} h, T23 = ${r.t23_h.toFixed(2)} h, ingress/egress ${r.ingress_min.toFixed(1)} min each · ` +
          `${r.frames_in_transit} frames → ${r.bins_in_transit} bins in transit, binned σ ${r.binned_sigma_mmag.toFixed(2)} mmag/bin` +
          (r.grazing ? " · GRAZING TRANSIT" : "") + (checked("lc_randomize") ? ` · seed ${v.seed}` : "");
        out.append(cap);
        renderLightCurve(out, r);
        out.firstElementChild.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) {
        err.textContent = "Simulation failed: " + e.message; err.hidden = false;
      } finally {
        btn.disabled = false; btn.textContent = "Simulate";
      }
    }, 30);
  });
}

// ================================================================ shared result helpers
function metrics(items, cls = []) {
  const d = document.createElement("div");
  d.className = "metrics";
  d.innerHTML = items.map(([l, v, delta], i) => `
    <div class="metric ${cls[i] || ""}"><span class="label">${esc(l)}</span><span class="value">${esc(v)}</span>${delta ? `<span class="delta">${esc(delta)}</span>` : ""}</div>`).join("");
  return d;
}

function statusList(container) {
  const ul = document.createElement("ul");
  ul.className = "status card";
  container.append(ul);
  let cur = null;
  return {
    step(text) { if (cur) cur.className = "done"; cur = document.createElement("li"); cur.className = "active"; cur.textContent = text; ul.append(cur); return cur; },
    update(text) { if (cur) cur.textContent = text; },
    done(text) { if (cur) { cur.className = "done"; if (text) cur.textContent = text; } cur = null; },
    fail(text) { if (cur) { cur.className = "fail"; if (text) cur.textContent = text; } cur = null; },
    remove() { ul.remove(); },
  };
}

function notice(container, kind, text) {
  const p = document.createElement("p");
  p.className = "notice " + kind; p.textContent = text;
  container.append(p); return p;
}

function heading(container, text) {
  const h = document.createElement("h2"); h.className = "section-title"; h.textContent = text; container.append(h);
}

function darkWindowCard(container, site, dw) {
  const d = document.createElement("div");
  d.className = "card";
  const hours = ((dw.de_jd - dw.ds_jd) * 24).toFixed(1);
  d.innerHTML = `<dl class="kv">
    <dt>Site</dt><dd>${esc(site.name)} (${site.lat >= 0 ? "+" : ""}${site.lat.toFixed(3)}, ${site.lon >= 0 ? "+" : ""}${site.lon.toFixed(3)})</dd>
    <dt>Dark window</dt><dd>${utcIso16(dw.darkStartUtc)} – ${utcIso16(dw.darkEndUtc).slice(11)} UTC (${hours} h)</dd>
    <dt>Local (${esc(site.tz)})</dt><dd>${localIso(dw.darkStartUtc, site.tz)} – ${localIso(dw.darkEndUtc, site.tz)}</dd>
  </dl>`;
  container.append(d);
}

async function showWeather(container, dw) {
  heading(container, "Weather forecast");
  const site = dw.site;
  const fc = await cached(`wx:${site.lat}:${site.lon}`, 1800, () => fetchHourlyForecast(site.lat, site.lon));
  const s = summarizeDarkWindowWeather(fc, dw);
  if (!s) { notice(container, "info", "No forecast hours fall within tonight's dark window."); return; }
  container.append(metrics([
    ["Conditions", s.rating],
    ["Mean cloud cover", `${s.mean_cloudcover.toFixed(0)}%`, `max ${s.max_cloudcover.toFixed(0)}%`],
    ["Mean precip. probability", `${fmtNum(s.mean_precip_prob, 0)}%`],
    ["Min. temp / max wind", `${fmtNum(s.min_temperature_c, 0)} °C / ${fmtNum(s.max_windspeed_kmh, 0)} km/h`],
  ], [s.rating.toLowerCase()]));
  const cap = document.createElement("p");
  cap.className = "caption"; cap.style.margin = "-2px 4px 12px";
  cap.textContent = "Rating: Good = <20% mean cloud & <20% precip. probability during the dark window; Fair = <60% cloud & <40% precip.; otherwise Poor. Forecast: Open-Meteo, cached 30 min.";
  container.append(cap);
  renderWeather(container, fc, dw, (jdUtc) => utcIso16(jdUtc));
}

function midTimes(tmidJd, tz) {
  const u = tdbToUtc(tmidJd);
  return { utc: utcIso16(u), local: localIso(u, tz) };
}

function candidateTable(container, cols, rows, anchorPrefix) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.innerHTML = `<table class="data"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr>${r.map((v, j) => `<td>${j === 0 ? `<a href="#" data-jump="${anchorPrefix}${i}">${v}</a>` : v}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  wrap.addEventListener("click", (e) => {
    const a = e.target.closest("[data-jump]"); if (!a) return;
    e.preventDefault();
    document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  container.append(wrap);
}

function withBusy(btnId, label, fn) {
  const btn = document.getElementById(btnId);
  return async () => {
    if (btn.disabled) return;
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    try { await fn(); } finally { btn.disabled = false; btn.textContent = orig; }
  };
}

// ================================================================ Page 3: transits
function initTransitsPage() {
  $("#tr_run").addEventListener("click", withBusy("tr_run", "Searching…", async () => {
    const out = $("#tr_results");
    out.innerHTML = "";
    const site = currentSite(), inst = instrument();
    const minAlt = num("tr_min_alt"), bright = num("tr_bright"), faint = num("tr_faint");
    const minDepth = num("tr_depth"), sky = num("tr_sky"), nTop = Math.trunc(num("tr_ntop"));
    if (![minAlt, bright, faint, minDepth, sky].every(Number.isFinite)) {
      notice(out, "error", "Please fill in all search fields with numbers."); return;
    }
    const dw = computeDarkWindow(site);
    if (dw.placeholder) notice(out, "warn", "No true dark window found in the next 36 h at this site – using an 8-hour placeholder window.");
    darkWindowCard(out, site, dw);

    const wx = document.createElement("div"); out.append(wx);
    const results = document.createElement("div"); out.append(results);
    const weatherP = showWeather(wx, dw).catch((e) => notice(wx, "warn", `Weather forecast unavailable (${e.message}).`));

    const st2 = statusList(results);
    st2.step("Querying NASA Exoplanet Archive…");
    let planets = await cached(`pl:${bright}:${faint}:${minDepth}`, 3600, () => fetchTransitingPlanets(bright, faint, minDepth));
    if (planets === null) {
      st2.fail("NASA Exoplanet Archive is currently unreachable (the service may be down or blocking requests) – please try again later.");
      await weatherP; return;
    }
    st2.done(`${planets.length} confirmed transiting planets in magnitude/depth range retrieved from archive.`);
    if (checked("tr_toi")) {
      st2.step("Querying TESS Objects of Interest (ExoFOP/TOI)…");
      const toi = await cached(`toi:${bright}:${faint}:${minDepth}`, 3600, () => fetchToiCandidates(bright, faint, minDepth));
      if (toi === null) st2.fail("TOI table unreachable – continuing with confirmed planets only.");
      else { st2.done(`${toi.length} unverified TOI candidates in range retrieved.`); planets = planets.concat(toi); }
    }
    st2.step("Ranking transits for tonight…");
    await new Promise((r) => setTimeout(r, 20));
    const top = findTonightTransits(planets, dw, minAlt, sky, nTop, inst);
    st2.done(`Ranked ${top.length} candidate${top.length === 1 ? "" : "s"}.`);
    await weatherP;

    if (!top.length) { notice(results, "info", "No transits found. Try relaxing min. altitude, faint limit, or min. depth."); return; }
    heading(results, `Top ${top.length} candidates`);
    candidateTable(results,
      ["Planet", "Host", "V", "Depth %", "Dur. (h)", "Min alt°", "Cover %", "SNR/5min", "Mid (UTC)", `Mid (${site.tz})`],
      top.map((c) => {
        const m = midTimes(c.tmid_jd, site.tz);
        return [esc(c.name) + (c.source !== "Confirmed" ? '<span class="tag">TOI</span>' : ""), esc(c.host), c.vmag.toFixed(1),
          c.dep_pct.toFixed(2), c.dur.toFixed(1), c.alt.toFixed(0), (c.frac * 100).toFixed(0), c.snr5.toFixed(0), m.utc, m.local];
      }), "tr-c");

    heading(results, "Predicted light curves");
    const curves = buildTransitCurves(top, dw, sky, { instrument: inst });
    curves.forEach((cd, i) => {
      const c = cd.cand, m = midTimes(c.tmid_jd, site.tz);
      renderCandidateCurve(results, cd, {
        id: `tr-c${i}`,
        title: `${i + 1}. ${c.name}${c.source !== "Confirmed" ? ` [${c.source}]` : ""}`,
        subtitle: `V=${c.vmag.toFixed(1)} · depth ${c.dep_pct.toFixed(2)}% · ${c.dur.toFixed(1)} h · mid ${m.utc} UTC (${m.local.slice(11)} local) · alt ≥ ${c.alt.toFixed(0)}° · coverage ${(c.frac * 100).toFixed(0)}% · SNR/5min ≈ ${c.snr5.toFixed(0)} · t_exp ${c.exp.toFixed(0)} s`,
        xLabel: "Time from mid-transit (min)", modelName: "Model",
      });
    });
  }));
}

// ================================================================ Page 4: eclipsing binaries
function initEbPage() {
  $("#eb_run").addEventListener("click", withBusy("eb_run", "Searching…", async () => {
    const out = $("#eb_results");
    out.innerHTML = "";
    const site = currentSite(), inst = instrument();
    const p = {
      minDepth: num("eb_depth"), maxPeriod: num("eb_period"), minDurH: num("eb_min_dur") / 60, maxDurH: num("eb_max_dur"),
      minAlt: num("eb_min_alt"), bright: num("eb_bright"), faint: num("eb_faint"), skyMag: num("eb_sky"),
      nTop: Math.trunc(num("eb_ntop")), includeCompact: checked("eb_compact"), instrument: inst,
    };
    if (![p.minDepth, p.maxPeriod, p.minDurH, p.maxDurH, p.bright, p.faint, p.skyMag].every(Number.isFinite)) {
      notice(out, "error", "Please fill in all search fields with numbers."); return;
    }
    const dw = computeDarkWindow(site);
    if (dw.placeholder) notice(out, "warn", "No true dark window found in the next 36 h at this site – using an 8-hour placeholder window.");
    darkWindowCard(out, site, dw);

    const wx = document.createElement("div"); out.append(wx);
    const results = document.createElement("div"); out.append(results);
    const weatherP = showWeather(wx, dw).catch((e) => notice(wx, "warn", `Weather forecast unavailable (${e.message}).`));

    const st = statusList(results);
    const cone = vsxConeForSite(dw, p.minAlt);
    st.step(`Querying AAVSO VSX (r = ${cone.radius.toFixed(0)}°) – this can take 1–2 min in dense fields…`);
    const t0 = Date.now();
    let curR = cone.radius;
    const tick = setInterval(() => st.update(`Querying AAVSO VSX (r = ${curR.toFixed(0)}°) – ${Math.round((Date.now() - t0) / 1000)} s…`), 1000);
    const key = `vsx:${cone.ra.toFixed(1)}:${cone.dec.toFixed(2)}:${cone.radius}:${p.bright}:${p.faint}`;
    let vsx;
    try {
      vsx = await cached(key, 3600, () => queryVsx(cone.ra, cone.dec, cone.radius, p.bright, p.faint, { onAttempt: (r) => { curR = r; } }));
    } finally { clearInterval(tick); }
    if (vsx.usedRadius === null) {
      st.fail("AAVSO VSX unreachable even at the smallest retry radius – falling back to the curated compact-object list only.");
    } else {
      st.done(`${vsx.rows.length} eclipsing-type variables retrieved from VSX.`);
      if (vsx.usedRadius < cone.radius - 0.5) {
        notice(results, "info", `Had to shrink the search cone to r=${vsx.usedRadius.toFixed(0)}° (target was ${cone.radius.toFixed(0)}°) – AAVSO couldn't finish the full query tonight, so coverage is reduced.`);
      }
    }
    const top = findTonightEclipses(vsx.rows, dw, p);
    await weatherP;
    if (!top.length) { notice(results, "info", "No eclipsing systems found. Try relaxing min. altitude, faint limit, or min. depth."); return; }

    heading(results, `Top ${top.length} candidates`);
    candidateTable(results,
      ["System", "Type", "V", "Depth (mag)", "Dur. (h)", "Period (d)", "Min alt°", "Cover %", "SNR/5min", "Mid (UTC)", `Mid (${site.tz})`],
      top.map((c) => {
        const m = midTimes(c.tmid_jd, site.tz);
        return [esc(c.name), esc(c.label), c.vmag.toFixed(1), c.depth_mag.toFixed(2), c.dur_h.toFixed(2), c.per.toFixed(3),
          c.alt.toFixed(0), (c.frac * 100).toFixed(0), c.snr5.toFixed(0), m.utc, m.local];
      }), "eb-c");

    heading(results, "Predicted eclipse curves");
    const curves = buildEclipseCurves(top, dw, p.skyMag, { instrument: inst });
    curves.forEach((cd, i) => {
      const c = cd.cand, m = midTimes(c.tmid_jd, site.tz);
      renderCandidateCurve(results, cd, {
        id: `eb-c${i}`,
        title: `${i + 1}. ${c.name} [${c.label}]`,
        subtitle: `V=${c.vmag.toFixed(1)} · depth ${c.depth_mag.toFixed(2)} mag · ${c.dur_h.toFixed(1)} h · P=${Number(c.per.toPrecision(4))} d · mid ${m.utc} UTC (${m.local.slice(11)} local) · alt ≥ ${c.alt.toFixed(0)}° · coverage ${(c.frac * 100).toFixed(0)}% · SNR/5min ≈ ${c.snr5.toFixed(0)} · t_exp ${c.exp.toFixed(0)} s`,
        xLabel: "Time from mid-eclipse (min)", modelName: "Model (trapezoidal)",
      });
    });
  }));
}

// ================================================================ night mode + boot
function initNightMode() {
  const on = store.get("night", false);
  document.body.classList.toggle("night", on);
  $("#nightBtn").addEventListener("click", () => {
    const v = !document.body.classList.contains("night");
    document.body.classList.toggle("night", v);
    store.set("night", v);
  });
}

function boot() {
  if (!window.Plotly) {
    document.body.insertAdjacentHTML("afterbegin", '<p class="notice error">Chart library failed to load.</p>');
  }
  initNightMode();
  mountInstrumentCards();
  mountSiteCards();
  initPersistence();
  initSnrPage();
  initLcPage();
  initTransitsPage();
  initEbPage();
  window.addEventListener("hashchange", route);
  route();
}

boot();
