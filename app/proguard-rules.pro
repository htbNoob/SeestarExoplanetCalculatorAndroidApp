# Not used (minify is off). If you enable R8, keep the JavaScript bridge:
-keepclassmembers class io.github.htbnoob.seestarplanner.MainActivity$NativeHttp {
    @android.webkit.JavascriptInterface <methods>;
}
