// Plotly chart builders - the mobile equivalents of the matplotlib figures in
// seestar_snr.py, seestar_lightcurve.py, seestar_transits.py, seestar_eb.py and
// seestar_weather.py. Charts render static (so the page scrolls freely on a
// phone); the "Zoom" button on each card switches that chart to interactive.
import {
  calculateMaxExposure, calculateSaturationMagnitude, linspace, logspace, snrFull,
} from "./core.js";

const Plotly = () => window.Plotly;

const C = {
  text: "#c9d3e6", muted: "#8b98b4", grid: "rgba(160,180,220,0.12)",
  model: "#ff5d5d", bins: "#5ec8e5", frames: "rgba(170,180,200,0.35)",
  contact: "#ff8a70", shade: "rgba(255,255,255,0.06)", dark: "rgba(94,200,229,0.13)",
};

// Colormap anchors (matplotlib viridis / plasma), sampled & linearly interpolated.
const VIRIDIS = ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"];
const PLASMA = ["#0d0887", "#46039f", "#7201a8", "#9c179e", "#bd3786", "#d8576b", "#ed7953", "#fb9f3a", "#fdca26", "#f0f921"];
function cmap(stops, x) {
  const t = Math.min(1, Math.max(0, x)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
  const a = stops[i], b = stops[i + 1];
  const ch = (h, o) => parseInt(h.slice(o, o + 2), 16);
  const mix = (o) => Math.round(ch(a, o) + f * (ch(b, o) - ch(a, o)));
  return `rgb(${mix(1)},${mix(3)},${mix(5)})`;
}
// Ranges shifted toward the bright end so every line is visible on a dark background.
const seqColors = (stops, n, lo, hi) => Array.from({ length: n }, (_, i) => cmap(stops, n === 1 ? (lo + hi) / 2 : lo + (hi - lo) * i / (n - 1)));

function axis(extra = {}) {
  return { gridcolor: C.grid, zerolinecolor: C.grid, linecolor: C.grid, tickfont: { size: 10.5 },
    title: { font: { size: 11.5 } }, automargin: true, ...extra };
}
function baseLayout(extra = {}) {
  return {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: C.text, size: 11, family: "system-ui, Roboto, sans-serif" },
    margin: { l: 52, r: 10, t: 10, b: 40 },
    showlegend: true,
    legend: { orientation: "h", x: 0, y: -0.22, yanchor: "top", font: { size: 10.5 }, bgcolor: "rgba(0,0,0,0)" },
    hovermode: "closest",
    ...extra,
  };
}

/**
 * Append a chart card to `container`: { title, subtitle, height, traces, layout }.
 * Static by default; the Zoom button toggles interactive pan/zoom.
 */
export function chartCard(container, { title, subtitle = "", height = 300, traces, layout, id }) {
  const card = document.createElement("div");
  card.className = "chart-card";
  if (id) card.id = id;
  const head = document.createElement("div");
  head.className = "chart-head";
  head.innerHTML = `<div><h3></h3><p></p></div><div class="chart-tools"><button type="button" data-act="zoom">Zoom</button></div>`;
  head.querySelector("h3").textContent = title;
  head.querySelector("p").textContent = subtitle;
  if (!subtitle) head.querySelector("p").remove();
  const div = document.createElement("div");
  div.className = "chart";
  div.style.height = height + "px";
  card.append(head, div);
  container.append(card);

  let interactive = false;
  const draw = () => {
    const cfg = interactive
      ? { responsive: true, displaylogo: false, scrollZoom: true, displayModeBar: true,
          modeBarButtonsToRemove: ["toImage", "lasso2d", "select2d", "autoScale2d"] }
      : { responsive: true, staticPlot: true };
    const lay = { ...layout, dragmode: interactive ? "zoom" : false };
    Plotly().react(div, traces, lay, cfg);
  };
  head.querySelector('[data-act="zoom"]').addEventListener("click", (e) => {
    interactive = !interactive;
    e.currentTarget.classList.toggle("on", interactive);
    e.currentTarget.textContent = interactive ? "Done" : "Zoom";
    Plotly().purge(div);
    draw();
  });
  draw();
  return card;
}

/** Keep at most `maxPts` single-frame points for display (binned values use all frames). */
function thin(x, y, maxPts = 2500) {
  if (x.length <= maxPts) return { x: Array.from(x), y: Array.from(y), step: 1 };
  const step = Math.ceil(x.length / maxPts), xs = [], ys = [];
  for (let i = 0; i < x.length; i += step) { xs.push(x[i]); ys.push(y[i]); }
  return { x: xs, y: ys, step };
}
const finite = (a) => Array.from(a, (v) => (Number.isFinite(v) ? v : null));

// =============================================================================
// SNR overview (3 panels -> 3 stacked charts)
// =============================================================================
const BORTLE = [[17.0, "Bortle 9"], [18.5, "Bortle 7"], [20.5, "Bortle 4-5"], [21.7, "Bortle 1-2"]];

export function renderSnrOverview(container, { refSky, starMags, expTimes, expFixed, instrument }) {
  container.innerHTML = "";
  const magColors = seqColors(PLASMA, starMags.length, 0.98, 0.35);
  const expColors = seqColors(VIRIDIS, expTimes.length, 0.25, 1.0);
  const ref100 = (x0, x1) => ({ x: [x0, x1], y: [100, 100], mode: "lines", name: "SNR = 100",
    line: { color: C.muted, dash: "dash", width: 1 }, hoverinfo: "skip" });

  // Panel 1: SNR vs exposure time
  const tArr = logspace(-1, 3, 300);
  const tr1 = [], shapes1 = [];
  starMags.forEach((mag, i) => {
    const sat = calculateMaxExposure(mag, instrument);
    const x = [], y = [];
    for (const t of tArr) if (t <= sat) { x.push(t); y.push(snrFull(mag, t, refSky, instrument)); }
    tr1.push({ x, y, mode: "lines", name: `mag ${mag}`, line: { color: magColors[i], width: 2 },
      hovertemplate: `mag ${mag}<br>%{x:.3g} s → SNR %{y:.3g}<extra></extra>` });
    if (sat < 1000) shapes1.push({ type: "line", xref: "x", yref: "paper", x0: sat, x1: sat, y0: 0, y1: 1,
      line: { color: magColors[i], width: 1, dash: "dot" }, opacity: 0.6 });
  });
  tr1.push(ref100(0.1, 1000));
  chartCard(container, {
    title: "SNR vs exposure time", subtitle: `sky = ${refSky.toFixed(1)} mag/arcsec² · dotted = 80% full well`,
    height: 330, traces: tr1,
    layout: baseLayout({ shapes: shapes1,
      xaxis: axis({ type: "log", title: { text: "Exposure time (s)" }, range: [-1, 3] }),
      yaxis: axis({ type: "log", title: { text: "SNR" } }) }),
  });

  // Panel 2: SNR vs magnitude
  const magArr = linspace(5, 16, 300);
  const tr2 = expTimes.map((exp, i) => {
    const lim = calculateSaturationMagnitude(exp, instrument);
    const x = [], y = [];
    for (const m of magArr) if (m >= lim) { x.push(m); y.push(snrFull(m, exp, refSky, instrument)); }
    return { x, y, mode: "lines", name: `${exp} s`, line: { color: expColors[i], width: 2 },
      hovertemplate: `${exp} s<br>mag %{x:.2f} → SNR %{y:.3g}<extra></extra>` };
  });
  tr2.push(ref100(5, 16));
  chartCard(container, {
    title: "SNR vs star magnitude", subtitle: `sky = ${refSky.toFixed(1)} mag/arcsec²`,
    height: 330, traces: tr2,
    layout: baseLayout({ xaxis: axis({ title: { text: "Star magnitude (Vega)" }, range: [5, 16] }),
      yaxis: axis({ type: "log", title: { text: "SNR" } }) }),
  });

  // Panel 3: SNR vs sky background
  const skyArr = linspace(16, 22, 200);
  const tr3 = starMags.map((mag, i) => ({
    x: Array.from(skyArr), y: Array.from(skyArr, (s) => snrFull(mag, expFixed, s, instrument)),
    mode: "lines", name: `mag ${mag}`, line: { color: magColors[i], width: 2 },
    hovertemplate: `mag ${mag}<br>sky %{x:.2f} → SNR %{y:.3g}<extra></extra>` }));
  tr3.push(ref100(16, 22));
  chartCard(container, {
    title: "SNR vs sky background", subtitle: `t = ${expFixed.toFixed(0)} s · darker sky →`,
    height: 330, traces: tr3,
    layout: baseLayout({
      shapes: BORTLE.map(([x]) => ({ type: "line", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1,
        line: { color: "rgba(200,210,230,0.25)", width: 1, dash: "dot" } })),
      annotations: BORTLE.map(([x, t]) => ({ x, y: 0.02, xref: "x", yref: "paper", text: t, showarrow: false,
        textangle: -90, xanchor: "left", yanchor: "bottom", font: { size: 9, color: C.muted } })),
      xaxis: axis({ title: { text: "Sky brightness (mag/arcsec²)" }, range: [16, 22] }),
      yaxis: axis({ type: "log", title: { text: "SNR" } }) }),
  });
}

// =============================================================================
// Light curve simulator
// =============================================================================
export function renderLightCurve(container, r) {
  const p = r.params;
  const fr = thin(r.tM, r.obs);
  const frNote = fr.step > 1 ? ` (every ${fr.step}th shown)` : "";
  const binsX = Array.from(r.bins.centers);
  const contacts = [[-r.t14_h / 2 * 60, "T1"], [-r.t23_h / 2 * 60, "T2"], [r.t23_h / 2 * 60, "T3"], [r.t14_h / 2 * 60, "T4"]];
  const yLabel = 1 - r.depth * 1.7;
  const resid = thin(r.tM, r.residRaw);
  const s1 = r.sigma * 1e3;
  const x0 = r.tM[0], x1 = r.tM[r.tM.length - 1];

  const traces = [
    { x: fr.x, y: fr.y, mode: "markers", name: "Single frames" + frNote, marker: { size: 2.5, color: C.frames },
      hoverinfo: "skip" },
    { x: binsX, y: finite(r.bins.flux), mode: "markers", name: `${fmtNum(p.bin_min)}-min bins`,
      marker: { size: 6, color: C.bins }, error_y: { type: "data", array: finite(r.bins.err), color: C.bins, thickness: 1.2, width: 3 },
      hovertemplate: "%{x:.1f} min<br>flux %{y:.5f}<extra></extra>" },
    { x: Array.from(r.tM), y: Array.from(r.model), mode: "lines", name: "Model (noiseless)", line: { color: C.model, width: 2 },
      hoverinfo: "skip" },
    { x: resid.x, y: resid.y, xaxis: "x", yaxis: "y2", mode: "markers", showlegend: false,
      marker: { size: 2.5, color: C.frames }, hoverinfo: "skip" },
    { x: binsX, y: finite(r.residBin), xaxis: "x", yaxis: "y2", mode: "markers", showlegend: false,
      marker: { size: 5, color: C.bins }, error_y: { type: "data", array: finite(r.bins.err.map((e) => e * 1e3)), color: C.bins, thickness: 1, width: 2 },
      hovertemplate: "%{x:.1f} min<br>%{y:.2f} mmag<extra></extra>" },
  ];
  const shapes = contacts.map(([x]) => ({ type: "line", xref: "x", yref: "y domain", x0: x, x1: x, y0: 0, y1: 1,
    line: { color: C.contact, width: 1, dash: "dash" }, opacity: 0.7 }));
  shapes.push(
    { type: "line", xref: "x", yref: "y2", x0, x1, y0: 0, y1: 0, line: { color: C.model, width: 1.5 } },
    { type: "line", xref: "x", yref: "y2", x0, x1, y0: s1, y1: s1, line: { color: C.bins, width: 1, dash: "dash" }, opacity: 0.6 },
    { type: "line", xref: "x", yref: "y2", x0, x1, y0: -s1, y1: -s1, line: { color: C.bins, width: 1, dash: "dash" }, opacity: 0.6 },
  );
  chartCard(container, {
    title: "Transit light curve",
    subtitle: `${r.instrument.name} · mag ${p.star_mag}, K = ${p.k.toFixed(3)} (${(r.depth * 100).toFixed(2)}%), b = ${p.b_imp}, T14 = ${p.t14_h.toFixed(1)} h, t_exp = ${p.exposure_s.toFixed(0)} s, sky = ${p.sky_mag}`,
    height: 470,
    traces,
    layout: baseLayout({
      shapes,
      annotations: contacts.map(([x, t]) => ({ x, y: yLabel, xref: "x", yref: "y", text: t, showarrow: false,
        yanchor: "top", font: { size: 10, color: C.contact } })),
      xaxis: axis({ anchor: "y2", range: [x0, x1], title: { text: "Time from mid-transit (min)" } }),
      yaxis: axis({ domain: [0.34, 1], title: { text: "Relative flux" } }),
      yaxis2: axis({ domain: [0, 0.26], title: { text: "Resid. (mmag)" } }),
      legend: { orientation: "h", x: 0, y: -0.16, yanchor: "top", font: { size: 10.5 } },
      margin: { l: 58, r: 10, t: 10, b: 40 },
    }),
  });
  const note = document.createElement("p");
  note.className = "caption";
  note.style.margin = "-6px 4px 12px";
  note.textContent = `Residuals: OOT RMS = ${fmtNum(r.rms_oot, 2)} mmag (expected 1σ = ${s1.toFixed(2)} mmag per frame)`;
  container.append(note);

  // Limb-darkened disk with the planet's path
  const { disk } = r;
  const z = [];
  for (let j = 0; j < disk.ng; j++) z.push(Array.from(disk.I.subarray(j * disk.ng, (j + 1) * disk.ng)));
  const d = r.denom, k = p.k, b = p.b_imp;
  const circ = (cx, cy, rad, extra) => ({ type: "circle", xref: "x", yref: "y", x0: cx - rad, x1: cx + rad, y0: cy - rad, y1: cy + rad, ...extra });
  chartCard(container, {
    title: "Limb-darkened disk", subtitle: `u1 = ${p.u1}, u2 = ${p.u2} · planet K = ${p.k}`,
    height: 340,
    traces: [
      { type: "heatmap", z, x0: -1, dx: 2 / (disk.ng - 1), y0: -1, dy: 2 / (disk.ng - 1), zmin: 0, showscale: false,
        colorscale: [[0, "#000000"], [0.25, "#800000"], [0.5, "#ff8000"], [0.75, "#ffff80"], [1, "#ffffff"]],
        hoverinfo: "skip", zsmooth: "best" },
      { x: [-d, d], y: [b, b], mode: "lines", name: "Planet path", line: { color: "rgba(255,255,255,0.75)", dash: "dash", width: 1.2 } },
    ],
    layout: baseLayout({
      shapes: [
        circ(0, 0, 1, { line: { color: "rgba(255,255,255,0.35)", width: 1 } }),
        circ(0, b, k, { fillcolor: "rgba(0,191,255,0.65)", line: { color: "rgba(0,191,255,0.9)", width: 1.5 } }),
        circ(-d, b, k, { line: { color: "rgba(0,191,255,0.45)", width: 1, dash: "dash" } }),
        circ(d, b, k, { line: { color: "rgba(0,191,255,0.45)", width: 1, dash: "dash" } }),
      ],
      xaxis: axis({ range: [-1.3, 1.3], title: { text: "x / R*" }, constrain: "domain", showgrid: false, zeroline: false }),
      yaxis: axis({ range: [-1.3, 1.3], title: { text: "y / R*" }, scaleanchor: "x", scaleratio: 1, showgrid: false, zeroline: false }),
      legend: { orientation: "h", x: 0, y: -0.2, yanchor: "top", font: { size: 10.5 } },
    }),
  });
}

// =============================================================================
// Predicted transits / eclipses tonight (one chart per candidate)
// =============================================================================
export function renderCandidateCurve(container, cd, { title, subtitle, id, xLabel, modelName }) {
  const fr = thin(cd.tM, cd.obs);
  const x0 = cd.tM[0], x1 = cd.tM[cd.tM.length - 1];
  const shapes = [];
  let shadeLegend = false;
  for (const [lo, hi] of [[x0, Math.min(x1, cd.dsMin)], [Math.max(x0, cd.deMin), x1]]) {
    if (hi > lo) { shapes.push({ type: "rect", xref: "x", yref: "paper", x0: lo, x1: hi, y0: 0, y1: 1, fillcolor: C.shade, line: { width: 0 }, layer: "below" }); shadeLegend = true; }
  }
  for (const [x] of cd.contacts) shapes.push({ type: "line", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1,
    line: { color: C.contact, width: 1, dash: "dash" }, opacity: 0.6 });
  const traces = [
    { x: fr.x, y: fr.y, mode: "markers", name: fr.step > 1 ? `Frames (every ${fr.step}th)` : "Frames",
      marker: { size: 2.5, color: C.frames }, hoverinfo: "skip", showlegend: false },
    { x: Array.from(cd.bins.centers), y: finite(cd.bins.flux), mode: "markers", name: `${fmtNum(cd.binMin)}-min bins`,
      marker: { size: 5, color: C.bins }, error_y: { type: "data", array: finite(cd.bins.err), color: C.bins, thickness: 1, width: 2 },
      hovertemplate: "%{x:.1f} min<br>flux %{y:.4f}<extra></extra>" },
    { x: Array.from(cd.tM), y: Array.from(cd.model), mode: "lines", name: modelName, line: { color: C.model, width: 2 }, hoverinfo: "skip" },
  ];
  if (shadeLegend) traces.push({ x: [null], y: [null], mode: "markers", name: "Twilight / day",
    marker: { symbol: "square", size: 11, color: "rgba(255,255,255,0.18)" } });
  return chartCard(container, {
    id, title, subtitle, height: 290, traces,
    layout: baseLayout({
      shapes,
      annotations: cd.contacts.map(([x, t]) => ({ x, y: cd.labelY, xref: "x", yref: "y", text: t, showarrow: false,
        yanchor: "top", font: { size: 9.5, color: C.contact } })),
      xaxis: axis({ range: [x0, x1], title: { text: xLabel } }),
      yaxis: axis({ title: { text: "Rel. flux" } }),
      legend: { orientation: "h", x: 0, y: -0.3, yanchor: "top", font: { size: 10 } },
    }),
  });
}

// =============================================================================
// Weather forecast
// =============================================================================
export function renderWeather(container, fc, dw, toLabel) {
  const x = fc.time_utc.map((t) => t.replace("T", " "));
  const ds = toLabel(dw.darkStartUtc), de = toLabel(dw.darkEndUtc);
  const shade = (yref) => ({ type: "rect", xref: "x", yref, x0: ds, x1: de, y0: 0, y1: 1, fillcolor: C.dark, line: { width: 0 }, layer: "below" });
  chartCard(container, {
    title: `Forecast – ${dw.site.name}`, subtitle: "Times in UTC · shaded = tonight's dark window",
    height: 420,
    traces: [
      { x, y: finite(fc.cloudcover), mode: "lines", name: "Cloud cover (%)", line: { color: "#7fb3e6", width: 2 } },
      { x, y: finite(fc.precip_prob), mode: "lines", name: "Precip. prob. (%)", line: { color: "#ff7a6b", width: 1.5, dash: "dash" } },
      { x, y: finite(fc.temperature_c), xaxis: "x", yaxis: "y2", mode: "lines", name: "Temperature (°C)", line: { color: "#ffa646", width: 2 } },
      { x, y: finite(fc.dewpoint_c), xaxis: "x", yaxis: "y2", mode: "lines", name: "Dew point (°C)", line: { color: "#3cc7b0", width: 1.5, dash: "dash" } },
      { x: [null], y: [null], mode: "markers", name: "Dark window", marker: { symbol: "square", size: 11, color: "rgba(94,200,229,0.35)" } },
    ],
    layout: baseLayout({
      shapes: [shade("y domain"), shade("y2 domain")],
      xaxis: axis({ type: "date", anchor: "y2", tickformat: "%b %d\n%H:%M" }),
      yaxis: axis({ domain: [0.56, 1], range: [0, 100], title: { text: "%" } }),
      yaxis2: axis({ domain: [0, 0.44], title: { text: "°C" } }),
      legend: { orientation: "h", x: 0, y: -0.18, yanchor: "top", font: { size: 10.5 } },
      hovermode: "x unified",
    }),
  });
}

export function fmtNum(v, digits) {
  if (!Number.isFinite(v)) return "nan";
  if (digits !== undefined) return v.toFixed(digits);
  return String(Math.round(v * 1000) / 1000);
}
