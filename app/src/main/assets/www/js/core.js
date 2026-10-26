// Instrument model (optical tube + camera) and the pure photometry / SNR
// functions built on top of it. Port of seestar_core.py.
//
// The flux zero point is empirically calibrated for the Seestar S50 (a mag-5.25
// star saturates its 12-bit sensor in ~1 s) and scaled to other instruments by
// relative light-collecting power (aperture^2 x QE).

export function makeOTA(name, aperture_mm, focal_length_mm) {
  return { name, aperture_mm, focal_length_mm, f_ratio: focal_length_mm / aperture_mm };
}

export function makeCamera(o) {
  return { bit_depth: 16, ...o };
}

export function makeInstrument(ota, camera, photometric_aperture_radius_arcsec = 7.178015) {
  const pixel_scale_arcsec = (camera.pixel_size_um * 1e-3 / ota.focal_length_mm) * (180 / Math.PI * 3600);
  const aperture_radius_px = photometric_aperture_radius_arcsec / pixel_scale_arcsec;
  return {
    ota, camera, photometric_aperture_radius_arcsec,
    name: `${ota.name} + ${camera.name}`,
    pixel_scale_arcsec,
    aperture_radius_px,
    n_pix: Math.PI * aperture_radius_px ** 2,
  };
}

// ---- Seestar S50 / Sony IMX462: the reference instrument ----
export const SEESTAR_OTA = makeOTA("Seestar S50", 50.0, 250.0);
export const SEESTAR_CAMERA = makeCamera({
  name: "Sony IMX462", pixel_size_um: 2.9,
  full_well_e: 3855 * 1.5,   // SATURATION_ADU (12-bit) * GAIN_E_PER_ADU
  read_noise_e: 3.0, dark_current_e_s: 0.1, qe: 0.8, gain_e_per_adu: 1.5, bit_depth: 12,
});
export const SEESTAR = makeInstrument(SEESTAR_OTA, SEESTAR_CAMERA);

const SEESTAR_SAT_MAG_1S = 5.25;
const SEESTAR_FLUX_ZP_E_S = SEESTAR_CAMERA.full_well_e / 10 ** (-0.4 * SEESTAR_SAT_MAG_1S);

export function fluxZpES(inst = SEESTAR) {
  const powerRatio = (inst.ota.aperture_mm ** 2 * inst.camera.qe) /
                     (SEESTAR_OTA.aperture_mm ** 2 * SEESTAR_CAMERA.qe);
  return SEESTAR_FLUX_ZP_E_S * powerRatio;
}

export function starFlux(mag, inst = SEESTAR) {
  return fluxZpES(inst) * 10 ** (-0.4 * mag);
}

export function skyFluxPerPix(skyMag, inst = SEESTAR) {
  return fluxZpES(inst) * 10 ** (-0.4 * skyMag) * inst.pixel_scale_arcsec ** 2;
}

/** Maximum exposure (s) before a star reaches `safety` of full well (default 80%). */
export function calculateMaxExposure(mag, inst = SEESTAR, safety = 0.8) {
  return inst.camera.full_well_e * safety / starFlux(mag, inst);
}

/** Magnitude at which a star reaches `safety` of full well in a given exposure. */
export function calculateSaturationMagnitude(exposure_s, inst = SEESTAR, safety = 1.0) {
  const target = inst.camera.full_well_e * safety;
  return -2.5 * Math.log10(target / (fluxZpES(inst) * exposure_s));
}

export function transitDepthToMagnitude(depthFrac) {
  return -2.5 * Math.log10(1 - depthFrac);
}

export function magnitudeToTransitDepth(magChange) {
  return 1 - 10 ** (-magChange / 2.5);
}

/** Full aperture-photometry SNR including sky, dark and read noise. */
export function snrFull(mag, exposure_s, skyMag = 20.5, inst = SEESTAR) {
  const S = starFlux(mag, inst) * exposure_s;
  const B = skyFluxPerPix(skyMag, inst) * exposure_s;
  const D = inst.camera.dark_current_e_s * exposure_s;
  const noiseSq = S + inst.n_pix * (B + D + inst.camera.read_noise_e ** 2);
  return S / Math.sqrt(noiseSq);
}

// ---- small numeric helpers shared by the other modules ----
export function linspace(a, b, n) {
  const out = new Float64Array(n);
  if (n === 1) { out[0] = a; return out; }
  const step = (b - a) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = a + i * step;
  out[n - 1] = b;
  return out;
}

export function logspace(a, b, n) {
  return Array.from(linspace(a, b, n), (x) => 10 ** x);
}

/** numpy.arange(start, stop, step) */
export function arange(start, stop, step) {
  const n = Math.max(0, Math.ceil((stop - start) / step));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = start + i * step;
  return out;
}

/** numpy.interp (linear, clamped at the ends); xp must be increasing. */
export function interp(x, xp, fp) {
  const n = xp.length;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid; else hi = mid;
  }
  const t = (x - xp[lo]) / (xp[hi] - xp[lo]);
  return fp[lo] + t * (fp[hi] - fp[lo]);
}

/** Seeded normal-distribution generator (mulberry32 + Box-Muller). The noise
 * realisation differs from numpy's for the same seed, but is reproducible. */
export function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = (mu = 0, sigma = 1) => {
    if (spare !== null) { const s = spare; spare = null; return mu + sigma * s; }
    let u = 0, v = 0;
    while (u === 0) u = uniform();
    v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return mu + sigma * r * Math.cos(2 * Math.PI * v);
  };
  return { uniform, normal };
}

export const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
