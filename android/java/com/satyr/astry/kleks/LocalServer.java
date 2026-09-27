package com.satyr.astry.kleks;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.Map;

/**
 * 只监听 127.0.0.1 的极简静态服务器，把 assets/web/ 里的网页产物喂给 WebView。
 *
 * 为什么要它：Klecks 是 ES 模块 + ServiceWorker + IndexedDB 的现代网页应用，
 * file:// 打开会白屏（模块被 CORS 拦）、且不是安全上下文。
 * http://127.0.0.1 被浏览器视为"可信来源"，ServiceWorker 与持久化存储都能用。
 */
class LocalServer implements Runnable {

    private final ServerSocket serverSocket;
    private final AssetManager assets;
    private volatile boolean running = true;

    private static final Map<String, String> MIME = new HashMap<String, String>();

    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("js", "text/javascript; charset=utf-8");
        MIME.put("mjs", "text/javascript; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("map", "application/json; charset=utf-8");
        MIME.put("txt", "text/plain; charset=utf-8");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("gif", "image/gif");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("otf", "font/otf");
        MIME.put("wasm", "application/wasm");
        MIME.put("webmanifest", "application/manifest+json");
    }

    LocalServer(Context context, int port) throws IOException {
        this.assets = context.getAssets();
        this.serverSocket = new ServerSocket(port, 64, InetAddress.getByName("127.0.0.1"));
    }

    int getPort() {
        return serverSocket.getLocalPort();
    }

    void start() {
        Thread t = new Thread(this, "kleks-local-server");
        t.setDaemon(true);
        t.start();
    }

    void stop() {
        running = false;
        try {
            serverSocket.close();
        } catch (IOException ignored) {
        }
    }

    @Override
    public void run() {
        while (running) {
            final Socket socket;
            try {
                socket = serverSocket.accept();
            } catch (IOException e) {
                if (running) {
                    continue;
                }
                break;
            }
            // 网页会有多个并发连接（75+ 个静态文件），每个连接单独处理
            Thread worker = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        handle(socket);
                    } catch (Exception ignored) {
                    } finally {
                        try {
                            socket.close();
                        } catch (IOException ignored) {
                        }
                    }
                }
            });
            worker.setDaemon(true);
            worker.start();
        }
    }

    private void handle(Socket socket) throws IOException {
        socket.setSoTimeout(15000);
        BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), "UTF-8"));
        String requestLine = in.readLine();
        if (requestLine == null) {
            return;
        }
        // 把请求头读完（不读干净会影响 keep-alive 之外的行为）
        while (true) {
            String header = in.readLine();
            if (header == null || header.isEmpty()) {
                break;
            }
        }

        String[] parts = requestLine.split(" ");
        String method = parts.length > 0 ? parts[0] : "GET";
        String path = parts.length > 1 ? parts[1] : "/";
        int q = path.indexOf('?');
        if (q >= 0) {
            path = path.substring(0, q);
        }
        if (path.isEmpty() || path.equals("/")) {
            path = "/index.html";
        }

        OutputStream out = socket.getOutputStream();
        if (path.contains("..")) {
            sendError(out, 403, "Forbidden");
            return;
        }

        String assetPath = "web" + path;
        InputStream is = null;
        try {
            is = assets.open(assetPath);
        } catch (IOException notFound) {
            sendError(out, 404, "Not Found: " + path);
            return;
        }

        try {
            byte[] body = readAll(is);
            String ext = "";
            int dot = path.lastIndexOf('.');
            if (dot >= 0 && dot + 1 < path.length()) {
                ext = path.substring(dot + 1).toLowerCase();
            }
            String mime = MIME.get(ext);
            if (mime == null) {
                mime = "application/octet-stream";
            }
            StringBuilder head = new StringBuilder();
            head.append("HTTP/1.1 200 OK\r\n")
                    .append("Content-Type: ").append(mime).append("\r\n")
                    .append("Content-Length: ").append(body.length).append("\r\n")
                    .append("Cache-Control: no-cache\r\n")
                    .append("Connection: close\r\n\r\n");
            out.write(head.toString().getBytes("UTF-8"));
            if (!"HEAD".equals(method)) {
                out.write(body);
            }
            out.flush();
        } finally {
            try {
                is.close();
            } catch (IOException ignored) {
            }
        }
    }

    private static void sendError(OutputStream out, int code, String message) throws IOException {
        byte[] body = message.getBytes("UTF-8");
        String head = "HTTP/1.1 " + code + " Error\r\n"
                + "Content-Type: text/plain; charset=utf-8\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes("UTF-8"));
        out.write(body);
        out.flush();
    }

    private static byte[] readAll(InputStream is) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(65536);
        byte[] buf = new byte[65536];
        int n;
        while ((n = is.read(buf)) > 0) {
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }
}
