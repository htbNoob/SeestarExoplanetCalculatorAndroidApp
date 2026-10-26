// Observer site, tonight's dark window, and the small amount of positional
// astronomy the app needs. Replaces seestar_site.py's astropy dependency with
// standard low-precision formulas (Meeus, "Astronomical Algorithms"):
//   - Sun position: ~0.01 deg, plenty for a -12 deg twilight scan on a 6-min grid
//   - Star alt/az: J2000 -> mean-of-date precession + GMST; < 1 arcmin vs astropy
//     (nutation/aberration ignored), no refraction - same as astropy's default AltAz.
// Times: "jdUtc" = Julian Date in UTC; "jd" (no suffix) = TDB, which is what the
// archive ephemerides (BJD_TDB) and the original code compare against.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
export const TDB_MINUS_UTC_DAYS = (37 + 32.184) / 86400;   // TAI-UTC = 37 s since 2017

export const jdUtcNow = () => Date.now() / 86400000 + 2440587.5;
export const utcToTdb = (jdUtc) => jdUtc + TDB_MINUS_UTC_DAYS;
export const tdbToUtc = (jd) => jd - TDB_MINUS_UTC_DAYS;
export const jdUtcToDate = (jdUtc) => new Date((jdUtc - 2440587.5) * 86400000);
export const dateToJdUtc = (d) => d.getTime() / 86400000 + 2440587.5;

const mod360 = (x) => ((x % 360) + 360) % 360;

/** Greenwich mean sidereal time (deg), Meeus eq. 12.4 (UT1 ~ UTC). */
export function gmstDeg(jdUtc) {
  const d = jdUtc - 2451545.0;
  const T = d / 36525;
  return mod360(280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - T * T * T / 38710000);
}

/** Local sidereal time (deg) for an east-positive longitude. */
export const lstDeg = (jdUtc, lonDeg) => mod360(gmstDeg(jdUtc) + lonDeg);

/** Apparent geocentric Sun RA/Dec (deg), low-precision (Astronomical Almanac). */
export function sunRaDec(jdUtc) {
  const n = utcToTdb(jdUtc) - 2451545.0;
  const L = mod360(280.460 + 0.9856474 * n);
  const g = mod360(357.528 + 0.9856003 * n) * D2R;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * R2D;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam)) * R2D;
  return { ra: mod360(ra), dec };
}

/** Altitude (deg) of an of-date RA/Dec for an observer at lat/lon (deg). */
export function altitudeDeg(raDeg, decDeg, jdUtc, latDeg, lonDeg) {
  const H = (lstDeg(jdUtc, lonDeg) - raDeg) * D2R;
  const phi = latDeg * D2R, dec = decDeg * D2R;
  const s = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  return Math.asin(Math.max(-1, Math.min(1, s))) * R2D;
}

/** Precess J2000 (ICRS) RA/Dec to the mean equator & equinox of `jd` (Meeus 21.3). */
export function precessFromJ2000(raDeg, decDeg, jd) {
  const T = (jd - 2451545.0) / 36525;
  const as = D2R / 3600;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * as;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * as;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * as;
  const a = raDeg * D2R, d = decDeg * D2R;
  const A = Math.cos(d) * Math.sin(a + zeta);
  const B = Math.cos(theta) * Math.cos(d) * Math.cos(a + zeta) - Math.sin(theta) * Math.sin(d);
  const C = Math.sin(theta) * Math.cos(d) * Math.cos(a + zeta) + Math.cos(theta) * Math.sin(d);
  return { ra: mod360((Math.atan2(A, B) + z) * R2D), dec: Math.asin(Math.max(-1, Math.min(1, C))) * R2D };
}

export function sunAltitudeDeg(jdUtc, site) {
  const s = sunRaDec(jdUtc);
  return altitudeDeg(s.ra, s.dec, jdUtc, site.lat, site.lon);
}

/**
 * Tonight's dark window (sun below `horizonDeg`), scanning `scanHours` ahead on a
 * 0.1 h grid - same algorithm as compute_dark_window() in seestar_site.py.
 */
export function computeDarkWindow(site, { horizonDeg = -12.0, scanHours = 36.0, nowJdUtc = jdUtcNow() } = {}) {
  const n = Math.ceil(scanHours / 0.1 - 1e-9);
  const t = new Array(n), dark = new Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    t[i] = nowJdUtc + (i * 0.1) / 24;
    dark[i] = sunAltitudeDeg(t[i], site) < horizonDeg;
    if (dark[i]) count++;
  }
  let startUtc, endUtc, placeholder;
  if (count > 2) {
    const idx0 = dark.indexOf(true);
    let idx1 = n - 1;
    for (let i = idx0; i < n; i++) { if (!dark[i]) { idx1 = i - 1; break; } }
    startUtc = t[idx0]; endUtc = t[idx1]; placeholder = false;
  } else {
    startUtc = nowJdUtc; endUtc = nowJdUtc + 8 / 24; placeholder = true;
  }
  return {
    site,
    darkStartUtc: startUtc, darkEndUtc: endUtc,
    ds_jd: utcToTdb(startUtc), de_jd: utcToTdb(endUtc),
    placeholder,
  };
}

/** Minimum altitude (deg) of a J2000 RA/Dec between two TDB JDs (n samples). */
export function minAltitudeDeg(raDeg, decDeg, t0Jd, t1Jd, site, n = 10) {
  const p = precessFromJ2000(raDeg, decDeg, (t0Jd + t1Jd) / 2);
  let mn = Infinity;
  for (let i = 0; i < n; i++) {
    const jd = n === 1 ? t0Jd : t0Jd + (i * (t1Jd - t0Jd)) / (n - 1);
    mn = Math.min(mn, altitudeDeg(p.ra, p.dec, tdbToUtc(jd), site.lat, site.lon));
  }
  return mn;
}

// ---- time formatting ----
export function isValidTz(tz) {
  if (!tz || typeof tz !== "string") return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** "YYYY-MM-DD HH:MM" in UTC (truncated, like astropy's .iso[:16]). */
export function utcIso16(jdUtc) {
  return jdUtcToDate(jdUtc).toISOString().slice(0, 16).replace("T", " ");
}

/** "YYYY-MM-DD HH:MM" in an IANA zone; falls back to UTC + " UTC". */
export function localIso(jdUtc, tz) {
  if (!isValidTz(tz)) return utcIso16(jdUtc) + " UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(jdUtcToDate(jdUtc));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

/** Short local time "HH:MM" in an IANA zone (UTC if invalid). */
export function localHHMM(jdUtc, tz) {
  return localIso(jdUtc, tz).slice(11, 16);
}
