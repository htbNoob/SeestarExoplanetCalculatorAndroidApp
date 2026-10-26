// Hourly cloud / precipitation / temperature forecast for tonight's dark
// window via Open-Meteo (free, no key). Port of seestar_weather.py.
import { buildUrl, httpGet } from "./http.js";

export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

export async function fetchHourlyForecast(lat, lon, forecastDays = 2, timeoutMs = 15000) {
  const url = buildUrl(FORECAST_URL, {
    latitude: lat, longitude: lon,
    hourly: "cloudcover,precipitation_probability,temperature_2m,dewpoint_2m,windspeed_10m",
    timezone: "UTC",
    forecast_days: forecastDays,
  });
  const r = await httpGet(url, timeoutMs);
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  const h = JSON.parse(r.text).hourly;
  const f = (a) => (a || []).map((v) => (v === null || v === undefined ? NaN : Number(v)));
  return {
    time_utc: h.time,
    cloudcover: f(h.cloudcover),
    precip_prob: f(h.precipitation_probability),
    temperature_c: f(h.temperature_2m),
    dewpoint_c: f(h.dewpoint_2m),
    windspeed_kmh: f(h.windspeed_10m),
  };
}

/** "2026-10-26T18:00" (UTC) -> JD (UTC). */
export const isoUtcToJd = (s) => Date.parse(s.length <= 16 ? s + ":00Z" : s.endsWith("Z") ? s : s + "Z") / 86400000 + 2440587.5;

const nan = (fn) => (arr) => { const v = arr.filter((x) => !Number.isNaN(x)); return v.length ? fn(v) : NaN; };
const nanmean = nan((v) => v.reduce((a, b) => a + b, 0) / v.length);
const nanmax = nan((v) => Math.max(...v));
const nanmin = nan((v) => Math.min(...v));

export function summarizeDarkWindowWeather(fc, dw) {
  // Same comparison as the Python version (forecast JD in UTC vs window JD in TDB).
  const idx = [];
  fc.time_utc.forEach((t, i) => { const jd = isoUtcToJd(t); if (jd >= dw.ds_jd && jd <= dw.de_jd) idx.push(i); });
  if (!idx.length) return null;
  const pick = (a) => idx.map((i) => a[i]);
  const meanCc = nanmean(pick(fc.cloudcover));
  const meanPp = nanmean(pick(fc.precip_prob));
  let rating;
  if (meanCc < 20 && meanPp < 20) rating = "Good";
  else if (meanCc < 60 && meanPp < 40) rating = "Fair";
  else rating = "Poor";
  return {
    mean_cloudcover: meanCc,
    max_cloudcover: nanmax(pick(fc.cloudcover)),
    mean_precip_prob: meanPp,
    min_temperature_c: nanmin(pick(fc.temperature_c)),
    max_windspeed_kmh: nanmax(pick(fc.windspeed_kmh)),
    rating,
  };
}
