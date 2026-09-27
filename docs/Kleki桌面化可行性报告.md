# Kleki 能不能做成 App / 桌面软件？—— 结论：能，而且已经做好了

日期：2026-09-27　　（本文所有结论均来自本机实测，非推测）

---

## 一、先说结论

**能。** 而且不是"理论上能"——本机已经跑起来一个可以双击启动、完全离线的桌面版，实际画了一笔验证通过。

- 成品：`E:\dev\Kleks桌面版\Kleks.exe`（绿色便携，357 MB，含完整 Chromium）
- 桌面快捷方式：`F:\DESKTOP\Kleks 绘画.lnk`
- 证据：`E:\dev\Kleks桌面版\kleks-demo-screenshot.png`、`自检结果.json`

关键前提：Kleki 的**官方开源版叫 Klecks**（不是 "Kleki" 这个名字的仓库）。

---

## 二、上游项目的真实情况（实证）

| 项目 | 事实 |
| --- | --- |
| 仓库 | github.com/bitbof/klecks（另有 fork），README 自称 "官方开源版" |
| 官网 | klecks.org；kleki.com/about 明确写 "Kleki's source code is officially available as Klecks on GitHub" |
| 协议 | **MIT**（© bitbof）→ 可自由使用 / 修改 / 再分发 |
| 品牌例外 | **"Kleki" 名称与品牌不在 MIT 授权内**，不能拿 Klecks 去提供打着 Kleki 品牌的在线服务 → 自建产物必须叫 Kleks |
| 技术栈 | TypeScript + Parcel 打包，**无框架**（原生 DOM），依赖很少：ag-psd(PSD 读写)、glfx 系滤镜、json5、polygon-clipping、transformation-matrix |
| 形态 | 两种模式：`standalone`（kleki.com 用）和 `embed`（2draw.net 画图社区嵌页面用） |
| 热更新 | 已有 ServiceWorker（`klecks-service-worker.ts`），官方博客 2026-08-11 宣布"断网也能用" |
| 路线图 | 官方 about 页列出：PWA（离线支持）、WebGL→**WebGPU 迁移（约 2027）**、图层蒙版、魔法棒等 |
| 体量 | 本机 `npm ci && npm run build` 成功，`dist/` 只有 **11 MB / 77 个文件**——非常适合塞进各种壳 |

> 换句话说：这不是一个"能不能打包"的问题，而是一个"壳选哪个"的问题。11 MB 的静态产物，任何 WebView 方案都能装。

---

## 三、三条可行路线对比（附本机实测）

| 方案 | 可行性 | 体积 | 本机状态 | 适合场景 |
| --- | --- | --- | --- | --- |
| **① Electron 桌面壳** | ✅ 已完成 | 357 MB | **已跑通**（Chromium 144 / Electron 40.10.2，复用本机已缓存的 electron zip） | 要 Windows 上双击就用、功能 100% 一致 |
| **② Tauri / WebView2 壳** | ✅ 技术可行 | ~10 MB | ⚠️ 本机**没装 Rust**（`rustc/cargo` 均无）；WebView2 运行时 Win10/11 已随 Edge 自带 | 想要极小体积极致分发 |
| **③ Edge「应用模式」零代码** | ✅ 立刻可用 | 0 MB | `msedge.exe --app=http://127.0.0.1:端口` 可得到一个独立窗口（无地址栏、独立任务栏图标） | 不想装任何东西，只想有个"像 App 的窗口" |
| **④ PWA 安装** | ⚠️ 半可行 | 0 | 上游有 ServiceWorker 但仓库里**没有 webmanifest**，Chrome 的"安装"入口不会出现；自己补 manifest 后即可 | 手机/桌面从浏览器装 |
| **⑤ Android / iOS 原生包** | ✅ 可行 | ~5–10 MB | 未做 | 手机绘画；Android 可用 Capacitor / TWA，iOS 用 WKWebView 壳（注意 App Store 4.2「最低功能性」，纯 WebView 壳有被拒风险） |

本机实际选择了 **①**，原因：不需要额外工具链（Rust 没装，Electron 的 win32 包本机缓存里已有两个版本），且能保证画笔、压感、PSD、剪贴板、另存为对话框这些 API 一个不少。

---

## 四、封装时的真实坑（都踩过并解决了）

1. **不能直接双击 `dist/index.html`**
   Klecks 是 ES 模块 + ServiceWorker + `showSaveFilePicker`。
   - `file://` 下 ES 模块被 CORS 拦 → 白屏；
   - `file://` 不是安全上下文 → ServiceWorker 不注册、另存为 API 不出现。
   解法：外壳里起一个**只监听 127.0.0.1** 的静态服务器，用 `http://127.0.0.1:随机端口` 加载。实测 `isSecureContext = true`、`showSaveFilePicker` 存在、ServiceWorker `activated`。

2. **npm 装 Electron 在墙内会卡死**
   `registry.npmjs.org` 上 `npm i electron` 跑了 3 分钟连 `node_modules` 都没建起来。
   解法：直接用 `~/AppData/Local/electron/Cache/**/electron-v40.10.2-win32-x64.zip`（本机已缓存）解包，手动组装便携版，**完全绕过 npm 和 electron-builder**。

3. **便携版组装法（不用 electron-builder）**
   Electron 的 zip 解出来就是完整运行时：
   - 删掉 `resources\default_app.asar`
   - 把 `main.js` + `package.json` + `dist/` 放进 `resources\app\`
   - `electron.exe` 改名 `Kleks.exe`
   就是一个绿色便携 App，没有安装器、没有注册表。

4. **图形界面程序的 stdout 抓不到**
   第一次自检用 `console.log` 拿不到结果。解法：结果写进 `smoke-result.json` 文件再读。

5. **"页面加载完成" ≠ "应用渲染完成"**
   第一次自检读到的是 `Loading Kleks`、0 个 canvas。解法：轮询等 `canvas` 出现且 `#loading-screen` 消失，再采样。

6. **汉字 PowerShell 脚本要用 UTF-8 BOM**
   写 `.lnk` 的脚本含中文，PS 5.1 按 ANSI 读导致解析报错。解法：`utf-8-sig` 保存。

7. **⚠️ 关不掉的窗口（Electron 最坑的一条）**
   Kleks 内部有 `beforeunload` 保护（`src/app/script/klecks/ui/components/unload-warning-trigger.ts`，只要画笔历史与"上次保存点"不一致就注册）。
   **Electron 默认行为是尊重它 = 点 X / Alt+F4 都关不掉窗口**（它不会像浏览器那样弹"离开此网站？"，就是单纯拒绝关闭），只能去任务管理器杀进程。这是真实踩到的：主人反馈「我关不掉它」。
   解法：在主进程接管 `win.webContents.on('will-prevent-unload', event => ...)`，弹一个原生确认框（「仍然退出 / 取消」），选退出时 `event.preventDefault()` 放行。
   验证方式：自检里画一笔（注册 beforeunload）→ 调用 `win.close()` → 5 秒内收到 `closed` 事件即通过。实测 `closeTest: "closed"`。

8. **Electron 菜单栏（文件/编辑/视图/帮助）主人不要**
   `Menu.setApplicationMenu(null)` + `win.setMenuBarVisibility(false)` + `autoHideMenuBar: true` 三管齐下；菜单带的快捷键要在 `before-input-event` 里自己重接（F5 / Ctrl+R / Ctrl+Shift+R / F12 / F11）。
   注意：`capturePage()` 的截图**不包含菜单栏和标题栏**，所以自检截图看不出菜单栏在不在，得靠 `win.isMenuBarVisible()` 判断。

9. **自检里"画一笔"要用 CDP，不要用 `sendInputEvent`**
   `webContents.sendInputEvent` 发 `mouseMove` 时带不上按键状态（没有 `buttons: 1`），画板会把它当成"悬停"而拒绝落笔——只会在按下处留一个点。
   解法：`win.webContents.debugger.attach('1.3')` 后用 `Input.dispatchMouseEvent`（可显式传 `buttons: 1`）。再加上页面内 `pointerdown/pointermove/pointerup` 计数器做交叉验证（实测 1/40/1 全部到达），并用 `document.elementFromPoint` 确认落点命中画布。

---

## 五、自检实测数据（不是估计值）

```
页面就绪       ✅ 离开 Loading 屏；canvas 1153×861；5 个 canvas；84 个按钮；图层面板存在
菜单栏         ✅ isMenuBarVisible() = false、getApplicationMenu() = null（画面因此多 26px）
界面语言       ✅ 中文（"图层 1 / 不透明度 100% / 抖动修正 1 / 画笔大小 4"）
安全上下文     ✅ window.isSecureContext = true
ServiceWorker  ✅ activated（离线缓存生效）
系统另存为     ✅ 'showSaveFilePicker' in window = true
真实画笔输入   ✅ CDP 派发 1×mousePressed + 40×mouseMoved + 1×mouseReleased，
                  页面内事件计数 1/40/1 全部到达，画面 4036 个像素变化（截图是一条清晰波浪线）
关闭窗口       ✅ closeTest = "closed"（修复前被 beforeunload 卡死，点 X / Alt+F4 都无效）
引擎           Chromium 144 / Electron 40.10.2（UA 里带 Kleks/1.0.0）
产物体积       357 MB（Electron 运行时 340 MB + 应用 11 MB + 图标）
```

---

## 六、怎么维护 / 更新

```bash
cd E:/dev/klecks            # 上游源码（git clone，浅克隆）
git pull
npm ci
npm run icon:build && npm run lang:build && npm run build
cp -r dist/* "E:/dev/Kleks桌面版/resources/app/dist/"   # 只换网页产物，外壳不动
```

外壳源码在 `E:\dev\klecks-desktop\`（`main.js` + `package.json`），改完用
`E:\dev\pack_kleks.py` 重新组装即可。

---

## 七、还没做的（如果想要可以继续）

- Android APK（Capacitor / TWA），体积可压到 5 MB 上下
- 用 Tauri 换掉 Electron，产物从 357 MB 压到 ~10 MB（需先装 Rust 工具链，约 1 GB）
- 给 dist 补一个 `manifest.webmanifest`，让 kleki.com / 自建站支持 PWA 安装
- 单文件自解压 exe（NSIS/7z SFX），方便发给别人
