// Kleks 桌面版 —— Electron 外壳 v2
//
// 设计要点（详见 docs/总架构书.md）：
//  1. 内置一个只监听 127.0.0.1 的静态服务器指向 dist/ —— 必须，否则 ES 模块被 CORS 拦、
//     ServiceWorker 与 showSaveFilePicker 因非安全上下文不可用，页面会白屏。
//  2. 无菜单栏；快捷键由 before-input-event 兜。
//  3. 自动保存：定时 / 关闭前 / Ctrl+Alt+S，用上游自己的导出流程写盘，不动上游代码。
//     两条路径都接管：
//        a) 默认路径 `<a download>` → session 的 will-download → setSavePath 到自动保存目录
//        b) 勾了"Show save dialog"的路径 showSaveFilePicker → 页面内 hook 成 POST 回本地服务器
//  4. 打开文件：命令行参数 / 单实例第二实例 / 拖拽，统一用「合成 drop 事件」交给上游的导入流程。
const { app, BrowserWindow, Menu, shell, dialog, session } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- 参数与路径

const argv = process.argv.slice(1);
const hasFlag = (f) => argv.includes(f);
const SMOKE = hasFlag('--smoke');
const REGISTER = hasFlag('--register-file-assoc');
const UNREGISTER = hasFlag('--unregister-file-assoc');
const DIST = path.join(__dirname, 'dist');

const AUTOSAVE_INTERVAL_MS = Number(process.env.KLEKS_AUTOSAVE_MS || 5 * 60 * 1000);
const AUTOSAVE_KEEP = Number(process.env.KLEKS_AUTOSAVE_KEEP || 10);
const AUTOSAVE_SETTLE_MS = 2500;   // 最后一个文件落地后再等这么久算完成
const AUTOSAVE_TIMEOUT_MS = 15000;

const OPENABLE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.psd'];
const MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.psd': 'image/vnd.adobe.photoshop',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8',
};

// 数据目录：便携优先（exe 同级 Kleks-Data），不可写则回落 userData
function resolveDataRoot() {
    const exeDir = path.dirname(app.getPath('exe'));
    const portable = path.join(exeDir, 'Kleks-Data');
    try {
        fs.mkdirSync(portable, { recursive: true });
        fs.accessSync(portable, fs.constants.W_OK);
        return portable;
    } catch {
        const fallback = app.getPath('userData');
        fs.mkdirSync(fallback, { recursive: true });
        return fallback;
    }
}
let DATA_ROOT = null;
const autosaveDir = () => path.join(DATA_ROOT || app.getPath('userData'), 'autosave');

// ---------------------------------------------------------------- 启动开关（必须在 ready 之前）

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// 注：不要加 CanvasOopRasterization —— 实测会打出 "GPU state invalid after WaitForGetOffsetInRange"
if (process.env.KLEKS_FORCE_SCALE) {
    app.commandLine.appendSwitch('force-device-scale-factor', process.env.KLEKS_FORCE_SCALE);
}

// ---------------------------------------------------------------- 状态

let win = null;
let mainPort = 0;
let mayClose = false;          // 用户确认退出后置真
let promptOpen = false;        // 关闭确认流程进行中
let forceAllowUnload = SMOKE;  // 自检时直接放行
let lastAutoSave = { time: 0, file: null };
let lastManualSaveTime = 0;
let autosaveArmedUntil = 0;    // 这段时间内的下载都算自动保存
let pendingAutoSave = null;    // { files: [], settleTimer, timeoutTimer, resolve }
const inbox = new Map();       // token -> 待导入文件的绝对路径（给页面 fetch 用）
const downloadLog = [];        // 诊断用：记录每次 will-download
const appLog = [];             // 诊断用：记录关键日志
function log(...a) {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    appLog.push(new Date().toISOString() + ' ' + line);
    console.log(line);
}

// ---------------------------------------------------------------- 本地服务器

function listDirHtml() {
    return '<!doctype html><meta charset=utf-8><title>Kleks</title><body style="font:14px system-ui;padding:20px">'
        + '<h3>Kleks 本地服务器</h3><p>这个端口只给 Kleks 自己用，不要关掉它。</p></body>';
}

// Chromium 的"不安全端口"黑名单（命中会 ERR_UNSAFE_PORT 直接打不开页面）。
// 随机端口偶尔会撞上，所以必须检查后重试。
const UNSAFE_PORTS = new Set([
    2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

function startServer() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const urlPath = decodeURIComponent(url.pathname);

        // —— 自动保存（showSaveFilePicker 被 hook 后走这里）——
        if (req.method === 'POST' && urlPath === '/__kleks_save') {
            const name = sanitizeName(url.searchParams.get('name') || 'autosave.png');
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                try {
                    const file = writeAutosaveFile(name, Buffer.concat(chunks));
                    noteAutoSaveFile(file);
                    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, file }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(e) }));
                }
            });
            return;
        }

        // —— 打开文件（页面 fetch 后合成 drop）——
        const inboxMatch = urlPath.match(/^\/__kleks_inbox\/([A-Za-z0-9-]+)$/);
        if (inboxMatch) {
            const file = inbox.get(inboxMatch[1]);
            if (!file || !fs.existsSync(file)) {
                res.writeHead(404).end('gone');
                return;
            }
            res.writeHead(200, {
                'Content-Type': MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream',
                'X-Kleks-Filename': encodeURIComponent(path.basename(file)),
            });
            fs.createReadStream(file).pipe(res);
            return;
        }

        if (urlPath === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(listDirHtml());
            return;
        }

        let rel = urlPath === '/' || urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath;
        const filePath = path.join(DIST, path.normalize(rel).replace(/^([/\\])+/, ''));
        if (!filePath.startsWith(DIST)) {
            res.writeHead(403).end('Forbidden');
            return;
        }
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404');
                return;
            }
            res.writeHead(200, {
                'Content-Type': MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'no-cache',
                'Service-Worker-Allowed': '/',
            });
            res.end(data);
        });
    });
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const tryListen = () => {
            attempts++;
            const onError = (e) => reject(e);
            server.once('error', onError);
            const wanted = Number(process.env.KLEKS_PORT || 0);
            server.listen(wanted, '127.0.0.1', () => {
                server.removeListener('error', onError);
                const port = server.address().port;
                if ((wanted === 0 && (port < 1024 || UNSAFE_PORTS.has(port))) && attempts < 40) {
                    log('[server] 端口 ' + port + ' 被 Chromium 列为不安全端口，换一个');
                    server.close(() => tryListen());
                    return;
                }
                log('[server] listening on 127.0.0.1:' + port);
                resolve(port);
            });
        };
        tryListen();
    });
}

// ---------------------------------------------------------------- 自动保存

function sanitizeName(name) {
    const base = path.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
    return base || 'autosave.png';
}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeAutosaveFile(name, buffer) {
    fs.mkdirSync(autosaveDir(), { recursive: true });
    const target = path.join(autosaveDir(), `auto-${stamp()}-${sanitizeName(name)}`);
    fs.writeFileSync(target, buffer);
    pruneAutosave();
    return target;
}

function pruneAutosave() {
    try {
        const files = fs.readdirSync(autosaveDir())
            .map((f) => ({ f, t: fs.statSync(path.join(autosaveDir(), f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
        files.slice(AUTOSAVE_KEEP).forEach(({ f }) => {
            try { fs.unlinkSync(path.join(autosaveDir(), f)); } catch { /* ignore */ }
        });
    } catch { /* ignore */ }
}

function noteAutoSaveFile(file) {
    lastAutoSave = { time: Date.now(), file };
    if (!pendingAutoSave) return;
    pendingAutoSave.files.push(file);
    clearTimeout(pendingAutoSave.settleTimer);
    pendingAutoSave.settleTimer = setTimeout(() => finishAutoSave(), AUTOSAVE_SETTLE_MS);
}

function finishAutoSave() {
    if (!pendingAutoSave) return;
    const p = pendingAutoSave;
    pendingAutoSave = null;
    clearTimeout(p.settleTimer);
    clearTimeout(p.timeoutTimer);
    p.resolve(p.files.length ? p.files : null);
}

// 触发上游的"保存"（Ctrl+S），并拦截产物落盘到自动保存目录
async function autosaveNow(reason) {
    if (pendingAutoSave) return pendingAutoSave.promise;
    if (!win || win.isDestroyed()) return null;
    const token = crypto.randomBytes(8).toString('hex');
    const promise = new Promise((resolve) => {
        pendingAutoSave = {
            files: [],
            resolve,
            settleTimer: null,
            timeoutTimer: setTimeout(() => finishAutoSave(), AUTOSAVE_TIMEOUT_MS),
            promise: null,
        };
    });
    pendingAutoSave.promise = promise;

    autosaveArmedUntil = Date.now() + AUTOSAVE_TIMEOUT_MS;
    try {
        // 1) 让 showSaveFilePicker 走 hook（用户把"Show save dialog"勾上时才会用到的路径）
        await win.webContents.executeJavaScript(
            `(() => { window.__kleksAutoArm = true; window.__kleksAutoToken = ${JSON.stringify(token)}; return true; })()`,
        );
        // 2) 发一次真键盘 Ctrl+S，触发上游 saveToComputer.save()
        await sendCtrlS();
        await win.webContents.executeJavaScript('(() => { window.__kleksAutoArm = false; return true; })()').catch(() => {});
    } catch (e) {
        finishAutoSave();
    }
    return promise;
}

async function sendCtrlS() {
    if (!win || win.isDestroyed()) return;
    try {
        if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
        const send = (params) => win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', params);
        // 必须发完整序列：上游的快捷键是「按下的键」组合出来的（comboStr），
        // 只发一个 ctrl=true 的 S 键，它只会看到 's'，匹配不上 'ctrl+s'。
        await send({ type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
        await send({ type: 'keyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 2 });
        await new Promise((r) => setTimeout(r, 60));
        await send({ type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 2 });
        await send({ type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 });
    } catch (e) {
        log('sendCtrlS failed: ' + e.message);
    }
}

function installAutosavePickerHook() {
    if (!win || win.isDestroyed()) return;
    // 脏标记：有真实交互才算"可能画了东西"。用它替代每 5 分钟一次的整窗截图指纹
    // （capturePage 是全帧回读，本身就是一次卡顿来源）。
    win.webContents.executeJavaScript(`(() => {
        window.__kleksDirty = false;
        window.__kleksDrawing = false;
        if (!window.__kleksDirtyHooked) {
            window.__kleksDirtyHooked = true;
            ['pointerdown','pointerup','pointermove','keydown','keyup','wheel','drop'].forEach((t) =>
                window.addEventListener(t, () => { window.__kleksDirty = true; }, true));
            // 落笔期间不要做自动保存（PNG 编码会占住主线程 → 画着画着顿一下）
            window.addEventListener('pointerdown', () => { window.__kleksDrawing = true; }, true);
            window.addEventListener('pointerup', () => { window.__kleksDrawing = false; }, true);
            window.addEventListener('pointercancel', () => { window.__kleksDrawing = false; }, true);
        }
        return true;
    })()`).catch(() => {});
    win.webContents.executeJavaScript(`(() => {
        if (window.__kleksPickerHooked) return true;
        window.__kleksPickerHooked = true;
        const orig = window.showSaveFilePicker ? window.showSaveFilePicker.bind(window) : null;
        window.showSaveFilePicker = async function (opts) {
            if (!window.__kleksAutoArm) return orig ? orig(opts) : Promise.reject(new Error('no picker'));
            const name = (opts && opts.suggestedName) || 'autosave.png';
            const token = window.__kleksAutoToken || '';
            return {
                name, kind: 'file',
                async createWritable() {
                    let blob = null;
                    return {
                        async write(data) { blob = data instanceof Blob ? data : new Blob([data]); },
                        async close() {
                            await fetch('/__kleks_save?name=' + encodeURIComponent(name) + '&token=' + token,
                                { method: 'POST', body: blob || new Blob() });
                        },
                        async abort() {},
                    };
                },
            };
        };
        return true;
    })()`).catch(() => {});
}

function startAutosaveTimer() {
    if (SMOKE || !(AUTOSAVE_INTERVAL_MS > 0)) return;
    setInterval(async () => {
        if (!win || win.isDestroyed()) return;
        // 只有"用户真的动过"才做自动保存，避免空转 + 避免整窗截图带来的周期性卡顿
        const dirty = await win.webContents
            .executeJavaScript('window.__kleksDirty === true')
            .catch(() => false);
        if (!dirty) return;
        // 正在落笔就跳过这一轮（PNG 编码在主线程，边画边存会顿一下），下一轮再说
        const drawing = await win.webContents
            .executeJavaScript('window.__kleksDrawing === true')
            .catch(() => false);
        if (drawing) return;
        await win.webContents.executeJavaScript('window.__kleksDirty = false').catch(() => {});
        const files = await autosaveNow('定时');
        if (files && files.length) log('[autosave] ' + files.join(', '));
    }, AUTOSAVE_INTERVAL_MS);
}

// 注：原来这里用"整窗截图指纹"判断画面有没有动过（capturePage + md5），
// 每 5 分钟一次全帧回读本身就是可感知的卡顿来源，已改成页面内的交互脏标记（见 installAutosavePickerHook）。

// ---------------------------------------------------------------- 打开文件（合成 drop）

function findOpenablePath(args) {
    for (const a of args) {
        if (typeof a !== 'string' || a.startsWith('-')) continue;
        try {
            if (fs.existsSync(a) && fs.statSync(a).isFile() && OPENABLE_EXT.includes(path.extname(a).toLowerCase())) {
                return path.resolve(a);
            }
        } catch { /* ignore */ }
    }
    return null;
}

async function openFileInWindow(filePath) {
    if (!win || win.isDestroyed()) return false;
    const token = crypto.randomBytes(8).toString('hex');
    inbox.set(token, path.resolve(filePath));
    try {
        return await win.webContents.executeJavaScript(`(async () => {
            const r = await fetch('/__kleks_inbox/${token}');
            if (!r.ok) return 'fetch-failed:' + r.status;
            const name = decodeURIComponent(r.headers.get('X-Kleks-Filename') || 'image');
            const blob = await r.blob();
            const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
            const dt = new DataTransfer();
            dt.items.add(file);
            window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
            return 'dropped:' + name + ':' + dt.files.length;
        })()`);
    } catch (e) {
        return 'error:' + e.message;
    } finally {
        setTimeout(() => inbox.delete(token), 30000);
    }
}

// ---------------------------------------------------------------- 文件关联（HKCU，可逆）

function registerFileAssociation() {
    const { execFileSync } = require('child_process');
    const exe = process.execPath;
    const progId = 'Kleks.Image';
    const reg = (...cmd) => execFileSync('reg', cmd, { stdio: 'pipe' });
    reg('add', `HKCU\\Software\\Classes\\${progId}`, '/ve', '/d', 'Kleks 图片', '/f');
    reg('add', `HKCU\\Software\\Classes\\${progId}\\DefaultIcon`, '/ve', '/d', `${exe},0`, '/f');
    reg('add', `HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, '/ve', '/d', `"${exe}" "%1"`, '/f');
    reg('add', `HKCU\\Software\\Classes\\Applications\\Kleks.exe\\shell\\open\\command`, '/ve', '/d', `"${exe}" "%1"`, '/f');
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.psd']) {
        reg('add', `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids`, '/v', progId, '/t', 'REG_NONE', '/f');
    }
    console.log('已注册：右键图片 → 打开方式 里会出现 Kleks（未改动当前默认程序）');
    console.log('想设为默认：Windows 设置 → 应用 → 默认应用 → 按文件类型 → 选 Kleks');
}

function unregisterFileAssociation() {
    const { execFileSync } = require('child_process');
    const reg = (...cmd) => { try { execFileSync('reg', cmd, { stdio: 'pipe' }); } catch { /* ignore */ } };
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.psd']) {
        reg('delete', `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids`, '/v', 'Kleks.Image', '/f');
    }
    reg('delete', 'HKCU\\Software\\Classes\\Kleks.Image', '/f');
    reg('delete', 'HKCU\\Software\\Classes\\Applications\\Kleks.exe', '/f');
    console.log('已取消注册');
}

// ---------------------------------------------------------------- 菜单栏为空 + 快捷键

function installShortcuts(w) {
    w.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const key = (input.key || '').toLowerCase();
        if (key === 'f5' || (input.control && key === 'r' && !input.shift)) {
            w.webContents.reload();
            event.preventDefault();
        } else if (input.control && input.shift && key === 'r') {
            w.webContents.reloadIgnoringCache();
            event.preventDefault();
        } else if (key === 'f12') {
            w.webContents.toggleDevTools();
            event.preventDefault();
        } else if (key === 'f11') {
            w.setFullScreen(!w.isFullScreen());
            event.preventDefault();
        } else if (input.control && input.alt && key === 's') {
            // 手动触发一次「存到自动保存目录」
            event.preventDefault();
            autosaveNow('手动').then((files) => {
                if (files && files.length) {
                    shell.openPath(path.dirname(files[0]));
                }
            });
        }
    });
}

// ---------------------------------------------------------------- 关闭流程

async function runCloseFlow(reason) {
    const files = await autosaveNow(reason);
    const where = files && files.length ? files[0] : null;
    const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Kleks',
        message: '要退出吗？这幅画还有没手动保存的改动',
        detail: where
            ? `已经自动存了一份副本：\n${where}\n\n想放到自己指定的文件夹，就点「取消」，再用 Ctrl+S 或「文件 → 保存」。`
            : '自动保存没有成功（可能是空画布或保存被拦住了）。想保留的话请点「取消」，然后 Ctrl+S 手动保存。',
        buttons: ['仍然退出', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
    });
    promptOpen = false;
    if (response === 0) {
        mayClose = true;
        win.close();
    }
}

// ---------------------------------------------------------------- 诊断

async function probe() {
    const out = { startedAt: new Date().toISOString() };
    const ready = await waitForAppReady();
    out.ready = ready;
    await new Promise((r) => setTimeout(r, 1500));
    out.buttons = await win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).map(b => (b.title || b.getAttribute('aria-label') || b.innerText || '').trim()).filter(Boolean).slice(0, 60)`,
    );
    out.importButtons = await win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[class*=tab], [class*=button]')).map(b => (b.title || b.innerText || '').trim()).filter(Boolean).slice(0, 60)`,
    );
    // 键盘事件是否真的到达页面
    await win.webContents.executeJavaScript(
        `(() => { window.__probe = { keydown: 0, combo: [] };
           document.addEventListener('keydown', (e) => { window.__probe.keydown++; window.__probe.combo.push(e.key + '|ctrl=' + e.ctrlKey + '|code=' + e.code); }, true);
           return true; })()`,
    );
    const before = downloadLog.length;
    autosaveArmedUntil = Date.now() + 15000;
    await win.webContents.executeJavaScript(
        `(() => { window.__kleksAutoArm = true; window.__kleksAutoToken = 'probe'; return true; })()`,
    );
    await sendCtrlS();
    await new Promise((r) => setTimeout(r, 4000));
    out.keyEvents = await win.webContents.executeJavaScript('window.__probe');
    out.downloads = downloadLog.slice(before);
    out.autosaveFiles = fs.existsSync(autosaveDir()) ? fs.readdirSync(autosaveDir()) : [];
    out.autosaveDir = autosaveDir();
    out.log = appLog.slice(-40);
    fs.writeFileSync(path.join(__dirname, 'probe-result.json'), JSON.stringify(out, null, 2));
    console.log('PROBE_RESULT ' + JSON.stringify(out));
    app.exit(0);
}

// 任何未捕获的 Promise 异常都要留痕，并且不允许"活着但不干活"的僵尸进程
process.on('unhandledRejection', (e) => {
    log('[unhandledRejection] ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
});
process.on('uncaughtException', (e) => {
    log('[uncaughtException] ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
});

// ---------------------------------------------------------------- 诊断：逐笔刷检查（对称补丁是否弄坏了某几个笔刷）

async function brushProbe() {
    const out = { at: new Date().toISOString(), brushes: {}, errors: [] };
    const writeProbe = () => fs.writeFileSync(path.join(__dirname, 'brush-probe.json'), JSON.stringify(out, null, 2));

    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        if (level >= 2) out.errors.push(`[console:${level}] ${message} (${String(sourceId).slice(-40)}:${line})`);
        writeProbe();
    });
    await win.webContents.executeJavaScript(
        `(() => {
            window.__err = [];
            const fmt = (m, st) => String(m) + ' // ' + String(st || '').split(String.fromCharCode(10)).slice(0, 5).join(' <- ');
            window.addEventListener('error', (e) => window.__err.push(fmt(e.message, e.error && e.error.stack)));
            window.addEventListener('unhandledrejection', (e) => window.__err.push('rej: ' + fmt(e.reason, e.reason && e.reason.stack)));
            return true;
        })()`,
    );

    const ready = await waitForAppReady();
    out.ready = ready;
    // KLEKS_SYM_H / KLEKS_SYM_V：先打开对称再测（走真实路径：localStorage → 重载）
    if (process.env.KLEKS_SYM_H === '1' || process.env.KLEKS_SYM_V === '1') {
        await win.webContents.executeJavaScript(
            `localStorage.setItem('kl-symmetry-horizontal', ${JSON.stringify(process.env.KLEKS_SYM_H === '1' ? 'true' : 'false')});
             localStorage.setItem('kl-symmetry-vertical', ${JSON.stringify(process.env.KLEKS_SYM_V === '1' ? 'true' : 'false')});
             true`,
        );
        await win.webContents.reload();
        await waitForAppReady();
        out.symmetryOn = { h: process.env.KLEKS_SYM_H === '1', v: process.env.KLEKS_SYM_V === '1' };
    }
    await new Promise((r) => setTimeout(r, 1500));
    win.focus();
    win.webContents.focus();
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    const dispatch = (p) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', p);

    // 找出笔刷切换按钮：先按 title 找，再爬到可点击祖先，用其矩形中心点
    const brushNames = ['画笔', '水彩刷', '素描笔', '像素化', '异形图形', '晕染', '橡皮擦'];
    const tabInfo = await win.webContents.executeJavaScript(
        `(() => {
            const names = ${JSON.stringify(brushNames)};
            const out = { titled: [], clicked: {} };
            document.querySelectorAll('[title]').forEach((el) => {
                const t = el.getAttribute('title') || '';
                if (names.some((n) => t.includes(n))) {
                    out.titled.push({ title: t, tag: el.tagName, cls: String(el.className).slice(0, 40) });
                }
            });
            // 对每个笔刷名，优先取自身就是 tabrow__tab 的元素；否则向上找可点击祖先
            names.forEach((n) => {
                const cands = Array.from(document.querySelectorAll('[title]')).filter((el) => (el.getAttribute('title') || '').includes(n));
                const own = cands.find((el) => /tabrow__tab/.test(String(el.className || '')));
                const list = own ? [own, ...cands.filter((c) => c !== own)] : cands;
                for (const el of list) {
                    let node = el;
                    for (let i = 0; i < 4 && node; i++) {
                        const cls = String(node.className || '');
                        if (/tab|button|row/i.test(cls) || node.tagName === 'BUTTON') {
                            const r = node.getBoundingClientRect();
                            if (r.width > 4 && r.height > 4 && r.top >= 0 && r.left >= 0) {
                                out.clicked[n] = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), cls: cls.slice(0, 40) };
                                return;
                            }
                        }
                        node = node.parentElement;
                    }
                }
            });
            return out;
        })()`,
    );
    out.tabs = tabInfo;

    // 全分辨率快照/比对放在页面里做（只回传一个数字），避免采样漏掉细微变化
    const snapshotCanvas = async () => {
        await win.webContents.executeJavaScript(
            `(() => {
                const c = Array.from(document.querySelectorAll('canvas')).find((x) => x.width >= 200 && x.height >= 200);
                if (!c) { window.__snapData = null; return false; }
                window.__snapCanvas = c;
                try { window.__snapData = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; } catch (e) { window.__snapData = null; }
                return !!window.__snapData;
            })()`,
        );
        return true;
    };
    const diffSnapshot = async () => win.webContents.executeJavaScript(
        `(() => {
            const c = window.__snapCanvas;
            if (!c || !window.__snapData) return -1;
            let d;
            try { d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; } catch (e) { return -2; }
            const a = window.__snapData;
            let changed = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (a[i] !== d[i] || a[i + 1] !== d[i + 1] || a[i + 2] !== d[i + 2] || a[i + 3] !== d[i + 3]) changed++;
            }
            return changed;
        })()`,
    );
    const measureInk = snapshotCanvas;

    let index = 0;
    // 可选：先把笔刷调大（KLEKS_BRUSH_SIZE=200），复现"大笔刷"卡顿条件
    if (process.env.KLEKS_BRUSH_SIZE) {
        const target = Number(process.env.KLEKS_BRUSH_SIZE);
        const readSize = () => win.webContents.executeJavaScript(
            `(() => { const m = (document.body.innerText || '').match(/画笔大小\\s*([0-9.]+)/); return m ? Number(m[1]) : null; })()`,
        );
        const sendKey = async (key, code, vk) => {
            if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
            await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
            await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        };
        let cur = await readSize();
        for (let i = 0; i < 80 && cur !== null && cur < target; i++) {
            await sendKey(']', 'BracketRight', 221);
            await new Promise((r) => setTimeout(r, 60));
            cur = await readSize();
        }
        out.brushSize = cur;
        // 抖动修正控件长什么样（诊断）
        out.stabilizerEl = await win.webContents.executeJavaScript(
            `(() => { const el = document.querySelector('[name="stabilizer-strength"]'); return el ? { tag: el.tagName, cls: String(el.className).slice(0, 60), html: el.outerHTML.slice(0, 200) } : 'not-found'; })()`,
        );
    }
    for (const name of brushNames) {
        const entry = { clicked: false, changedPixels: 0, jsErrors: [] };
        try {
            const b = win.getContentBounds();
            // 每个笔刷画在不同的高度，避免笔画互相覆盖导致差值失真
            const y = Math.round(b.height * (0.12 + index * 0.1));
            index++;
            const x1 = Math.round(b.width * 0.2);
            const x2 = Math.round(b.width * 0.35);

            // 清空本轮的页面错误记录
            await win.webContents.executeJavaScript('window.__err = []; true');
            // 帧率探针：记录这一笔期间的帧间隔
            await win.webContents.executeJavaScript(
                `(() => {
                    window.__frames = [];
                    let last = performance.now();
                    const tick = (t) => { window.__frames.push(t - last); last = t; window.__rafOn = requestAnimationFrame(tick); };
                    window.__rafOn = requestAnimationFrame(tick);
                    return true;
                })()`,
            );

            // 晕染/水彩需要底下有颜色才能看出效果：先用画笔铺一块
            if (name === '晕染' || name === '水彩刷') {
                const penTab = tabInfo.clicked['画笔'];
                if (penTab) {
                    await dispatch({ type: 'mousePressed', x: penTab.x, y: penTab.y, button: 'left', buttons: 1, clickCount: 1 });
                    await dispatch({ type: 'mouseReleased', x: penTab.x, y: penTab.y, button: 'left', buttons: 0, clickCount: 1 });
                    await new Promise((r) => setTimeout(r, 600));
                    for (let k = 0; k < 3; k++) {
                        const yy = y + k * 12;
                        await dispatch({ type: 'mousePressed', x: x1, y: yy, button: 'left', buttons: 1, clickCount: 1 });
                        for (let i = 1; i <= 15; i++) {
                            await dispatch({ type: 'mouseMoved', x: Math.round(x1 + ((x2 - x1) * i) / 15), y: yy, button: 'left', buttons: 1 });
                            await new Promise((r) => setTimeout(r, 12));
                        }
                        await dispatch({ type: 'mouseReleased', x: x2, y: yy, button: 'left', buttons: 0, clickCount: 1 });
                    }
                    await new Promise((r) => setTimeout(r, 600));
                }
            }

            const hit = tabInfo.clicked[name];
            if (hit) {
                await dispatch({ type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', buttons: 1, clickCount: 1 });
                await dispatch({ type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', buttons: 0, clickCount: 1 });
                entry.clicked = true;
                entry.hitCls = hit.cls;
            }
            await new Promise((r) => setTimeout(r, 800));
            entry.inkBefore = await measureInk();
            await dispatch({ type: 'mousePressed', x: x1, y, button: 'left', buttons: 1, clickCount: 1 });
            for (let i = 1; i <= 25; i++) {
                await dispatch({ type: 'mouseMoved', x: Math.round(x1 + ((x2 - x1) * i) / 25), y: y + Math.round(Math.sin(i / 4) * 20), button: 'left', buttons: 1 });
                await new Promise((r) => setTimeout(r, 16));
            }
            await dispatch({ type: 'mouseReleased', x: x2, y, button: 'left', buttons: 0, clickCount: 1 });
            await new Promise((r) => setTimeout(r, 1200));
            entry.changedPixels = await diffSnapshot();
            entry.frames = await win.webContents.executeJavaScript(
                `(() => {
                    cancelAnimationFrame(window.__rafOn);
                    const f = window.__frames.slice(2);
                    if (!f.length) return null;
                    const sorted = [...f].sort((a, b) => a - b);
                    return {
                        n: f.length,
                        avgMs: +(f.reduce((a, b) => a + b, 0) / f.length).toFixed(1),
                        p95Ms: +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(1),
                        maxMs: +sorted[sorted.length - 1].toFixed(1),
                    };
                })()`,
            );
            entry.jsErrors = await win.webContents.executeJavaScript('window.__err.slice(0, 3)');
            entry.active = await win.webContents.executeJavaScript(
                `(() => { const a = document.querySelector('[class*=brush-tab][class*=active], [class*=active][class*=brush]'); return a ? a.textContent.trim().slice(0, 12) : null; })()`,
            );
        } catch (e) {
            entry.error = String(e.message);
        }
        out.brushes[name] = entry;
        writeProbe();
    }
    out.errorLog = out.errors.slice(-10);
    writeProbe();
    console.log('BRUSH_PROBE ' + JSON.stringify(out.brushes));
    app.exit(0);
}

// ---------------------------------------------------------------- 主流程

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', (_e, argv2) => {
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
            const p = findOpenablePath(argv2.slice(1));
            if (p) openFileInWindow(p).then((r) => console.log('[open] ' + r));
        }
    });
}

app.whenReady().then(async () => {
    DATA_ROOT = resolveDataRoot();
    fs.mkdirSync(autosaveDir(), { recursive: true });

    if (REGISTER) { registerFileAssociation(); app.quit(); return; }
    if (UNREGISTER) { unregisterFileAssociation(); app.quit(); return; }

    Menu.setApplicationMenu(null); // 不要菜单栏
    mainPort = await startServer();

    win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        backgroundColor: '#2b2b2b',
        title: 'Kleks',
        icon: path.join(__dirname, 'klecks-icon.ico'),
        autoHideMenuBar: true,
        show: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    win.setMenuBarVisibility(false);
    installShortcuts(win);

    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // —— 下载拦截：自动保存期内的下载落到自动保存目录，其余交回系统（原生另存为对话框）——
    session.defaultSession.on('will-download', (_event, item) => {
        const isAutosave = Date.now() < autosaveArmedUntil;
        downloadLog.push({
            at: new Date().toISOString(),
            filename: item.getFilename(),
            mime: item.getMimeType(),
            url: item.getURL().slice(0, 60),
            autosave: isAutosave,
        });
        log('[download] ' + item.getFilename() + ' autosave=' + isAutosave);
        if (isAutosave) {
            try {
                const target = path.join(autosaveDir(), `auto-${stamp()}-${sanitizeName(item.getFilename())}`);
                fs.mkdirSync(autosaveDir(), { recursive: true });
                item.setSavePath(target);
                item.once('done', (_e2, state) => {
                    if (state === 'completed') { pruneAutosave(); noteAutoSaveFile(target); }
                    else { log('[autosave] download state: ' + state); noteAutoSaveFile(target); }
                });
            } catch (e) {
                log('[autosave] setSavePath failed: ' + e.message);
            }
        } else {
            item.once('done', (_e2, state) => {
                log('[download] manual done state=' + state + ' path=' + item.getSavePath());
                if (state === 'completed') lastManualSaveTime = Date.now();
            });
        }
    });

    // —— 关闭保护 ——
    // 1) 我们自己的记账：自动保存比手动保存新 → 说明有只存在于自动保存里的改动
    win.on('close', (e) => {
        if (mayClose || SMOKE) return;
        if (lastAutoSave.time > lastManualSaveTime && lastAutoSave.time > 0) {
            e.preventDefault();
            if (!promptOpen) {
                promptOpen = true;
                runCloseFlow('关闭前');
            }
        }
    });
    // 2) 页面自己的防退出（有未保存改动时注册的 beforeunload）
    win.webContents.on('will-prevent-unload', (event) => {
        if (mayClose || forceAllowUnload) {
            event.preventDefault(); // 允许关闭
            return;
        }
        // 不 preventDefault → 本次关闭被取消；窗口留下，我们走异步确认流程
        if (!promptOpen) {
            promptOpen = true;
            runCloseFlow('页面未保存');
        }
    });

    try {
        await win.loadURL(`http://127.0.0.1:${mainPort}/index.html`);
    } catch (e) {
        // 加载失败（端口被拒 / 缓存被占 / dist 缺失）绝不能留一个"活着但不干活"的僵尸窗口
        log('[fatal] loadURL failed: ' + e.message);
        dialog.showErrorBox('Kleks 启动失败', '无法加载本地页面：\n' + e.message + '\n\n端口：' + mainPort);
        app.exit(1);
        return;
    }
    installAutosavePickerHook();

    if (SMOKE) {
        await runSmokeTests();
    } else if (hasFlag('--probe')) {
        log('[probe] start');
        await probe();
    } else if (hasFlag('--probe-brushes')) {
        log('[probe-brushes] start');
        await brushProbe();
    } else if (hasFlag('--probe-perf')) {
        log('[probe-perf] start');
        const makePerfProbe = require('./perf-probe');
        await makePerfProbe({ win, app, fs, path, waitForAppReady })();
    } else {
        startAutosaveTimer();
        const p = findOpenablePath(argv);
        if (p) {
            await waitForAppReady();
            console.log('[open] ' + (await openFileInWindow(p)));
        }
    }
});

function waitForAppReady() {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const tick = async () => {
            if (!win || win.isDestroyed()) return resolve(false);
            let ready = false;
            try {
                ready = await win.webContents.executeJavaScript(
                    `!!document.querySelector('canvas') && !document.getElementById('loading-screen')`,
                );
            } catch { /* ignore */ }
            if (ready || Date.now() - t0 > 40000) return resolve(ready);
            setTimeout(tick, 500);
        };
        tick();
    });
}

// ---------------------------------------------------------------- 自检

async function runSmokeTests() {
    const outFile = process.env.KLEKS_SMOKE_OUT || path.join(__dirname, 'smoke-result.json');
    const result = { startedAt: new Date().toISOString() };
    const write = () => fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

    const ready = await waitForAppReady();
    result.ready = ready;
    await new Promise((r) => setTimeout(r, 2000));

    result.page = await win.webContents.executeJavaScript(
        `(() => ({
            title: document.title,
            canvases: document.querySelectorAll('canvas').length,
            canvasSize: (() => { const c = document.querySelector('canvas'); return c ? c.width + 'x' + c.height : null; })(),
            buttons: document.querySelectorAll('button').length,
            layersPanel: !!document.querySelector('[class*=layer]'),
            hasLoadingScreen: !!document.getElementById('loading-screen'),
            secure: window.isSecureContext,
            savePicker: 'showSaveFilePicker' in window,
            pickerHooked: !!window.__kleksPickerHooked,
            devicePixelRatio: window.devicePixelRatio,
        }))()`,
    );
    result.menuBarVisible = win.isMenuBarVisible();
    result.applicationMenu = Menu.getApplicationMenu() === null ? null : 'present';
    result.switches = ['gpu-rasterization', 'zero-copy', 'ignore-gpu-blocklist'];
    result.argvFile = findOpenablePath(argv);
    result.dataRoot = DATA_ROOT;
    result.autosaveDir = autosaveDir();
    result.deviceScaleFactor = win.webContents.getZoomFactor();
    write();

    // ① 真实画笔输入
    try {
        // 先让窗口拿到焦点：画板在没有文档焦点时可能不吃拖拽（实测差异明显）
        win.focus();
        win.webContents.focus();
        await new Promise((r) => setTimeout(r, 600));
        const undoState = () => win.webContents.executeJavaScript(
            `(() => {
                const b = document.querySelector('[title="Undo"]') || document.querySelector('[title="撤销"]');
                if (!b) return null;
                return { disabled: b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true', cls: b.className };
            })()`,
        );
        const undoBefore = await undoState();
        const before = (await win.webContents.capturePage()).toBitmap();
        if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
        const dispatch = (params) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', params);
        const b = win.getContentBounds();
        const y = Math.round(b.height * 0.45);
        const x1 = Math.round(b.width * 0.25);
        const x2 = Math.round(b.width * 0.75);
        const diag = await win.webContents.executeJavaScript(
            `(() => {
                window.__dbg = { down: 0, move: 0, up: 0 };
                ['pointerdown','pointermove','pointerup'].forEach(t => document.addEventListener(t, () => window.__dbg[t.replace('pointer','')]++, true));
                const el = document.elementFromPoint(${x1}, ${y});
                return el ? el.tagName + '.' + (el.className || '') : null;
            })()`,
        );
        await dispatch({ type: 'mousePressed', x: x1, y, button: 'left', buttons: 1, clickCount: 1 });
        await new Promise((r) => setTimeout(r, 150));
        for (let i = 1; i <= 40; i++) {
            await dispatch({
                type: 'mouseMoved',
                x: Math.round(x1 + ((x2 - x1) * i) / 40),
                y: y + Math.round(Math.sin(i / 5) * 40),
                button: 'left',
                buttons: 1,
            });
            await new Promise((r) => setTimeout(r, 16));
        }
        await new Promise((r) => setTimeout(r, 100));
        await dispatch({ type: 'mouseReleased', x: x2, y, button: 'left', buttons: 0, clickCount: 1 });
        await new Promise((r) => setTimeout(r, 1200));
        const undoAfter = await undoState();
        const after = (await win.webContents.capturePage()).toBitmap();
        let changed = 0;
        const len = Math.min(before.length, after.length);
        for (let i = 0; i < len; i += 4) if (before[i] !== after[i]) changed++;
        result.drawTest = {
            pixelsChanged: changed,
            changedPercent: +(100 * changed / (len / 4)).toFixed(2),
            changedMoreThan0: changed > 500,
            undoBefore,
            undoAfter,
            events: await win.webContents.executeJavaScript('window.__dbg'),
            hitElement: diag,
        };
        fs.writeFileSync(path.join(__dirname, 'smoke-screenshot.png'), (await win.webContents.capturePage()).toPNG());
    } catch (e) {
        result.drawTest = 'error: ' + e.message;
    }
    write();

    // ② 全局对称绘制（本项目补丁 P1）：
    //   A 关 → 画；B 点界面的勾选框打开（同一会话，不重载）→ 画；C 再点一次关掉 → 画。
    //   C 这一步就是"关了关不掉"的回归测试。
    try {
        const measureSymmetry = (yFrac = 0.5) => win.webContents.executeJavaScript(
            `(() => {
                const out = [];
                document.querySelectorAll('canvas').forEach((c, i) => {
                    if (c.width < 200 || c.height < 200) return;
                    const ctx = c.getContext('2d');
                    if (!ctx) return;
                    let data;
                    try { data = ctx.getImageData(0, 0, c.width, c.height).data; } catch (e) { out.push({ i, err: 'tainted' }); return; }
                    const W = c.width, H = c.height;
                    const bg = [data[0], data[1], data[2]];
                    // 只看这一笔画所在的横带，避免被之前几笔的对称性污染
                    const y0 = Math.max(0, Math.round(H * ${yFrac} - 90));
                    const y1 = Math.min(H, Math.round(H * ${yFrac} + 90));
                    let sampled = 0, diff = 0, nonBg = 0;
                    for (let y = y0; y < y1; y += 2) {
                        for (let x = 0; x < Math.floor(W / 2); x += 2) {
                            const p1 = ((y * W) + x) * 4;
                            const p2 = ((y * W) + (W - 1 - x)) * 4;
                            sampled++;
                            const d = Math.max(
                                Math.abs(data[p1] - data[p2]),
                                Math.abs(data[p1 + 1] - data[p2 + 1]),
                                Math.abs(data[p1 + 2] - data[p2 + 2]),
                            );
                            if (d > 30) diff++;
                            if (Math.abs(data[p1] - bg[0]) + Math.abs(data[p1 + 1] - bg[1]) + Math.abs(data[p1 + 2] - bg[2]) > 30) nonBg++;
                        }
                    }
                    out.push({ i, w: W, h: H, sampled, diff, nonBg, asymRatio: +(diff / sampled).toFixed(4) });
                });
                return out;
            })()`,
        );
        const drawStroke = async (yFrac = 0.35) => {
            if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
            const dispatch = (params) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', params);
            const b = win.getContentBounds();
            const y = Math.round(b.height * yFrac);
            const x1 = Math.round(b.width * 0.30);
            const x2 = Math.round(b.width * 0.45);
            await dispatch({ type: 'mousePressed', x: x1, y, button: 'left', buttons: 1, clickCount: 1 });
            for (let i = 1; i <= 30; i++) {
                await dispatch({
                    type: 'mouseMoved',
                    x: Math.round(x1 + ((x2 - x1) * i) / 30),
                    y: y + Math.round(Math.sin(i / 4) * 30),
                    button: 'left',
                    buttons: 1,
                });
                await new Promise((r) => setTimeout(r, 16));
            }
            await dispatch({ type: 'mouseReleased', x: x2, y, button: 'left', buttons: 0, clickCount: 1 });
            await new Promise((r) => setTimeout(r, 1200));
        };

        result.symmetryTest = {};
        const clickSymCheckbox = (name) => win.webContents.executeJavaScript(
            `(() => {
                const el = document.querySelector('input[name="${name}"]');
                if (!el) return 'not-found';
                el.click();
                return el.checked;
            })()`,
        );
        // A：默认关 → 画一笔在 0.25 高度
        await drawStroke(0.25);
        result.symmetryTest.offBefore = await measureSymmetry(0.25);
        // B：点真实勾选框打开（不重载，走运行时路径）→ 画一笔在 0.45
        result.symmetryTest.checkboxAfterOn = await clickSymCheckbox('symmetry-horizontal');
        await new Promise((r) => setTimeout(r, 500));
        await drawStroke(0.45);
        result.symmetryTest.on = await measureSymmetry(0.45);
        fs.writeFileSync(path.join(__dirname, 'smoke-symmetry.png'), (await win.webContents.capturePage()).toPNG());
        // C：再点一次关掉（同一会话）→ 画一笔在 0.65。这一步必须重新变回"不对称"
        result.symmetryTest.checkboxAfterOff = await clickSymCheckbox('symmetry-horizontal');
        await new Promise((r) => setTimeout(r, 500));
        await drawStroke(0.65);
        result.symmetryTest.offAfter = await measureSymmetry(0.65);
        // 顺带验证 P2（只绘制可见区）在缩放后不出错：缩小几次再截图
        try {
            const zoomOut = await win.webContents.executeJavaScript(
                `(() => {
                    const el = Array.from(document.querySelectorAll('[title]')).find((e) => (e.getAttribute('title') || '') === '放大');
                    if (!el) return 'not-found';
                    const r = el.getBoundingClientRect();
                    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
                })()`,
            );
            if (zoomOut && zoomOut.x !== undefined) {
                for (let i = 0; i < 3; i++) {                    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: zoomOut.x, y: zoomOut.y, button: 'left', buttons: 1, clickCount: 1 });
                    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: zoomOut.x, y: zoomOut.y, button: 'left', buttons: 0, clickCount: 1 });
                    await new Promise((r) => setTimeout(r, 400));
                }
                await new Promise((r) => setTimeout(r, 800));
                fs.writeFileSync(path.join(__dirname, 'smoke-zoomout.png'), (await win.webContents.capturePage()).toPNG());
                const vr = await win.webContents.executeJavaScript('window.__kleksVisibleRect || null');
                if (vr) {
                    const srcArea = vr.width * vr.height;
                    const docArea = vr.docWidth * vr.docHeight;
                    result.visibleRectTest = {
                        note: '缩小 3 次后：每帧只需要绘制这块源区域',
                        visible: `${vr.width}x${vr.height}`,
                        document: `${vr.docWidth}x${vr.docHeight}`,
                        layers: vr.layers,
                        sourceAreaRatio: +(srcArea / docArea).toFixed(3),
                    };
                } else {
                    result.visibleRectTest = 'captured (smoke-zoomout.png), no metrics';
                }
            } else {
                result.visibleRectTest = 'zoom-out button not found';
            }
        } catch (e) {
            result.visibleRectTest = 'error: ' + e.message;
        }
    } catch (e) {
        result.symmetryTest = 'error: ' + e.message;
    }
    write();
    try {
        const files = await autosaveNow('自检');
        result.autosaveTest = {
            files: files || [],
            exists: (files || []).map((f) => fs.existsSync(f)),
            bytes: (files || []).map((f) => (fs.existsSync(f) ? fs.statSync(f).size : 0)),
        };
    } catch (e) {
        result.autosaveTest = 'error: ' + e.message;
    }
    write();

    // ③ 打开文件：走「合成 drop」导入流程
    try {
        const samplePath = findOpenablePath(argv) || path.join(DIST, fs.readdirSync(DIST).find((f) => f.startsWith('klecks-icon') && f.endsWith('.png')));
        const beforeImported = await win.webContents.executeJavaScript(
            `(() => ({ modals: document.querySelectorAll('[class*=modal]').length, canvases: document.querySelectorAll('canvas').length }))()`,
        );
        const dropped = await openFileInWindow(samplePath);
        await new Promise((r) => setTimeout(r, 2500));
        const afterImported = await win.webContents.executeJavaScript(
            `(() => ({
                modals: document.querySelectorAll('[class*=modal]').length,
                bodyHasAsLayer: document.body.innerText.includes('As Layer') || document.body.innerText.includes('作为图层'),
                text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120),
            }))()`,
        );
        result.openFileTest = { sample: path.basename(samplePath), dropped, before: beforeImported, after: afterImported };
        // 关掉导入对话框，别让它挡住后面的关闭测试
        await win.webContents.executeJavaScript(
            `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
        );
        await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
        result.openFileTest = 'error: ' + e.message;
    }
    write();

    // ④ 关闭测试
    const closedPromise = new Promise((r) => win.once('closed', () => r(true)));
    win.close();
    const closed = await Promise.race([closedPromise, new Promise((r) => setTimeout(() => r(false), 6000))]);
    result.closeTest = closed ? 'closed' : 'BLOCKED';
    write();
    console.log('SMOKE_RESULT ' + JSON.stringify(result));
    app.exit(0);
}

app.on('window-all-closed', () => { if (!SMOKE) app.quit(); });
