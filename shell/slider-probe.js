// P5 功能验收探针
//   ① 触控（用 pointerType:'pen' 模拟非鼠标）按住滑条 → 数值不应被重设（原来是先清零）
//   ② 触控按住后拖动 → 数值应跟着变
//   ③ 鼠标按下滑条 → 仍保留"点哪跳哪"（桌面习惯，不能有回归）
//   ④ 触控在工具栏空白背景上拖动 → 应能滚动（自己实现的拖拽滚动）
// 用法：Kleks.exe --probe-slider → slider-probe.json
module.exports = ({ win, app, fs, path, waitForAppReady }) =>
    async function sliderProbe() {
        await waitForAppReady();
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        try {
            win.webContents.debugger.attach('1.3');
        } catch (e) {
            /* 已 attach */
        }
        const out = { steps: [] };
        win.setSize(1100, 380);   // 窗口压矮，工具栏才有足够可滚距离
        await sleep(800);

        const readSlider = `(() => {
            const w = document.querySelector('.slider-wrapper');
            if (!w) return null;
            const r = w.getBoundingClientRect();
            const ctrl = w.querySelector('[style*="width"]');
            return {
                text: (w.textContent || '').trim().slice(0, 40),
                ctrlWidth: ctrl ? ctrl.style.width : null,
                rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            };
        })()`;
        const readScroll = `(() => {
            const ts = document.querySelector('.kl-toolspace');
            return { scrollTop: Math.round(ts.scrollTop), canScroll: ts.scrollHeight - ts.clientHeight };
        })()`;

        const mouse = (type, x, y, pointerType, extra = {}) =>
            win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
                type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
                clickCount: 1, pointerType, ...extra,
            });

        const first = await win.webContents.executeJavaScript(readSlider);
        out.slider = first;
        if (!first) {
            fs.writeFileSync(path.join(__dirname, 'slider-probe.json'), JSON.stringify({ error: 'no slider found' }, null, 2));
            console.log('SLIDER_PROBE no-slider');
            app.exit(0);
            return;
        }
        const r = first.rect;
        const lowX = Math.round(r.x + r.w * 0.15); // 靠左 15% 处按下去
        const midY = Math.round(r.y + r.h / 2);
        const midX = Math.round(r.x + r.w * 0.5);

        // ① 触控（pen）按住 → 数值不该变
        await mouse('mousePressed', lowX, midY, 'pen');
        await sleep(250);
        const afterTouchDown = await win.webContents.executeJavaScript(readSlider);
        out.touchDown = { before: first.text, after: afterTouchDown.text, ctrlBefore: first.ctrlWidth, ctrlAfter: afterTouchDown.ctrlWidth };

        // ② 触控拖动 → 数值应变
        for (let i = 1; i <= 6; i++) {
            await mouse('mouseMoved', lowX + i * 12, midY, 'pen');
            await sleep(40);
        }
        const afterTouchDrag = await win.webContents.executeJavaScript(readSlider);
        out.touchDrag = { after: afterTouchDrag.text, ctrlAfter: afterTouchDrag.ctrlWidth };
        await mouse('mouseReleased', lowX + 72, midY, 'pen');
        await sleep(200);

        // ③ 鼠标按下 → 应保留"点哪跳哪"
        const beforeMouse = await win.webContents.executeJavaScript(readSlider);
        await mouse('mousePressed', midX, midY, 'mouse');
        await sleep(250);
        const afterMouseDown = await win.webContents.executeJavaScript(readSlider);
        await mouse('mouseReleased', midX, midY, 'mouse');
        await sleep(200);
        out.mouseJump = { before: beforeMouse.text, after: afterMouseDown.text, changed: beforeMouse.text !== afterMouseDown.text };

        // ④ 触控拖拽滚动（在工具栏空白处）
        const tsInfo = await win.webContents.executeJavaScript(`(() => {
            const ts = document.querySelector('.kl-toolspace');
            ts.scrollTop = 0;
            const r = ts.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height - 12), canScroll: ts.scrollHeight - ts.clientHeight, scrollTop: Math.round(ts.scrollTop) };
        })()`);
        out.scrollBefore = tsInfo;
        await mouse('mousePressed', tsInfo.x, tsInfo.y, 'pen');
        for (let i = 1; i <= 8; i++) {
            await mouse('mouseMoved', tsInfo.x, tsInfo.y - i * 10, 'pen');
            await sleep(30);
        }
        await mouse('mouseReleased', tsInfo.x, tsInfo.y - 80, 'pen');
        await sleep(700);
        out.scrollAfter = await win.webContents.executeJavaScript(readScroll);

        fs.writeFileSync(path.join(__dirname, 'slider-probe.json'), JSON.stringify(out, null, 2));
        console.log('SLIDER_PROBE ' + JSON.stringify(out));
        app.exit(0);
    };
