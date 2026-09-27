package com.satyr.astry.kleks;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.URLDecoder;

/**
 * Kleks 安卓外壳：WebView + 本地 http 服务器（见 LocalServer）。
 * 不依赖 androidx / Gradle，只用 Android framework API。
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_STORAGE_PERM = 1002;

    private WebView webView;
    private LocalServer server;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 绘画应用：别让屏幕自己灭
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage / IndexedDB（"恢复上次会话"、设置都靠它）
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportZoom(false);               // 画布自己管手势，别让 WebView 抢
        s.setBuiltInZoomControls(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                // 站内（本地服务器）留在 WebView，其他交给系统浏览器
                if (host != null && (host.equals("127.0.0.1") || host.equals("localhost"))) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectBlobDownloadShim(view);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                return true;   // 别把控制台噪音打出到 logcat
            }
        });

        // blob: 直接交给 DownloadManager 会失败（它抓不到 blob），所以由页面里的 shim 转 base64 走桥上方法
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                if (url != null && url.startsWith("blob:")) {
                    return;   // 交给 KleksBridge.saveBase64
                }
                try {
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, guessName(url, contentDisposition));
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm != null) {
                        dm.enqueue(req);
                    }
                } catch (Exception ignored) {
                }
            }
        });

        webView.addJavascriptInterface(new Bridge(), "KleksBridge");

        // 启动本地服务器 → 加载
        try {
            server = new LocalServer(this, 0);
            server.start();
            webView.loadUrl("http://127.0.0.1:" + server.getPort() + "/index.html");
        } catch (IOException e) {
            showFatal(e.toString());
            return;
        }

        setContentView(webView);
        hideSystemBars();
        requestLegacyStorageIfNeeded();
    }

    /** 用 JS 接管「下载」：把 blob 转成 base64，交给原生写进公共下载目录。 */
    private void injectBlobDownloadShim(WebView view) {
        String js = "(function(){"
                + "if(window.__kleksBlobShim)return;window.__kleksBlobShim=true;"
                + "document.addEventListener('click',function(e){"
                + "  var a=e.target&&e.target.closest?e.target.closest('a[download]'):null;"
                + "  if(!a)return;var href=a.getAttribute('href')||'';"
                + "  if(href.indexOf('blob:')!==0)return;"
                + "  e.preventDefault();e.stopPropagation();"
                + "  fetch(href).then(function(r){return r.blob()}).then(function(b){"
                + "    var fr=new FileReader();"
                + "    fr.onload=function(){var s=String(fr.result);"
                + "      try{KleksBridge.saveBase64(a.getAttribute('download')||'kleks.png',s.substring(s.indexOf(',')+1),b.type||'application/octet-stream');}"
                + "      catch(err){}};"
                + "    fr.readAsDataURL(b);"
                + "  }).catch(function(){});"
                + "},true);"
                + "})();";
        view.evaluateJavascript(js, null);
    }

    /** 页面 → 原生：保存导出的图片。 */
    private class Bridge {
        @JavascriptInterface
        public void saveBase64(String name, String base64, String mime) {
            if (name == null || name.trim().isEmpty()) {
                name = "kleks.png";
            }
            name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                String saved = writeToDownloads(name, mime, data);
                final String msg = saved == null ? "保存失败" : ("已保存到「下载」：" + saved);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
                    }
                });
            } catch (Exception e) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "保存失败", Toast.LENGTH_LONG).show();
                    }
                });
            }
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }
    }

    private String writeToDownloads(String name, String mime, byte[] data) throws IOException {
        if (mime == null || mime.isEmpty()) {
            mime = "application/octet-stream";
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                return null;
            }
            OutputStream os = getContentResolver().openOutputStream(uri);
            if (os == null) {
                return null;
            }
            try {
                os.write(data);
                os.flush();
            } finally {
                os.close();
            }
            return name;
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) {
            return null;
        }
        File out = new File(dir, name);
        FileOutputStream fos = new FileOutputStream(out);
        try {
            fos.write(data);
            fos.flush();
        } finally {
            fos.close();
        }
        return name;
    }

    private void requestLegacyStorageIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE_PERM);
        }
    }

    private static String guessName(String url, String contentDisposition) {
        String name = "kleks-download";
        try {
            String decoded = URLDecoder.decode(url, "UTF-8");
            int slash = decoded.lastIndexOf('/');
            if (slash >= 0 && slash + 1 < decoded.length()) {
                name = decoded.substring(slash + 1);
            }
        } catch (Exception ignored) {
        }
        if (!name.contains(".")) {
            name = name + ".png";
        }
        return name;
    }

    private void showFatal(String message) {
        TextView tv = new TextView(this);
        tv.setText("启动失败：\n" + message);
        tv.setPadding(48, 96, 48, 48);
        setContentView(tv);
    }

    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
        hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        if (server != null) {
            server.stop();
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
