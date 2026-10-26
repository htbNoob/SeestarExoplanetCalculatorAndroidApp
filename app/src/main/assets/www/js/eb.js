// AAVSO VSX query + curated compact-object list, ranking of tonight's
// observable eclipses, and trapezoidal eclipse curves. Port of seestar_eb.py.
import { SEESTAR, calculateMaxExposure, linspace, makeRng, snrFull } from "./core.js";
import { binLightCurve } from "./lightcurve.js";
import { lstDeg, minAltitudeDeg, tdbToUtc } from "./site.js";
import { buildUrl, httpGet } from "./http.js";
import { pyFloat } from "./transits.js";

export const VSX_URL = "https://www.aavso.org/vsx/index.php";

// name, RA(deg), Dec(deg), V_mag, period(d), epoch(JD),
// depth_primary(mag), dur_frac (eclipse duration / period), type_label
export const COMPACT_SYSTEMS = [
  // White dwarf + main-sequence eclipsing (WD+MS)
  ["V471 Tau",      52.6858,  17.2441,  9.4, 0.5212, 2448612.4638, 0.55, 0.05, "WD+MS"],
  ["HW Vir",       186.5917,  -7.5175, 10.8, 0.1167, 2446929.0977, 1.10, 0.07, "sdB+MS"],
  ["HS 0705+6700", 107.2792,  66.9028, 14.7, 0.0957, 2451822.7406, 0.55, 0.06, "sdB+MS"],
  ["IK Peg",       327.3671,  19.1487,  6.1, 21.722, 2450259.0960, 0.15, 0.008, "WD+MS"],
  ["NN Ser",       148.1885,  12.7321, 16.5, 0.1301, 2447344.6230, 0.92, 0.02, "WD+MS"],
  // Neutron star X-ray binary
  ["HZ Her",       254.4575,  35.3422, 13.5, 1.7001, 2440946.4260, 1.50, 0.14, "NS+MS"],
  ["V1341 Cyg",    326.1713,  38.3214, 14.7, 9.8444, 2440788.2000, 0.30, 0.05, "NS+MS"],
  // Black-hole X-ray binaries
  ["HDE 226868",   299.5904,  35.2016,  8.9, 5.5999, 2441163.5290, 0.08, 0.10, "BH+OB"],
  ["KV UMa",       169.5454,  48.0367, 18.8, 0.1699, 2451773.3800, 0.05, 0.10, "BH+MS"],
  ["V1033 Sco",    253.4863, -39.8458, 17.0, 2.6217, 2449838.8000, 0.20, 0.06, "BH+MS"],
];

const MAG_RE = /^\(?(-?\d+\.?\d*)\)?\s*([A-Za-z]*)/;

/** '9.94 V' -> [9.94, 'V'];  '(0.54) CV' -> [0.54, 'CV']. */
export function parseMag(s) {
  const m = MAG_RE.exec((s || "").trim());
  if (!m) return [null, null];
  const v = Number(m[1]);
  return Number.isFinite(v) ? [v, m[2]] : [null, null];
}

export function isEclipsingType(vtype) {
  return (vtype || "").split(/[/|+:]/).some((t) => t.startsWith("EA") || t.startsWith("EB") || t.startsWith("EW"));
}

/** RA/Dec/radius (deg) of the cone centred on zenith at mid dark window. */
export function vsxConeForSite(dw, minAltEb) {
  const mid = (dw.ds_jd + dw.de_jd) / 2;
  const ra = lstDeg(tdbToUtc(mid), dw.site.lon) % 360;
  const dec = dw.site.lat;
  const radius = Math.max(5, Math.min(90, 90 - minAltEb));
  return { ra, dec, radius };
}

function childText(el, tag, def) {
  for (const c of el.children) if (c.tagName === tag) return c.textContent ?? "";
  return def;
}

/** Parse a VSX api.list XML document into eclipsing-type rows; null if unparsable. */
export function parseVsxXml(xmlText, bright, faint) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length || !doc.documentElement) return null;
  const rows = [];
  for (const obj of doc.documentElement.children) {
    if (obj.tagName !== "VSXObject") continue;
    const vtype = childText(obj, "VariabilityType", "");
    if (!isEclipsingType(vtype)) continue;
    const ra = pyFloat(childText(obj, "RA2000", "nan"));
    const dec = pyFloat(childText(obj, "Declination2000", "nan"));
    const per = pyFloat(childText(obj, "Period", "nan"));
    const ep = pyFloat(childText(obj, "Epoch", "nan"));
    if ([ra, dec, per, ep].some(Number.isNaN)) continue;
    const [maxmag, band1] = parseMag(childText(obj, "MaxMag", ""));
    const [minmag, band2] = parseMag(childText(obj, "MinMag", ""));
    if (maxmag === null || minmag === null || band1 !== band2) continue;
    const amp = minmag - maxmag;
    if (![ra, dec, per, ep, maxmag, amp].every(Number.isFinite)) continue;
    if (per <= 0 || amp < 0) continue;
    if (maxmag < bright || maxmag > faint) continue;
    let durFrac = pyFloat(childText(obj, "EclipseDuration", "")) / 100;
    if (!(durFrac > 0 && durFrac < 1)) durFrac = 0.08;
    rows.push([childText(obj, "Name", "?"), ra, dec, maxmag, per, ep, amp, durFrac, vtype]);
  }
  return rows;
}

/**
 * Query VSX for eclipsing variables in a cone. VSX has no server-side
 * type/mag filtering and dense fields can time out above ~45-50 deg, so the
 * radius shrinks by 30% per failure (down to 12 deg).
 * Returns { rows, usedRadius } (usedRadius null if every attempt failed).
 */
export async function queryVsx(ra, dec, radius, bright, faint, { timeoutMs = 150000, onAttempt } = {}) {
  let r = radius;
  while (r >= 12) {
    onAttempt && onAttempt(r);
    try {
      const resp = await httpGet(buildUrl(VSX_URL, { view: "api.list", ra, dec, radius: r }), timeoutMs);
      if (resp.ok) {
        const rows = parseVsxXml(resp.text, bright, faint);
        if (rows !== null) return { rows, usedRadius: r };
      }
    } catch { /* fall through to retry */ }
    r *= 0.7;
  }
  return { rows: [], usedRadius: null };
}

export function eclipsesTonight(t0, per, durFrac, w0, w1) {
  const hd = per * durFrac / 2;
  const n0 = Math.floor((w0 - hd - t0) / per);
  const n1 = Math.ceil((w1 + hd - t0) / per);
  const out = [];
  for (let n = n0; n <= n1; n++) {
    const m = t0 + n * per;
    if (m + hd >= w0 && m - hd <= w1) out.push(m);
  }
  return out;
}

export function findTonightEclipses(vsxRows, dw, o) {
  const { bright, faint, minDepth, maxPeriod, minDurH, maxDurH, minAlt, skyMag,
    nTop = 10, includeCompact = true, instrument = SEESTAR } = o;
  const { ds_jd, de_jd, site } = dw;
  const all = includeCompact ? [...vsxRows, ...COMPACT_SYSTEMS] : [...vsxRows];
  const cands = [];
  for (const [name, ra, dec, vmag, per, ep, depthMag, durFrac, label] of all) {
    if (![ra, dec, vmag, per, ep, depthMag].every(Number.isFinite)) continue;
    if (vmag < bright || vmag > faint) continue;
    if (per > maxPeriod || depthMag < minDepth) continue;
    const durH = per * durFrac * 24;
    if (!(minDurH <= durH && durH <= maxDurH)) continue;
    for (const mid of eclipsesTonight(ep, per, durFrac, ds_jd, de_jd)) {
      const t1 = mid - per * durFrac / 2, t4 = mid + per * durFrac / 2;
      const ot0 = Math.max(t1, ds_jd), ot1 = Math.min(t4, de_jd);
      if (ot1 <= ot0) continue;
      const alt = minAltitudeDeg(ra, dec, ot0, ot1, site);
      if (alt < minAlt) continue;
      const frac = (ot1 - ot0) / (t4 - t1);
      const exp = Math.max(1, Math.min(calculateMaxExposure(vmag, instrument) * 0.8, 60));
      const snr5 = snrFull(vmag, exp, skyMag, instrument) * Math.sqrt(300 / exp);
      const depFrac = 1 - 10 ** (-0.4 * depthMag);
      const score = depFrac * Math.min(snr5, 1000) / 100 * frac * Math.sin(alt * Math.PI / 180);
      cands.push({
        name, label, vmag, ra, dec, tmid_jd: mid, t1_jd: t1, t4_jd: t4,
        dur_h: durH, per, depth_mag: depthMag, dep_frac: depFrac,
        alt, frac, exp, snr5, score,
      });
    }
  }
  const seen = new Map();
  for (const c of cands) if (!seen.has(c.name) || c.score > seen.get(c.name).score) seen.set(c.name, c);
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, nTop);
}

/** Trapezoidal eclipse model centred at t = 0 (hours). */
export function trapModel(tH, halfDur, dep, ing) {
  const flat = halfDur - ing;
  return tH.map((t) => {
    const at = Math.abs(t);
    if (at <= flat) return 1 - dep;
    if (at <= flat + ing) return 1 - dep * (1 - (at - flat) / ing);
    return 1;
  });
}

export function buildEclipseCurves(top, dw, skyMag, { binMin = 0.5, seed = 42, instrument = SEESTAR } = {}) {
  const rng = makeRng(seed);
  return top.map((c) => {
    const { dur_h: durH, exp, vmag, dep_frac: dep } = c;
    const half = durH / 2, ing = half * 0.15;
    const obsH = durH + 1;
    const nF = Math.trunc(obsH * 3600 / exp) + 1;
    const tH = linspace(-obsH / 2, obsH / 2, nF);
    const tM = tH.map((x) => x * 60);
    const model = trapModel(tH, half, dep, ing);
    const sigma = 1 / snrFull(vmag, exp, skyMag, instrument);
    const obs = model.map((m) => m + rng.normal(0, sigma));
    const bins = binLightCurve(tM, obs, binMin, sigma);
    const flatM = (half - ing) * 60, totM = half * 60;
    return {
      cand: c, tM, model, obs, sigma, bins, binMin,
      contacts: [[-totM, "I"], [-flatM, "II"], [flatM, "III"], [totM, "IV"]],
      labelY: 1 - dep * 1.6,
      dsMin: (dw.ds_jd - c.tmid_jd) * 1440,
      deMin: (dw.de_jd - c.tmid_jd) * 1440,
    };
  });
}
