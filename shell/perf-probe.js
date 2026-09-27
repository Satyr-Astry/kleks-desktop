// 复现主人的卡顿条件：大画布 + 大笔刷 + 抖动修正 + 多图层
// 用法：KLEKS_DOC=2000 KLEKS_LAYERS=5 KLEKS_BRUSH_SIZE=200 Kleks.exe --probe-perf
module.exports = function makePerfProbe({ win, app, fs, path, waitForAppReady }) {
    return async function perfProbe() {
    const out = { at: new Date().toISOString() };
    const writeOut = () => fs.writeFileSync(path.join(__dirname, 'perf-probe.json'), JSON.stringify(out, null, 2));
    const D = win.webContents.debugger;
    if (!D.isAttached()) D.attach('1.3');
    const dispatch = (p) => D.sendCommand('Input.dispatchMouseEvent', p);
    const key = async (k, code, vk) => {
        await D.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await D.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    };
    const clickEl = async (selectorJs) => {
        const r = await win.webContents.executeJavaScript(
            `(() => { const el = ${selectorJs}; if (!el) return null; const b = el.getBoundingClientRect(); if (b.width < 3) return null; return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`,
        );
        if (!r) return false;
        await dispatch({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
        await dispatch({ type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
        return true;
    };
    const docInfo = () => win.webContents.executeJavaScript('window.__kleksVisibleRect || null');
    const readSize = () => win.webContents.executeJavaScript(
        `(() => { const m = (document.body.innerText || '').match(/画笔大小\\s*([0-9.]+)/); return m ? Number(m[1]) : null; })()`,
    );

    try {
        out.ready = await waitForAppReady();
        await new Promise((r) => setTimeout(r, 1500));
        win.focus();
        win.webContents.focus();

        // ① 新建大画布
        const docSize = Number(process.env.KLEKS_DOC || 2000);
        out.docTarget = docSize;
        // 先切到「文件」标签，面板里的"新建"按钮才是可见可点的
        out.clickedFileTab = await clickEl(`Array.from(document.querySelectorAll('[title]')).find((e) => (e.getAttribute('title') || '') === '文件')`);
        await new Promise((r) => setTimeout(r, 700));
        out.clickedNew = await clickEl(`Array.from(document.querySelectorAll('button,div')).find((e) => (e.innerText || '').trim() === '新建' && e.getBoundingClientRect().width > 3)`);
        if (!out.clickedNew) {
            out.clickedNew = await clickEl(`Array.from(document.querySelectorAll('[title]')).find((e) => (e.getAttribute('title') || '') === '新建')`);
        }
        await new Promise((r) => setTimeout(r, 1200));
        out.setInputs = await win.webContents.executeJavaScript(
            `(() => {
                const w = document.querySelector('input[name="image-width"]');
                const h = document.querySelector('input[name="image-height"]');
                if (!w || !h) return 'inputs-not-found';
                const set = (el, v) => { el.focus(); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
                set(w, ${docSize}); set(h, ${docSize});
                return { w: w.value, h: h.value };
            })()`,
        );
        await new Promise((r) => setTimeout(r, 500));
        out.clickedOk = await clickEl(`Array.from(document.querySelectorAll('button')).find((e) => /^(Ok|确定|好)$/.test((e.innerText || '').trim()))`);
        await new Promise((r) => setTimeout(r, 2500));
        out.docAfterCreate = await docInfo();
    } catch (e) {
        out.docError = String(e.message);
    }
    writeOut();

    try {
        // ② 加图层（点"新建图层"按钮）
        const layers = Number(process.env.KLEKS_LAYERS || 0);
        for (let i = 0; i < layers; i++) {
            await clickEl(`Array.from(document.querySelectorAll('[title]')).find((e) => (e.getAttribute('title') || '') === '新建图层')`);
            await new Promise((r) => setTimeout(r, 400));
        }
        out.layersAdded = layers;
        out.docAfterLayers = await docInfo();
    } catch (e) {
        out.layerError = String(e.message);
    }
    writeOut();

    try {
        // ③ 笔刷调大
        const target = Number(process.env.KLEKS_BRUSH_SIZE || 0);
        let cur = await readSize();
        for (let i = 0; i < 90 && target > 0 && cur !== null && cur < target; i++) {
            await key(']', 'BracketRight', 221);
            await new Promise((r) => setTimeout(r, 55));
            cur = await readSize();
        }
        out.brushSize = cur;
    } catch (e) {
        out.sizeError = String(e.message);
    }
    writeOut();

    try {
        // ④ 画一笔并测帧间隔
        await win.webContents.executeJavaScript(
            `(() => {
                window.__frames = [];
                let last = performance.now();
                const tick = (t) => { window.__frames.push(t - last); last = t; window.__rafOn = requestAnimationFrame(tick); };
                window.__rafOn = requestAnimationFrame(tick);
                return true;
            })()`,
        );
        const b = win.getContentBounds();
        const y = Math.round(b.height * 0.45);
        const x1 = Math.round(b.width * 0.2);
        const x2 = Math.round(b.width * 0.7);
        await dispatch({ type: 'mousePressed', x: x1, y, button: 'left', buttons: 1, clickCount: 1 });
        for (let i = 1; i <= 60; i++) {
            await dispatch({ type: 'mouseMoved', x: Math.round(x1 + ((x2 - x1) * i) / 60), y: y + Math.round(Math.sin(i / 6) * 60), button: 'left', buttons: 1 });
            await new Promise((r) => setTimeout(r, 16));
        }
        await dispatch({ type: 'mouseReleased', x: x2, y, button: 'left', buttons: 0, clickCount: 1 });
        await new Promise((r) => setTimeout(r, 1000));
        out.strokeFrames = await win.webContents.executeJavaScript(
            `(() => {
                cancelAnimationFrame(window.__rafOn);
                const f = window.__frames.slice(3);
                if (!f.length) return null;
                const s = [...f].sort((a, b) => a - b);
                return { n: f.length, avgMs: +(f.reduce((a, b) => a + b, 0) / f.length).toFixed(1), p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(1), maxMs: +s[s.length - 1].toFixed(1), over33ms: f.filter((x) => x > 33).length };
            })()`,
        );
        // ⑤ 对照试验：把笔刷调回小号（~4）在同一张 2K 画布上再画一笔
        try {
            let cur2 = await readSize();
            for (let i = 0; i < 90 && cur2 !== null && cur2 > 4; i++) {
                await key('[', 'BracketLeft', 219);
                await new Promise((r) => setTimeout(r, 55));
                cur2 = await readSize();
            }
            out.brushSizeSmall = cur2;
            await win.webContents.executeJavaScript(
                `(() => { window.__frames = []; let last = performance.now();
                   const tick = (t) => { window.__frames.push(t - last); last = t; window.__rafOn = requestAnimationFrame(tick); };
                   window.__rafOn = requestAnimationFrame(tick); return true; })()`,
            );
            const b2 = win.getContentBounds();
            const y2 = Math.round(b2.height * 0.7);
            const a1 = Math.round(b2.width * 0.2);
            const a2 = Math.round(b2.width * 0.7);
            await dispatch({ type: 'mousePressed', x: a1, y: y2, button: 'left', buttons: 1, clickCount: 1 });
            for (let i = 1; i <= 60; i++) {
                await dispatch({ type: 'mouseMoved', x: Math.round(a1 + ((a2 - a1) * i) / 60), y: y2 + Math.round(Math.sin(i / 6) * 60), button: 'left', buttons: 1 });
                await new Promise((r) => setTimeout(r, 16));
            }
            await dispatch({ type: 'mouseReleased', x: a2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
            await new Promise((r) => setTimeout(r, 1000));
            out.strokeFramesSmallBrush = await win.webContents.executeJavaScript(
                `(() => { cancelAnimationFrame(window.__rafOn); const f = window.__frames.slice(3); if (!f.length) return null;
                   const s = [...f].sort((a, b) => a - b);
                   return { n: f.length, avgMs: +(f.reduce((a, b) => a + b, 0) / f.length).toFixed(1), p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(1), maxMs: +s[s.length - 1].toFixed(1), over33ms: f.filter((x) => x > 33).length }; })()`,
            );
        } catch (e) { out.smallBrushError = String(e.message); }
        out.docFinal = await docInfo();
        fs.writeFileSync(path.join(__dirname, 'perf-probe-screenshot.png'), (await win.webContents.capturePage()).toPNG());
    } catch (e) {
        out.strokeError = String(e.message);
    }
    writeOut();
        console.log('PERF_PROBE ' + JSON.stringify(out));
        app.exit(0);
    };
};
