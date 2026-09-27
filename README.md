# Kleks Desktop（Kleki 开源版的 Windows 便携桌面壳）

**把 kleki.com 的开源版 Klecks 打包成能双击启动、离线可用、带自动保存与全局对称绘制的 Windows 便携桌面应用。**
An Electron shell + focused patches that turn the open-source Klecks painting app into a portable Windows desktop app: disk auto-save, file associations, global mirror-symmetry drawing, and a visible-rect render optimization.

> 上游：[bitbof/klecks](https://github.com/bitbof/klecks)（MIT © bitbof，kleki.com 的官方开源版）
> 本仓库**不包含**上游代码，只包含：**Electron 外壳** + **两个补丁**（打到上游 `d705854` / 0.11.4.1 上）+ 文档与工装。
> 品牌说明：上游 MIT 不覆盖 "Kleki" 名称与标识，所以本产物一律叫 **Kleks**，且不随仓库分发任何上游图标（图标在构建时由上游 PNG 现场生成，见 `tools/make_icon.py`）。

---

## 主要成果（都是本机实测数字）

| 能力 | 做了什么 | 实测证据 |
| --- | --- | --- |
| **双击即用 / 离线** | Electron 外壳内置本地 http 服务器（127.0.0.1 随机端口）加载 `dist/`，因此保住了安全上下文 | `isSecureContext=true`、ServiceWorker `activated`、`showSaveFilePicker` 可用 |
| **磁盘自动保存** | 拦截 `will-download`，把上游自己的"保存"产物改道到 `Kleks-Data/autosave/`；定时 + 关闭前 + `Ctrl+Alt+S`；保留最近 10 份 | 自检真写出 PNG 33.7 KB / 50.5 KB，打开确认**里面有画的笔迹** |
| **双击图片打开** | HKCU 注册 `OpenWithProgids`（不抢默认程序）+ 单实例 + 命令行/拖拽打开，用「合成 drop 事件」交给上游导入流程 | winreg 核对 6 个扩展名全部注册成功；投喂 PNG 后上游导入对话框正确弹出 |
| **全局对称绘制**（补丁 0001） | 铅笔/素描/像素/橡皮走 Proxy 包装；**水彩/晕染/异形图形走笔刷内置对称**（同一实例、同一缓存、每帧一次写回，实时且交界不闪） | 镜像像素写入量 ×2.0（如 16300→32604）；不对称率 0.0099→0.0014（−86%）；关→开→再关同一会话回归通过 |
| **大画布渲染优化**（补丁 0002） | 每帧不再把整张 document 画布交给浏览器缩放，只绘制视口可见的源矩形 | 2K 画布下可见区仅 1165×873（≈整张的 25%）→ 合成成本降约 4 倍；缩放后截图确认无缺块/空条带 |
| **性能开关** | 启用 GPU 光栅化 / 零拷贝 / 忽略 GPU 黑名单 | 默认条件下帧间隔 16.7 ms（60 FPS），帧率探针量化 |
| **菜单栏 / 关闭体验** | 去掉 Electron 菜单栏并自接快捷键；接管 `will-prevent-unload`（否则点 X 关不掉窗口） | `isMenuBarVisible=false`；`closeTest=closed` |

## 硬件与环境

| 项 | 值 |
| --- | --- |
| 系统 | Windows 10，1920×1080 @96 DPI |
| CPU / 内存 / GPU | AMD Ryzen 7 5700X3D / 16 GB / RTX 4070 Ti 12 GB |
| Electron / Chromium | 40.10.2 / 144 |
| Node / npm | v24.20.0 / 11.19.0 |
| 上游基线 | `bitbof/klecks` @ `d705854`（2026-09-26，0.11.4.1） |
| 产物 | 便携目录 357 MB（Electron 运行时 340 MB + 应用 11 MB / 77 个静态文件） |

## 快速开始（Windows）

```bash
# 1) 取上游并切到补丁基线
git clone https://github.com/bitbof/klecks.git && cd klecks
git checkout d705854

# 2) 打补丁（两个，顺序无关）
git apply ../kleks-desktop/patches/0001-global-symmetry.patch
git apply ../kleks-desktop/patches/0002-visible-rect-render.patch

# 3) 构建网页产物
npm ci && npm run icon:build && npm run lang:build && npm run build   # → dist/

# 4) 组装便携版（不用 electron-builder）
#    Electron 的 win32 zip 解出来就是完整运行时：
#    删掉 resources/default_app.asar → 把 shell/main.js、shell/package.json、dist/ 放进 resources/app/
#    → electron.exe 改名为 Kleks.exe 即完成（无安装器、无注册表）
#    tools/pack_kleks.py 是本机用的自动化脚本（内含本机绝对路径，需按需修改）

# 5) 可选：注册"右键 → 打开方式 → Kleks"
Kleks.exe --register-file-assoc     # 取消：--unregister-file-assoc
```

自检（本机脚本，用来量化而不是靠感觉）：

```bash
Kleks.exe --smoke          # 页面就绪/画一笔/像素差/自动保存/打开文件/关闭 → smoke-result.json + 截图
Kleks.exe --probe-brushes  # 逐笔刷：帧间隔 + 像素变化（可配 KLEKS_SYM_H=1 / KLEKS_BRUSH_SIZE=200）
Kleks.exe --probe-perf     # 复现型压测：KLEKS_DOC=2000 KLEKS_BRUSH_SIZE=200
```

## 安装包（Windows）

`installer/kleks.nsi` 用 NSIS 3.x 生成 `Kleks-Setup-1.0.0.exe`：

- **按用户安装**（`%LOCALAPPDATA%\Programs\Kleks`），**不需要管理员权限、不弹 UAC**，可在向导里改路径；
- 向导里可选：**桌面快捷方式**（默认勾选）、开始菜单快捷方式、注册图片「打开方式」、装完立即启动；
- 写 Add/Remove Programs 卸载项（HKCU），自带 `Uninstall.exe`；
- **卸载默认保留** `Kleks-Data`（自动保存副本与设置），会先问一次；
- 支持自动化：`Kleks-Setup-1.0.0.exe /S /D=C:\path`（`/D` 必须最后且不能加引号）。

详见 `installer/README.md`。

## Android APK（手机端）

同一份网页产物打成手机 App：**WebView 外壳 + 内置本地服务器**（`http://127.0.0.1:<随机端口>`，保住安全上下文，ES 模块与 ServiceWorker 都能用），不依赖 androidx / Gradle。

- 包名 `com.satyr.astry.kleks`，`minSdk 24`（Android 7.0+），`targetSdk 34`，**APK 1.1 MB**
- 手机端补齐的能力：**导出图片存进「下载」**（Kleks 走 `blob:`，DownloadManager 抓不到 → 页面脚本转 base64 走原生桥，API 29+ 用 MediaStore 免权限写入）、系统文件选择器导入、沉浸式全屏 + 常亮、外链交系统浏览器
- 没有设备/模拟器时的验收范围：编译通过 + `apksigner verify`（v2/v3）+ `aapt2 dump badging` + APK 内网页文件与 dist **逐字节一致**（`verify_apk_assets.py`）。**未做真机运行测试**
- 源码、构建脚本与踩坑记录见 `android/README.md`

## 目录

```
shell/     Electron 外壳：main.js（服务器/窗口/自动保存/文件关联/自检）、perf-probe.js、package.json
patches/   0001 全局对称绘制；0002 视口可见区渲染优化（另有 README 说明取舍）
installer/ NSIS 安装包脚本（可选桌面/开始菜单快捷方式）+ build.py
android/   Android APK 工程（WebView + 本地服务器）+ build.py
tools/     pack_kleks.py（组装便携版）、make_icon.py（由上游 PNG 生成 ico）
docs/      总架构书（模块职责/缺陷清单/变更日志）、可行性报告、功能缺口分析
```

## 诚实的局限与负面结果

- **大笔刷仍然会偶发掉帧**：2K 画布 + 200 号笔刷实测 176 帧内有 1 帧 33 ms。根因在**画布回读**——收笔时要把被碰到的每块 256×256 瓦片 `getImageData` 出来存历史；晕染则是**每步**回读+写回脏区。这是上游"CPU canvas + 瓦片历史"架构的固有成本，本仓库**没有**修（改动面大，且需要重做验证）。小笔刷在同条件下 0 掉帧。
- **对称绘制的两组行为不一致**：水彩/晕染/异形图形由笔刷内置实现 → 一次撤销即可；铅笔/素描/像素/橡皮走外壳双实例包装 → **需要撤销两次**。且"双实例并发"这条路对"整层重合成"型笔刷会闪烁（已被水彩/晕染换成内置实现，其他此类笔刷若存在需同样处理）。
- **外挂镜像对异形图形无效**（它自带对称），必须走原生开关——这是踩过的坑。
- **剪切蒙版分组**仍会分配一张**整画布大小**的临时画布（未优化）；**多图层合成缓存**（只重画当前图层 + 缓存其他层）未实现。
- **未碰上游已知 critical bug**（合并图层丢层 #101、随机清空 #103、多图层混合毛刺 #163，官方标 not reproduced）——靠自动保存兜底，不硬修。
- **16 层硬上限**（`MAX_LAYERS = 16`）等上游结构性限制未改动。
- 自检的**缩放按钮点击在无头自动化下不生效**，所以补丁 0002 的收益是"按面积算术推算 + 缩放截图肉眼确认"，不是端到端实测的加速比。

## 许可

- 本仓库代码：**MIT**（© 2026 Satyr_Astry），见 `LICENSE`。
- 上游 Klecks：**MIT © bitbof**，见 `NOTICE.md`。补丁属于对上游作品的修改，同样以 MIT 分发。
- **"Kleki" 名称与标识不在上游 MIT 授权范围内**：因此本产物名为 Kleks，且仓库不分发上游图标/Logo（构建时现场生成）。若要对外提供带 Kleki 品牌的服务，需另行取得上游作者授权。
