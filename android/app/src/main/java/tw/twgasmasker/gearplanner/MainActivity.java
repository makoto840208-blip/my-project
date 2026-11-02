package tw.twgasmasker.gearplanner;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 負重規劃師 Android 外殼：全螢幕 WebView 載入線上版，並在黑屏時攔截音量鍵。
 * 音量＋短按＝念進度（休息點／今日終點）、音量＋長按＝念方位與位置、＋－同按 3 秒＝SOS；－鍵先空著（只攔下不調音量）。
 * 只有網頁說「黑屏中」（AndroidBridge.volCapture(true)）才攔截，平常音量鍵照常調音量。
 */
public class MainActivity extends Activity {
    static final String HOST = "square-mode-1f4a.makoto840208.workers.dev";
    static final String BASE = "https://" + HOST + "/";
    static final int REQ_FILE = 11, REQ_PERM = 12;
    static final long LONG_MS = 650, SOS_MS = 3000;

    private WebView web;
    private ValueCallback<Uri[]> fileCb;
    private GeolocationPermissions.Callback geoCb;
    private String geoOrigin;
    private PermissionRequest camReq;
    private final Handler h = new Handler(Looper.getMainLooper());

    /* 音量鍵狀態 */
    private volatile boolean volCap = false;
    private boolean upDown = false, dnDown = false, upLong = false, combo = false, sosFired = false;
    private final Runnable upLongR = new Runnable() {
        @Override public void run() {
            if (upDown && !combo) { upLong = true; js("up", "long"); }
        }
    };
    private final Runnable sosR = new Runnable() {
        @Override public void run() {
            if (upDown && dnDown) { sosFired = true; js("both", "sos"); }
        }
    };

    /** 一開始載入哪一頁（導航圖示會覆寫成 nav.html） */
    protected String startPath() {
        return "index.html";
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setBackgroundDrawable(new ColorDrawable(0xFF11150F));
        web = new WebView(this);
        web.setBackgroundColor(0xFF11150F);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String sch = u.getScheme() == null ? "" : u.getScheme();
                if ((sch.equals("https") || sch.equals("http")) && HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* 沒有可開的 App */ }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    cb.invoke(origin, true, false);
                } else {
                    geoCb = cb; geoOrigin = origin;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_PERM);
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                boolean video = false;
                for (String r : req.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) video = true;
                if (!video) { req.deny(); return; }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    req.grant(req.getResources());
                } else {
                    camReq = req;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_PERM);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try {
                    startActivityForResult(p.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
                return true;
            }
        });
        String url = BASE + startPath();
        Intent in = getIntent();
        if (in != null && in.getData() != null && HOST.equals(in.getData().getHost())) url = in.getData().toString();
        if (b == null) web.loadUrl(url); else web.restoreState(b);
    }

    @Override
    protected void onSaveInstanceState(Bundle o) {
        super.onSaveInstanceState(o);
        web.saveState(o);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE && fileCb != null) {
            fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCb = null;
        } else super.onActivityResult(req, res, data);
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] grants) {
        boolean ok = grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED;
        if (geoCb != null) { geoCb.invoke(geoOrigin, ok, false); geoCb = null; }
        if (camReq != null) { if (ok) camReq.grant(camReq.getResources()); else camReq.deny(); camReq = null; }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else finish();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onDestroy() {
        h.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }

    /* ---- 音量鍵 ---- */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (volCap && (k == KeyEvent.KEYCODE_VOLUME_UP || k == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) { if (e.getRepeatCount() == 0) volDown(k); }
            else if (e.getAction() == KeyEvent.ACTION_UP) volUp(k);
            return true; /* 黑屏中不調音量 */
        }
        return super.dispatchKeyEvent(e);
    }

    private void volDown(int k) {
        if (k == KeyEvent.KEYCODE_VOLUME_UP) upDown = true; else dnDown = true;
        if (upDown && dnDown) {
            combo = true; sosFired = false;
            h.removeCallbacks(upLongR);
            h.removeCallbacks(sosR);
            h.postDelayed(sosR, SOS_MS);
        } else if (k == KeyEvent.KEYCODE_VOLUME_UP) {
            upLong = false;
            h.postDelayed(upLongR, LONG_MS);
        }
    }

    private void volUp(int k) {
        boolean wasUp = k == KeyEvent.KEYCODE_VOLUME_UP;
        if (wasUp) upDown = false; else dnDown = false;
        h.removeCallbacks(sosR);
        if (!combo && wasUp) {
            h.removeCallbacks(upLongR);
            if (!upLong) js("up", "short");
        }
        if (!upDown && !dnDown) { combo = false; sosFired = false; upLong = false; }
    }

    private void js(final String key, final String kind) {
        h.post(new Runnable() {
            @Override public void run() {
                if (web != null) web.evaluateJavascript("window.__vol&&window.__vol('" + key + "','" + kind + "')", null);
            }
        });
    }

    private void keepOn(boolean on) {
        if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    /** 網頁呼叫的橋接（window.AndroidBridge） */
    private class Bridge {
        @JavascriptInterface
        public void volCapture(boolean on) {
            volCap = on;
            if (!on) { upDown = dnDown = upLong = combo = sosFired = false; h.removeCallbacks(upLongR); h.removeCallbacks(sosR); }
        }

        @JavascriptInterface
        public void keepOn(final boolean on) {
            h.post(new Runnable() { @Override public void run() { MainActivity.this.keepOn(on); } });
        }

        @JavascriptInterface
        public String version() {
            return "android-107";
        }
    }
}
