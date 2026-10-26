package io.github.htbnoob.seestarplanner;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hosts the planner's web UI (app/src/main/assets/www) in a WebView.
 *
 * - Assets are served from https://appassets.androidplatform.net/assets/... so the
 *   page has a secure origin (needed for ES modules and geolocation).
 * - A small JavaScript bridge ("NativeHttp") performs HTTPS GETs natively, because
 *   the NASA Exoplanet Archive and AAVSO VSX don't send CORS headers and a plain
 *   fetch() from the page would be blocked. Only the app's three data sources are
 *   reachable through it.
 */
public class MainActivity extends Activity {

    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String ASSET_PREFIX = "/assets/";
    private static final String START_URL = "https://" + ASSET_HOST + ASSET_PREFIX + "www/index.html";
    private static final int REQ_LOCATION = 42;

    private static final Set<String> ALLOWED_HOSTS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "exoplanetarchive.ipac.caltech.edu",
            "www.aavso.org",
            "api.open-meteo.com")));

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("txt", "text/plain");
    }

    private WebView webView;
    private final ExecutorService httpPool = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, String> bodies = new ConcurrentHashMap<>();

    private String userAgent = "SeestarExoplanetPlanner-Android";

    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        try {
            userAgent += "/" + getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException ignored) {
            // keep the plain user agent
        }
        WebView.setWebContentsDebuggingEnabled(debuggable);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#070b16"));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#070b16"));
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyWindowInsets(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage keeps your settings between launches
        s.setGeolocationEnabled(true);         // "Use my location" on the site card
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setTextZoom(100);                    // layout is already sized for phones

        webView.addJavascriptInterface(new NativeHttp(), "NativeHttp");
        webView.setWebViewClient(new AssetClient());
        webView.setWebChromeClient(new ChromeClient());

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(START_URL);
        }
    }

    /** Edge-to-edge on Android 11+ (forced on 15+): pad the content by the system bars,
     *  display cutout and on-screen keyboard so nothing is hidden behind them. */
    private void applyWindowInsets(View root) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return;   // legacy layout already keeps content clear of the bars
        }
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsets.CONSUMED;
        });
    }

    // ------------------------------------------------------------------ assets
    private class AssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!ASSET_HOST.equals(uri.getHost())) {
                return null;
            }
            String path = uri.getPath();
            if (path == null || !path.startsWith(ASSET_PREFIX) || path.contains("..")) {
                return notFound();
            }
            String assetPath = path.substring(ASSET_PREFIX.length());
            try {
                InputStream in = getAssets().open(assetPath);
                String ext = assetPath.substring(assetPath.lastIndexOf('.') + 1).toLowerCase();
                String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
                WebResourceResponse resp = new WebResourceResponse(mime, "utf-8", in);
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-cache");
                resp.setResponseHeaders(headers);
                return resp;
            } catch (IOException e) {
                return notFound();
            }
        }

        private WebResourceResponse notFound() {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                    new HashMap<>(), new java.io.ByteArrayInputStream(new byte[0]));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (ASSET_HOST.equals(uri.getHost())) {
                return false;
            }
            // Any external link opens in the user's browser rather than inside the app.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
                // nothing to open it with
            }
            return true;
        }
    }

    // ------------------------------------------------------------------ geolocation
    private class ChromeClient extends WebChromeClient {
        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (hasLocationPermission()) {
                callback.invoke(origin, true, false);
                return;
            }
            pendingGeoOrigin = origin;
            pendingGeoCallback = callback;
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                    Manifest.permission.ACCESS_FINE_LOCATION}, REQ_LOCATION);
        }
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_LOCATION || pendingGeoCallback == null) {
            return;
        }
        boolean granted = false;
        for (int r : grantResults) {
            granted |= (r == PackageManager.PERMISSION_GRANTED);
        }
        pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
        pendingGeoCallback = null;
        pendingGeoOrigin = null;
    }

    // ------------------------------------------------------------------ HTTP bridge
    /** Exposed to JavaScript as window.NativeHttp (see assets/www/js/http.js). */
    private class NativeHttp {
        @JavascriptInterface
        public void get(final String id, final String url, final int timeoutMs) {
            httpPool.execute(() -> {
                int status = 0;
                String error = null;
                String body = "";
                HttpURLConnection conn = null;
                try {
                    URL u = new URL(url);
                    if (!"https".equals(u.getProtocol()) || !ALLOWED_HOSTS.contains(u.getHost())) {
                        throw new IOException("host not allowed: " + u.getHost());
                    }
                    conn = (HttpURLConnection) u.openConnection();
                    int t = Math.max(1000, timeoutMs);
                    conn.setConnectTimeout(Math.min(t, 30000));
                    conn.setReadTimeout(t);
                    conn.setRequestProperty("User-Agent", userAgent);
                    conn.setRequestProperty("Accept", "*/*");
                    status = conn.getResponseCode();
                    InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    body = in == null ? "" : readAll(in);
                } catch (Exception e) {
                    error = e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "");
                } finally {
                    if (conn != null) {
                        conn.disconnect();
                    }
                }
                bodies.put(id, body);
                final String js = "window.__nativeHttpDone(" + JSONObject.quote(id) + "," + status + ","
                        + (error == null ? "null" : JSONObject.quote(error)) + ")";
                runOnUiThread(() -> {
                    if (webView != null) {
                        webView.evaluateJavascript(js, null);
                    }
                });
            });
        }

        @JavascriptInterface
        public String takeBody(String id) {
            String b = bodies.remove(id);
            return b == null ? "" : b;
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream is = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) != -1) {
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    // ------------------------------------------------------------------ lifecycle
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Back steps through the app's tabs before leaving the app.
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        httpPool.shutdownNow();
        if (webView != null) {
            webView.removeJavascriptInterface("NativeHttp");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
