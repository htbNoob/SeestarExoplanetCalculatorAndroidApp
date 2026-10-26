# Seestar Exoplanet Planner: Android app

An Android version of the [Seestar Exoplanet Transit Observation Planner](https://github.com/htbNoob/SeestarExoplanetCalculator) Streamlit app. It has the same four tools in a phone-friendly UI:

1. **SNR Explorer**: SNR versus exposure time, star magnitude and sky brightness.
2. **Light Curve Simulator**: limb-darkened transit with photon noise, binning, residuals and a stellar-disk diagram. It includes all 12 target presets.
3. **Tonight's Best Transits**: a live query of the NASA Exoplanet Archive (optionally including TOI candidates), ranked for your site's dark window.
4. **Tonight's Best Eclipsing Binaries**: a live query of AAVSO VSX plus the curated WD/NS/BH systems, ranked the same way.

Both "tonight" pages show the Open-Meteo weather forecast for the dark window. All instrument presets (Seestar S50, Taunus domes, MPO61) and observatory presets are included.

## Getting the APK

Building happens on GitHub Actions, so you don't need Android Studio.

1. Push this folder to a new GitHub repository.
2. Open the **Actions** tab. The **Build APK** workflow runs on every push to `main`/`master`, and you can also start it manually with *Run workflow*.
3. When it finishes, download the **SeestarPlanner-debug-apk** artifact from the run page. It's a zip file containing `SeestarPlanner-debug.apk`.

**Easier on a phone:** push a tag such as `v1.0.0` (`git tag v1.0.0 && git push --tags`). The workflow then attaches the APK to a GitHub **Release**, and you can download it directly in your phone's browser.

To install, open the APK on the phone and allow "Install unknown apps" for your browser or file manager when Android asks. Requires Android 8.0+.

### Updates install over the previous version

The debug build is signed with `app/debug.keystore`, which is committed on purpose. It is a standard, non-secret debug key (password `android`). Every CI build therefore has the same signature, and the version code is the CI run number, so each new APK installs as an update and keeps your settings. Without this, every CI run would use a random debug key and Android would refuse to update.

### Optional: signed release build

For a proper release signature (for example to distribute the app), create a keystore once:

```bash
keytool -genkeypair -keystore release.jks -alias seestar -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 release.jks   # copy the output
```

Then add four repository secrets (Settings → Secrets and variables → Actions): `SIGNING_KEYSTORE_BASE64`, `SIGNING_STORE_PASSWORD`, `SIGNING_KEY_ALIAS`, `SIGNING_KEY_PASSWORD`. The workflow will also build `SeestarPlanner-release.apk`. Keep `release.jks` safe and out of git. Note that a release-signed APK can't update a debug-signed install (uninstall the debug app first).

## How it works

The Streamlit app needs a Python server, so the app doesn't embed Python. Instead it is a **JavaScript port** of the calculation modules, shown in an Android WebView:

| Python module | JavaScript port |
|---|---|
| `seestar_core.py` | `js/core.js` |
| `seestar_site.py` (astropy) | `js/site.js`: Sun position, sidereal time, precession and alt/az from standard formulas (Meeus) |
| `seestar_snr.py`, matplotlib figures | `js/charts.js` (Plotly, bundled offline) |
| `seestar_lightcurve.py` | `js/lightcurve.js` |
| `seestar_transits.py` | `js/transits.js` |
| `seestar_eb.py` | `js/eb.js` |
| `seestar_weather.py` | `js/weather.js` |
| `app.py` (Streamlit UI) | `index.html`, `css/app.css`, `js/app.js`, `js/presets.js` |

`MainActivity.java` serves the web files and provides a small native HTTP bridge (`NativeHttp`). The NASA Exoplanet Archive and AAVSO VSX don't send CORS headers, so a normal `fetch()` from the page would be blocked. The bridge only allows requests to the three data sources the app uses.

**Accuracy against the Python version.** The port was checked against the original code (astropy 8, numpy 2) on identical inputs at 4 sites × 3 dates:

- The ranked transit and eclipse candidate lists were identical in every case (113 candidates).
- Dark windows matched to under a second.
- Altitudes matched to within 0.01°.
- SNR, saturation, transit-depth and limb-darkened flux numbers matched to floating-point precision.

The only intentional difference in results is the simulated noise. JavaScript can't reproduce numpy's random generator, so the same seed gives a different (but still reproducible) noise pattern.

### Differences from the Streamlit app

- **Shared settings.** The instrument picker is shared by all four pages, and the site is shared by both "tonight" pages. All inputs are saved on the phone between launches.
- **Use my location** on the site card fills in latitude, longitude, elevation and timezone from the phone's GPS. Location permission is only requested when you tap the button.
- **Red night mode** (moon button, top right) keeps your eyes dark-adapted at the telescope.
- **Charts are static** so the page scrolls smoothly. Tap **Zoom** on a chart to pan, pinch-zoom and read values.
- **Mid-transit / mid-eclipse times** in the results table are shown in UTC and local time (the Streamlit table showed a raw JD). Tap a name in the table to jump to its light curve.
- Very long single-frame series (e.g. 1 s exposures) are thinned to about 2,500 plotted points. The binned points and statistics still use every frame.

## Editing the app

All app logic is in `app/src/main/assets/www/`. You can try changes in a desktop browser without rebuilding:

```bash
cd app/src/main/assets/www
python3 -m http.server 8000     # then open http://localhost:8000
```

In a desktop browser, the NASA and AAVSO queries will show as "unreachable" because of the CORS restriction described above. They only work inside the app. Open-Meteo and everything else work normally.

To change the presets, edit `js/presets.js` (sites, telescopes, cameras, light-curve targets) or `COMPACT_SYSTEMS` in `js/eb.js`.

## Project layout

```
.github/workflows/build-apk.yml      CI: builds the APK, attaches it to releases on v* tags
app/build.gradle                      SDK levels, version, signing
app/debug.keystore                    shared debug signing key (not secret)
app/src/main/AndroidManifest.xml
app/src/main/java/.../MainActivity.java   WebView host + NativeHttp bridge + location permission
app/src/main/res/                     launcher icon, theme
app/src/main/assets/www/              the app itself (HTML/CSS/JS, Plotly)
```

## Licenses

MIT, like the original project. Bundles [plotly.js](https://github.com/plotly/plotly.js) 2.35.3 (MIT, see `assets/www/lib/plotly-LICENSE.txt`).
