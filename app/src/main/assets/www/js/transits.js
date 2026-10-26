// NASA Exoplanet Archive query (confirmed planets + TOI candidates), ranking of
// tonight's observable transits, and predicted light curves. Port of
// seestar_transits.py.
import { SEESTAR, calculateMaxExposure, linspace, makeRng, snrFull } from "./core.js";
import { binLightCurve, limbDarkenedDisk, transitFlux } from "./lightcurve.js";
import { minAltitudeDeg } from "./site.js";
import { buildUrl, httpGet } from "./http.js";

export const ARCHIVE_URL = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";
const EARTH_RADIUS_IN_SUN = 0.009157683;

/** Python-style float(): NaN for empty / unparsable strings. */
export function pyFloat(v) {
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  if (s === "") return NaN;
  const low = s.toLowerCase();
  if (low === "nan") return NaN;
  if (low === "inf" || low === "+inf" || low === "infinity") return Infinity;
  if (low === "-inf" || low === "-infinity") return -Infinity;
  const x = Number(s);
  return x;
}

/** Safe string -> float; `def` for empty / NaN / inf values (sfloat in Python). */
export function sfloat(v, def = null) {
  const x = pyFloat(v);
  return Number.isFinite(x) ? x : def;
}

/** Minimal RFC-4180 CSV parser -> array of objects keyed by the header row. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter((r) => r.length > 1 || r[0] !== "")
    .map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
}

const num = (x) => String(x);

async function tapQuery(adql, timeoutMs) {
  const url = buildUrl(ARCHIVE_URL, { query: adql, format: "csv" });
  try {
    const r = await httpGet(url, timeoutMs);
    if (!r.ok) return null;
    return parseCsv(r.text);
  } catch {
    return null;
  }
}

/** Confirmed transiting planets in a magnitude / depth (%) range; null if unreachable. */
export async function fetchTransitingPlanets(bright, faint, minDepthPct, timeoutMs = 45000) {
  const adql =
    "SELECT pl_name,hostname,ra,dec,sy_vmag," +
    "pl_orbper,pl_tranmid,pl_trandur,pl_trandep,pl_ratror,pl_imppar " +
    "FROM pscomppars " +
    "WHERE tran_flag=1 " +
    "AND pl_orbper IS NOT NULL AND pl_tranmid IS NOT NULL " +
    "AND pl_trandur IS NOT NULL AND pl_ratror IS NOT NULL " +
    "AND pl_trandep IS NOT NULL AND sy_vmag IS NOT NULL " +
    `AND sy_vmag>=${num(bright)} AND sy_vmag<=${num(faint)} ` +
    `AND pl_trandep>=${num(minDepthPct)}`;
  return tapQuery(adql, timeoutMs);
}

/** Unverified TESS Objects of Interest (PC/APC), reshaped to the planet schema. */
export async function fetchToiCandidates(bright, faint, minDepthPct, dispositions = ["PC", "APC"], timeoutMs = 45000) {
  const disp = dispositions.map((d) => `'${d}'`).join(",");
  const adql =
    "SELECT toi,tid,ra,dec,st_tmag," +
    "pl_orbper,pl_tranmid,pl_trandurh,pl_trandep,pl_rade,st_rad,tfopwg_disp " +
    "FROM toi " +
    "WHERE pl_orbper IS NOT NULL AND pl_tranmid IS NOT NULL " +
    "AND pl_trandurh IS NOT NULL AND pl_trandep IS NOT NULL AND st_tmag IS NOT NULL " +
    `AND st_tmag>=${num(bright)} AND st_tmag<=${num(faint)} ` +
    `AND pl_trandep>=${num(minDepthPct * 1e4)} ` +      // ppm here, % in pscomppars
    `AND tfopwg_disp IN (${disp})`;
  const rows = await tapQuery(adql, timeoutMs);
  if (rows === null) return null;
  const planets = [];
  for (const r of rows) {
    const depPpm = sfloat(r.pl_trandep);
    if (depPpm === null || depPpm <= 0) continue;
    const rade = sfloat(r.pl_rade), srad = sfloat(r.st_rad);
    const k = (rade !== null && srad !== null && srad > 0)
      ? rade * EARTH_RADIUS_IN_SUN / srad
      : Math.sqrt(depPpm / 1e6);
    if (!(k > 0)) continue;
    planets.push({
      pl_name: `TOI-${r.toi}`,
      hostname: `TIC ${r.tid}`,
      ra: r.ra, dec: r.dec,
      sy_vmag: r.st_tmag,                 // TESS mag used as a V-mag proxy
      pl_orbper: r.pl_orbper,
      pl_tranmid: r.pl_tranmid,
      pl_trandur: r.pl_trandurh,
      pl_trandep: String(depPpm / 1e4),
      pl_ratror: String(k),
      pl_imppar: "",                      // not published for TOIs -> central (b = 0)
      source: "TOI candidate",
    });
  }
  return planets;
}

/** Mid-times (TDB JD) of transits whose +/- half-duration overlaps [w0, w1]. */
export function transitsTonight(t0, per, durH, w0, w1) {
  const hd = durH / 48;
  const n0 = Math.floor((w0 - hd - t0) / per);
  const n1 = Math.ceil((w1 + hd - t0) / per);
  const out = [];
  for (let n = n0; n <= n1; n++) {
    const m = t0 + n * per;
    if (m + hd >= w0 && m - hd <= w1) out.push(m);
  }
  return out;
}

export function findTonightTransits(planets, dw, minAlt, skyMag, nTop = 5, instrument = SEESTAR) {
  const { ds_jd, de_jd, site } = dw;
  const cands = [];
  for (const p of planets) {
    const t0 = sfloat(p.pl_tranmid), per = sfloat(p.pl_orbper);
    const dur = sfloat(p.pl_trandur), dep = sfloat(p.pl_trandep);
    const vmag = sfloat(p.sy_vmag), ra = sfloat(p.ra);
    const dec = sfloat(p.dec), k = sfloat(p.pl_ratror);
    let bimp = sfloat(p.pl_imppar, 0.0);
    if ([t0, per, dur, dep, vmag, ra, dec, k].includes(null) || k <= 0) continue;
    bimp = Math.min(Math.max(Math.abs(bimp), 0), 1 + k - 1e-4);

    for (const mid of transitsTonight(t0, per, dur, ds_jd, de_jd)) {
      const t1 = mid - dur / 48, t4 = mid + dur / 48;
      const ot0 = Math.max(t1, ds_jd), ot1 = Math.min(t4, de_jd);
      if (ot1 <= ot0) continue;
      const alt = minAltitudeDeg(ra, dec, ot0, ot1, site);
      if (alt < minAlt) continue;
      const frac = (ot1 - ot0) / (t4 - t1);
      const exp = Math.max(1, Math.min(calculateMaxExposure(vmag, instrument) * 0.8, 60));
      const snr5 = snrFull(vmag, exp, skyMag, instrument) * Math.sqrt(300 / exp);
      const score = dep * Math.min(snr5, 1000) / 100 * frac * Math.sin(alt * Math.PI / 180);
      cands.push({
        name: p.pl_name, host: p.hostname, vmag, ra, dec,
        tmid_jd: mid, t1_jd: t1, t4_jd: t4, dur, dep_pct: dep, k, bimp,
        alt, frac, exp, snr5, score, source: p.source || "Confirmed",
      });
    }
  }
  const seen = new Map();
  for (const c of cands) if (!seen.has(c.name) || c.score > seen.get(c.name).score) seen.set(c.name, c);
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, nTop);
}

/** Simulated predicted light curves for ranked candidates (data only; see charts.js). */
export function buildTransitCurves(top, dw, skyMag, { binMin = 5, seed = 42, instrument = SEESTAR } = {}) {
  const disk = limbDarkenedDisk(160, 0.40, 0.27);
  const rng = makeRng(seed);
  return top.map((c) => {
    const { k, bimp, dur, vmag, exp } = c;
    const dn = Math.sqrt(Math.max(1e-9, (1 + k) ** 2 - bimp ** 2));
    const dn23 = Math.max(0, (1 - k) ** 2 - bimp ** 2);
    const t23h = dur * Math.sqrt(dn23) / dn;
    const obsH = dur + 1;
    const nF = Math.trunc(obsH * 3600 / exp) + 1;
    const tH = linspace(-obsH / 2, obsH / 2, nF);
    const tM = tH.map((x) => x * 60);
    const z = tH.map((x) => Math.sqrt(bimp ** 2 + (2 * x / dur * dn) ** 2));
    const model = transitFlux(z, k, disk);
    const sigma = 1 / snrFull(vmag, exp, skyMag, instrument);
    const obs = model.map((m) => m + rng.normal(0, sigma));
    const bins = binLightCurve(tM, obs, binMin, sigma);
    const contacts = [[-dur / 2 * 60, "T1"], [dur / 2 * 60, "T4"]];
    if (t23h > 0) contacts.push([-t23h / 2 * 60, "T2"], [t23h / 2 * 60, "T3"]);
    return {
      cand: c, tM, model, obs, sigma, bins, binMin, contacts,
      labelY: 1 - k * k * 1.6,
      dsMin: (dw.ds_jd - c.tmid_jd) * 1440,
      deMin: (dw.de_jd - c.tmid_jd) * 1440,
    };
  });
}
