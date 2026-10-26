// Limb-darkened transit model + single-target simulator. Port of
// seestar_lightcurve.py (the plotting lives in charts.js).
import {
  SEESTAR, arange, calculateMaxExposure, interp, linspace, makeRng, snrFull, transitDepthToMagnitude,
} from "./core.js";

/** Quadratic limb-darkened disk on an ng x ng grid spanning [-1, 1]^2. */
export function limbDarkenedDisk(ng, u1, u2) {
  const xg = linspace(-1, 1, ng);
  const I = new Float64Array(ng * ng);
  let total = 0;
  for (let j = 0; j < ng; j++) {
    for (let i = 0; i < ng; i++) {
      const r2 = xg[i] * xg[i] + xg[j] * xg[j];
      if (Math.sqrt(r2) <= 1) {
        const mu = Math.sqrt(Math.max(0, 1 - r2));
        const v = 1 - u1 * (1 - mu) - u2 * (1 - mu) ** 2;
        I[j * ng + i] = v;
        total += v;
      }
    }
  }
  return { ng, xg, I, total };
}

/** Relative flux for planet/star separations z (in stellar radii), radius ratio k.
 * Same pixel-sum as the numpy version, restricted to the planet's bounding box. */
export function transitFlux(zArr, k, disk) {
  const { ng, xg, I, total } = disk;
  const k2 = k * k;
  const toIdx = (x) => ((x + 1) * (ng - 1)) / 2;
  const j0 = Math.max(0, Math.floor(toIdx(-k)) - 1), j1 = Math.min(ng - 1, Math.ceil(toIdx(k)) + 1);
  const out = new Float64Array(zArr.length);
  for (let n = 0; n < zArr.length; n++) {
    const z = zArr[n];
    if (z >= 1 + k) { out[n] = 1; continue; }
    const i0 = Math.max(0, Math.floor(toIdx(z - k)) - 1), i1 = Math.min(ng - 1, Math.ceil(toIdx(z + k)) + 1);
    let blk = 0;
    for (let j = j0; j <= j1; j++) {
      const y2 = xg[j] * xg[j];
      const row = j * ng;
      for (let i = i0; i <= i1; i++) {
        const dx = xg[i] - z;
        if (dx * dx + y2 <= k2) blk += I[row + i];
      }
    }
    out[n] = 1 - blk / total;
  }
  return out;
}

/** Bin (t, flux) into fixed-width bins (numpy.arange edges); empty bins -> NaN. */
export function binLightCurve(tM, flux, binMin, sigma) {
  const edges = arange(tM[0], tM[tM.length - 1] + binMin, binMin);
  const nb = Math.max(0, edges.length - 1);
  const centers = new Float64Array(nb), bf = new Float64Array(nb), be = new Float64Array(nb);
  const sum = new Float64Array(nb), cnt = new Int32Array(nb);
  for (let i = 0; i < tM.length; i++) {
    // same half-open [lo, hi) assignment as the numpy loop
    let b = Math.floor((tM[i] - edges[0]) / binMin);
    if (b >= 0 && b < nb && tM[i] < edges[b]) b--;
    if (b >= 0 && b < nb && tM[i] >= edges[b + 1]) b++;
    if (b < 0 || b >= nb) continue;
    sum[b] += flux[i]; cnt[b]++;
  }
  for (let b = 0; b < nb; b++) {
    centers[b] = (edges[b] + edges[b + 1]) / 2;
    bf[b] = cnt[b] ? sum[b] / cnt[b] : NaN;
    be[b] = cnt[b] ? sigma / Math.sqrt(cnt[b]) : NaN;
  }
  return { centers, flux: bf, err: be };
}

export function simulateTransit({ star_mag, k, b_imp, t14_h, u1, u2, exposure_s, sky_mag,
  obs_hours, bin_min, seed = 42, instrument = SEESTAR }) {
  const depth = k * k;
  const denom = Math.sqrt((1 + k) ** 2 - b_imp ** 2);
  const t23_h = t14_h * Math.sqrt(Math.max(0, (1 - k) ** 2 - b_imp ** 2)) / denom;
  const ingress_m = (t14_h - t23_h) / 2 * 60;

  const snr_frame = snrFull(star_mag, exposure_s, sky_mag, instrument);
  const sigma = 1 / snr_frame;
  const depth_mmag = transitDepthToMagnitude(depth) * 1000;

  const n_in = Math.trunc(t14_h * 3600 / exposure_s);
  const n_bin_in = Math.max(1, Math.trunc(t14_h * 60 / bin_min));
  const binned_sigma_mmag = sigma / Math.sqrt(Math.max(n_in, 1) / n_bin_in) * 1e3;

  const disk = limbDarkenedDisk(200, u1, u2);

  const n_frames = Math.trunc(obs_hours * 3600 / exposure_s) + 1;
  const tH = linspace(-obs_hours / 2, obs_hours / 2, n_frames);
  const tM = tH.map((x) => x * 60);
  const z = tH.map((x) => Math.sqrt(b_imp ** 2 + (2 * x / t14_h * denom) ** 2));
  const model = transitFlux(z, k, disk);

  const rng = makeRng(seed);
  const obs = model.map((m) => m + rng.normal(0, sigma));

  const bins = binLightCurve(tM, obs, bin_min, sigma);
  const binModel = bins.centers.map((c) => interp(c / 60, tH, model));

  const residRaw = obs.map((o, i) => (o - model[i]) * 1e3);
  const residBin = bins.flux.map((f, i) => (f - binModel[i]) * 1e3);
  let s = 0, s2 = 0, n = 0;
  for (let i = 0; i < tH.length; i++) {
    if (Math.abs(tH[i]) > t14_h / 2) { s += residRaw[i]; s2 += residRaw[i] ** 2; n++; }
  }
  const rms_oot = n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : NaN;

  return {
    params: { star_mag, k, b_imp, t14_h, u1, u2, exposure_s, sky_mag, obs_hours, bin_min, seed },
    instrument,
    depth, denom, disk,
    tM, model, obs, sigma, bins, residRaw, residBin, rms_oot,
    depth_pct: depth * 100,
    depth_ppm: depth * 1e6,
    depth_mmag,
    t14_h, t23_h,
    ingress_min: ingress_m,
    snr_per_frame: snr_frame,
    noise_per_frame_mmag: sigma * 1e3,
    depth_over_sigma: depth_mmag / (sigma * 1e3),
    max_safe_exposure_s: calculateMaxExposure(star_mag, instrument),
    frames_in_transit: n_in,
    bins_in_transit: n_bin_in,
    binned_sigma_mmag,
    grazing: b_imp >= 1 - k,
  };
}
