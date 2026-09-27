// 界面缩放验收探针：确认缩放后
//   ① 工具栏视觉宽度 = 271 × 缩放比
//   ② 画布没有被工具栏压住（overlap ≈ 0）
//   ③ 画布后备分辨率不变（保持原生清晰，不是被拉模糊）
// 用法：Kleks.exe --probe-scale  → scale-probe.json
module.exports = ({ win, app, fs, path, waitForAppReady }) =>
    async function scaleProbe() {
        const out = { steps: [] };
        const measure = `(() => {
            const ts = document.querySelector('.kl-toolspace');
            const cs = [...document.querySelectorAll('canvas')];
            const main = cs.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
            const rect = (el) => {
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) };
            };
            const tr = rect(ts), cr = rect(main);
            return {
                innerW: window.innerWidth,
                stored: localStorage.getItem('kl-ui-scale'),
                cssZoom: ts ? (getComputedStyle(ts).zoom || '1') : null,
                toolRect: tr,
                toolInlineW: ts ? ts.style.width : null,
                canvasBackingW: main ? main.width : null,
                canvasRect: cr,
                overlapPx: tr && cr ? Math.max(0, cr.right - tr.x) : null,
            };
        })()`;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        // 打开设置标签（设置面板是懒加载的，不点开就没有这个 DOM）
        const openSettings = `(() => {
            const img = [...document.querySelectorAll('img')].find((i) => (i.src || '').includes('tab-settings'));
            const el = img && (img.closest('[class*="tab"]') || img.parentElement);
            if (el) { el.click(); return true; }
            return false;
        })()`;
        out.settingsTabClicked = await win.webContents.executeJavaScript(openSettings);
        await sleep(900);

        // 界面缩放控件是否真的出现在设置面板里
        const hasControl = await win.webContents.executeJavaScript(
            `!![...document.querySelectorAll('div')].find((d) => d.textContent === '界面大小 / UI size:')`,
        );
        out.controlFound = hasControl;
        out.scaleLabel = await win.webContents.executeJavaScript(
            `(() => {
                const el = [...document.querySelectorAll('div')].find((d) => /^\\d+%$/.test(d.textContent || ''));
                return el ? el.textContent : null;
            })()`,
        );

        for (const s of ['1', '1.25', '1.5', '0.75']) {
            await win.webContents.executeJavaScript(`localStorage.setItem('kl-ui-scale', '${s}'); true`);
            win.webContents.reload();
            await sleep(1500);
            await waitForAppReady();
            await sleep(900);
            const m = await win.webContents.executeJavaScript(measure);
            m.requested = s;
            out.steps.push(m);
        }
        await win.webContents.executeJavaScript(`localStorage.setItem('kl-ui-scale', '1'); true`);

        fs.writeFileSync(path.join(__dirname, 'scale-probe.json'), JSON.stringify(out, null, 2));
        console.log('SCALE_PROBE_CONTROL ' + out.controlFound);
        console.log('SCALE_PROBE ' + JSON.stringify(out.steps));
        app.exit(0);
    };
