// HTTP GET that works inside the Android app and in a normal browser.
//
// Inside the app, requests go through the native `NativeHttp` bridge
// (MainActivity.java), which isn't subject to browser CORS rules - the NASA
// Exoplanet Archive and AAVSO VSX don't send CORS headers, so a plain fetch()
// from the WebView would be blocked. In a desktop browser (for development)
// it falls back to fetch().

const pending = new Map();
let nextId = 1;

// Called by MainActivity when a request finishes; the body is pulled
// separately via NativeHttp.takeBody(id) so large responses aren't inlined
// into a JavaScript source string.
globalThis.__nativeHttpDone = (id, status, error) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  const body = globalThis.NativeHttp.takeBody(id);
  if (error) p.reject(new Error(error));
  else p.resolve({ status, ok: status >= 200 && status < 300, text: body || "" });
};

export function buildUrl(base, params) {
  const q = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return q ? `${base}?${q}` : base;
}

export function httpGet(url, timeoutMs = 30000) {
  if (globalThis.NativeHttp && typeof globalThis.NativeHttp.get === "function") {
    return new Promise((resolve, reject) => {
      const id = String(nextId++);
      pending.set(id, { resolve, reject });
      globalThis.NativeHttp.get(id, url, timeoutMs);
    });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { signal: ctrl.signal })
    .then(async (r) => ({ status: r.status, ok: r.ok, text: await r.text() }))
    .catch((e) => { throw new Error(e.name === "AbortError" ? "timeout" : String(e.message || e)); })
    .finally(() => clearTimeout(timer));
}

/** Simple in-memory cache with TTL, mirroring Streamlit's @st.cache_data(ttl=...). */
const cache = new Map();
export async function cached(key, ttlSec, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlSec * 1000) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
