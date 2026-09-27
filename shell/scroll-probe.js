// 工具栏滚动验收探针（补丁 P4）
//   ① 鼠标滚轮停在"面板任意位置"能否滚动（原来只有停在两个小箭头上才有效）
//   ② 手指（触摸）拖拽能否滚动（原来 touch-action:none，完全滚不动）
//   ③ 长按箭头是否加速（原来恒速 13px/20ms）
// 用法：Kleks.exe --probe-scroll  → scroll-probe.json
module.exports = ({ win, app, fs, path, waitForAppReady }) =>
    async function scrollProbe() {
        await waitForAppReady();
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        // 必须 attach 才能发 CDP 命令（上一版漏了这步 → 探针静默失败、写不出结果）
        try {
            win.webContents.debugger.attach('1.3');
        } catch (e) { /* 已 attach 会抛，忽略 */ }
        const out = { steps: [] };

        // 窗口弄矮，逼出工具栏溢出（默认 1424×861 时工具栏不一定超高）
        win.setSize(900, 380);   // 窗口够矮，工具栏才有充足可滚距离
        await sleep(900);

        const geom = await win.webContents.executeJavaScript(`(() => {
            const ts = document.querySelector('.kl-toolspace');
            return {
                scrollHeight: ts.scrollHeight,
                clientHeight: ts.clientHeight,
                scrollTop: Math.round(ts.scrollTop),
                overflowY: getComputedStyle(ts).overflowY,
                touchAction: getComputedStyle(ts).touchAction,
                rect: (() => { const r = ts.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
                arrowCount: document.querySelectorAll('.kl-scroller').length,
            };
        })()`);
        out.geom = geom;
        const tsRect = geom.rect;
        const midX = Math.round(tsRect.x + tsRect.w / 2);
        const midY = Math.round(tsRect.y + tsRect.h / 2);

        const scrollTop = () =>
            win.webContents.executeJavaScript(`Math.round(document.querySelector('.kl-toolspace').scrollTop)`);
        const reset = () =>
            win.webContents.executeJavaScript(`document.querySelector('.kl-toolspace').scrollTop = 0; true`);

        // ① 真实滚轮（CDP 发出的是可信事件）
        await reset();
        await sleep(200);
        const beforeWheel = await scrollTop();
        for (let i = 0; i < 5; i++) {
            await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
                type: 'mouseWheel', x: midX, y: midY, deltaX: 0, deltaY: 120,
            });
            await sleep(60);
        }
        await sleep(300);
        out.wheel = { before: beforeWheel, after: await scrollTop() };

        // ② 触摸拖拽（先开触摸模拟，否则事件不会走滚动管线）
        await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });（模拟手指从上往下滑 → 内容上滚，scrollTop 增加）
        await reset();
        await sleep(200);
        const beforeTouch = await scrollTop();
        const touch = async (type, y) =>
            win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', {
                type,
                touchPoints: type === 'touchEnd' ? [] : [{ x: midX, y, id: 0, radiusX: 4, radiusY: 4, force: 1 }],
            });
        await touch('touchStart', midY + 120);
        for (let i = 1; i <= 12; i++) {
            await touch('touchMove', midY + 120 - i * 15);
            await sleep(30);
        }
        await touch('touchEnd', 0);
        await sleep(500);
        out.touch = { before: beforeTouch, after: await scrollTop() };

        // ③ 长按向下箭头 0.9 秒（对比旧实现的恒速 13px/20ms ≈ 585px）
        await reset();
        await sleep(200);
        const beforeArrow = await scrollTop();
        const arrowBox = await win.webContents.executeJavaScript(`(() => {
            const els = [...document.querySelectorAll('.kl-scroller')];
            const down = els.find((e) => (getComputedStyle(e).bottom !== 'auto' && getComputedStyle(e).bottom !== ''));
            const el = down || els[els.length - 1];
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), display: getComputedStyle(el).display, right: getComputedStyle(el).right };
        })()`);
        out.arrowBox = arrowBox;
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: arrowBox.x, y: arrowBox.y, button: 'left', clickCount: 1,
        });
        await sleep(900);
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: arrowBox.x, y: arrowBox.y, button: 'left', clickCount: 1,
        });
        await sleep(300);
        out.arrowHold = { before: beforeArrow, after: await scrollTop() };

        win.setSize(1424, 861);
        fs.writeFileSync(path.join(__dirname, 'scroll-probe.json'), JSON.stringify(out, null, 2));
        console.log('SCROLL_PROBE ' + JSON.stringify(out));
        app.exit(0);
    };
