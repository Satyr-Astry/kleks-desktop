# Kleks Android（APK）

把同一份网页产物打成手机 App：**WebView 外壳 + 内置只监听 127.0.0.1 的本地服务器**，不依赖 androidx / Gradle。

- 包名 `com.satyr.astry.kleks`，版本 1.0.0，`minSdk 24`（Android 7.0+），`targetSdk 34`
- 产物体积 **1.1 MB**（网页产物剔除 source map 与旧构建残留后只剩 2.0 MB）
- 权限只有 `INTERNET`（本地服务器用）+ `WRITE_EXTERNAL_STORAGE`（`maxSdkVersion=28`，老系统写公共下载目录用）

## 为什么要内置本地服务器

Klecks 是 **ES 模块 + ServiceWorker + IndexedDB** 的现代网页应用：

- `file://` 打开会白屏（模块被 CORS 拦），而且不是安全上下文 → ServiceWorker 不注册、IndexedDB 受限；
- `http://127.0.0.1:<随机端口>` 被浏览器视为**可信来源**，上面这些全部可用。

`LocalServer.java` 就是一个 ~150 行的 `ServerSocket` 静态服务器（每连接一线程、带 MIME 表、禁止 `..` 穿越），把 `assets/web/` 喂给 WebView。

## 手机端额外做的事（上游没有的）

| 功能 | 实现 |
| --- | --- |
| **导出图片能存进「下载」** | Kleks 走 `blob:` + `<a download>`，而 Android 的 DownloadManager 抓不到 `blob:`。页面加载后注入一段 JS：拦截 `a[download]` 的 blob 链接 → `FileReader` 转 base64 → `KleksBridge.saveBase64()`；原生侧 API 29+ 用 **MediaStore** 写进公共下载目录（不需要权限），老系统走 `getExternalStoragePublicDirectory` |
| **打开/导入文件** | `WebChromeClient.onShowFileChooser` + `startActivityForResult`，交给系统文件选择器 |
| **绘画体验** | 沉浸式全屏（隐藏状态栏/导航栏）、常亮、关掉 WebView 自带缩放（画布自己管手势） |
| **外链** | 非 127.0.0.1 的链接交给系统浏览器，站内留在 WebView |
| **返回键** | 能回退就回退，否则退出 |

## 自己编译

```bash
pip install pillow                       # 只用来生成图标
python build.py --dist <网页产物 dist 目录>
```

需要：JDK 17（`C:\Program Files\Java\jdk-17`）+ Android SDK 的
`build-tools;34.0.0` 与 `platforms;android-34`（本机放在 `E:\dev\android-sdk`，可用
`aria2c` 直接下 `build-tools_r34-windows.zip`、`platform-34-ext7_r03.zip` 再展平一层目录）。

流程：生成 5 档图标 → 拷 `assets/web`（剔除 `.map` + 未被 `index.html` 引用的旧 `klecks.<hash>.js`，
本机实测这样能省 5 MB）→ `aapt2 compile/link` → `javac` → `d8` → 把 `classes.dex` 塞进 APK →
`zipalign` → `apksigner` 签名（首次自动生成 `keystore/kleks.jks`）→ 自检打印 badging/签名/内容清单。

`verify_apk_assets.py` 会逐字节比对 APK 里的网页文件与构建用的 dist，确认打进去的就是验证过的那份。

## 安装

APK 未上应用商店，侧载：手机上「设置 → 允许安装未知来源应用」→ 点开 APK 安装。

> ⚠️ **签名密钥要留好**：`keystore/kleks.jks`（口令见 `build.py` 顶部）。以后发新版必须用同一把密钥，
> 否则手机不会覆盖安装、只能先卸载。仓库里**不含**这个文件（本地生成）。
