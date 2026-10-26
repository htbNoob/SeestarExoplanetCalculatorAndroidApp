// Preset observatories, optical tubes, cameras and light-curve targets
// (ported unchanged from app.py).
import { SEESTAR_CAMERA, SEESTAR_OTA, makeCamera, makeOTA } from "./core.js";

export const MANUAL_OPTION = "Manual (custom location)";

export const PRESET_SITES = {
  "Frankfurt am Main, Germany": {
    name: "Frankfurt am Main, Germany", lat: 50.0853, lon: 8.5822, elev_m: 100,
    tz: "Europe/Berlin", sky_mag: 18.0 },
  "Taunus Observatory (Kleiner Feldberg)": {
    name: "Taunus Observatory (Kleiner Feldberg)", lat: 50.2217, lon: 8.4458, elev_m: 826,
    tz: "Europe/Berlin", sky_mag: 20.8 },     // Bortle 4
  "Teide Observatory, Tenerife": {
    name: "Teide Observatory, Tenerife", lat: 28.3000, lon: -16.5097, elev_m: 2390,
    tz: "Atlantic/Canary", sky_mag: 21.59 },  // Bortle 4
  "Madrona Peak Observatory": {
    name: "Madrona Peak Observatory", lat: 29.8442, lon: -99.3558, elev_m: 379,
    tz: "America/Chicago", sky_mag: 21.89 },  // Bortle 2
};
export const DEFAULT_PRESET = "Frankfurt am Main, Germany";

// Specs marked "est." are not in the source spec sheets and are estimated -
// worth confirming against your own calibration frames.
export const OTA_PRESETS = {
  "Seestar S50": SEESTAR_OTA,
  "Taunus Westkuppel (PlaneWave CDK12.5, f/8)": makeOTA("Taunus Westkuppel CDK12.5", 317.5, 2531.0),
  "Taunus Ostkuppel 60cm (primary focus, f/3.3)": makeOTA("Taunus Ostkuppel 60cm (primary)", 600.0, 2000.0),
  "Taunus Ostkuppel 60cm (secondary focus, f/10)": makeOTA("Taunus Ostkuppel 60cm (secondary)", 600.0, 6000.0),
  "MPO61 RCOS 610 24\" (f/7.9)": makeOTA("MPO61 RCOS 610", 609.6, 4814.0),
};

export const CAMERA_PRESETS = {
  "Seestar Sony IMX462": SEESTAR_CAMERA,
  // full_well/read_noise: midpoints of Atik's published ranges; dark_current, gain: est.
  "Atik 383L+ (KAF-8300 CCD)": makeCamera({
    name: "Atik 383L+", pixel_size_um: 5.4, full_well_e: 25500, read_noise_e: 8.5,
    dark_current_e_s: 0.02, qe: 0.5, gain_e_per_adu: 0.39, bit_depth: 16 }),
  // read_noise/qe: midpoints of Moravian's published ranges; dark_current, gain: est.
  "Moravian C3-61000 (Sony IMX455 CMOS)": makeCamera({
    name: "Moravian C3-61000", pixel_size_um: 3.76, full_well_e: 50000, read_noise_e: 2.0,
    dark_current_e_s: 0.001, qe: 0.85, gain_e_per_adu: 0.76, bit_depth: 16 }),
  // full_well = 60000 ADU x 1.26 e-/ADU from MPO61's config; read_noise, dark, qe: est.
  "QHY461PH (MPO61)": makeCamera({
    name: "QHY461PH", pixel_size_um: 3.76, full_well_e: 75600, read_noise_e: 3.5,
    dark_current_e_s: 0.0005, qe: 0.85, gain_e_per_adu: 1.26, bit_depth: 16 }),
};
export const DEFAULT_OTA = "Seestar S50";
export const DEFAULT_CAMERA = "Seestar Sony IMX462";

export const LIGHTCURVE_PRESETS = {
  "Custom": null,
  "HAT-P-32 b":   { star_mag: 11.44, k: 0.1508, b_imp: 0.147, t14_h: 3.07, u1: 0.30, u2: 0.28 },
  "HD 189733 b":  { star_mag: 7.65,  k: 0.1504, b_imp: 0.671, t14_h: 1.83, u1: 0.30, u2: 0.28 },
  "HD 209458 b":  { star_mag: 7.65,  k: 0.1209, b_imp: 0.507, t14_h: 3.07, u1: 0.30, u2: 0.28 },
  "WASP-33 b":    { star_mag: 8.14,  k: 0.1118, b_imp: 0.210, t14_h: 2.85, u1: 0.30, u2: 0.28 },
  "WASP-12 b":    { star_mag: 11.57, k: 0.1170, b_imp: 0.424, t14_h: 3.00, u1: 0.30, u2: 0.28 },
  "Qatar-1 b":    { star_mag: 12.69, k: 0.1463, b_imp: 0.645, t14_h: 1.66, u1: 0.30, u2: 0.28 },
  "GJ 486 b":     { star_mag: 11.39, k: 0.0372, b_imp: 0.120, t14_h: 1.016, u1: 0.30, u2: 0.28 },
  "K2-18 b":      { star_mag: 13.48, k: 0.0538, b_imp: 0.65,  t14_h: 2.97, u1: 0.30, u2: 0.28 },
  "LTT 1445 A b": { star_mag: 11.22, k: 0.0451, b_imp: 0.17,  t14_h: 1.37, u1: 0.30, u2: 0.28 },
  "GJ 1214 b":    { star_mag: 14.71, k: 0.1159, b_imp: 0.264, t14_h: 0.870, u1: 0.30, u2: 0.28 },
  "TRAPPIST-1 b": { star_mag: 18.80, k: 0.0859, b_imp: 0.095, t14_h: 0.601, u1: 0.30, u2: 0.28 },
  "TRAPPIST-1 c": { star_mag: 18.80, k: 0.0844, b_imp: 0.109, t14_h: 0.701, u1: 0.30, u2: 0.28 },
};
