// 界面缩放探针：确认"整体缩放"会不会把画布拖模糊、以及该缩哪个元素
// 用法：Kleks.exe --probe-zoom   → 输出 zoom-probe.json
//
// 踩坑记录：页面里有多个 .g-root（app 根 + 状态浮层 + 模态框根），
// querySelector('.g-root') 会抓到小的那个 → 缩放了也看不出变化。必须挑面积最大的。
module.exports = ({ win, app, fs, path, waitForAppReady }) =>
    async function zoomProbe() {
        const ready = await waitForAppReady();
        const out = { ready, steps: [] };

        const probeTarget = `(() => {
            const all = [...document.querySelectorAll('.g-root')];
            const area = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.width) * Math.round(r.height); };
            all.sort((a, b) => area(b) - area(a));
            const biggest = all[0];
            return {
                count: all.length,
                pickedClass: biggest ? biggest.className : null,
                pickedParent: biggest && biggest.parentElement ? biggest.parentElement.tagName : null,
                sizes: all.map((el) => { const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); }),
            };
        })()`;

        const measure = `(() => {
            const all = [...document.querySelectorAll('.g-root')];
            const area = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.width) * Math.round(r.height); };
            all.sort((a, b) => area(b) - area(a));
            const root = all[0];
            const cs = [...document.querySelectorAll('canvas')];
            const main = cs.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
            const ts = document.querySelector('.kl-toolspace');
            const rect = (el) => el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
            return {
                innerW: window.innerWidth,
                innerH: window.innerHeight,
                dpr: window.devicePixelRatio,
                bodyZoom: document.body.style.zoom || null,
                rootZoom: root ? root.style.zoom || null : null,
                rootRect: rect(root),
                canvas: main ? {
                    attrW: main.width, attrH: main.height,
                    clientW: main.clientWidth, clientH: main.clientHeight,
                    rect: rect(main),
                } : null,
                toolRect: ts ? rect(ts) : null,
            };
        })()`;

        const applyZoom = (sel, z) =>
            win.webContents.executeJavaScript(
                `(() => {
                    const els = ${sel};
                    els.forEach((el) => { if (el) el.style.zoom = ${z === 1 ? "''" : `'${z}'`}; });
                    window.dispatchEvent(new Event('resize'));
                    return els.length;
                })()`,
            );

        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        out.target = await win.webContents.executeJavaScript(probeTarget);

        // A) 缩 app 根（面积最大的 .g-root）
        const biggest = `(() => {
            const all = [...document.querySelectorAll('.g-root')];
            const area = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.width) * Math.round(r.height); };
            all.sort((a, b) => area(b) - area(a));
            return [all[0]];
        })()`;
        out.series = { rootZoom: [], bodyZoom: [] };

        for (const z of [1, 1.25, 1.5, 0.8, 2]) {
            await applyZoom(biggest, z);
            await sleep(800);
            const m = await win.webContents.executeJavaScript(measure);
            out.steps.push(m);
            out.series.rootZoom.push({
                zoom: z,
                canvasBackingW: m.canvas && m.canvas.attrW,
                canvasRectW: m.canvas && m.canvas.rect && m.canvas.rect.w,
                toolRectW: m.toolRect && m.toolRect.w,
            });
        }
        await applyZoom(biggest, 1);

        // B) 缩 body（整体）
        for (const z of [1.25, 1.5, 0.8]) {
            await applyZoom('[document.body]', z);
            await sleep(800);
            const m = await win.webContents.executeJavaScript(measure);
            out.series.bodyZoom.push({
                zoom: z,
                canvasBackingW: m.canvas && m.canvas.attrW,
                canvasRectW: m.canvas && m.canvas.rect && m.canvas.rect.w,
                toolRectW: m.toolRect && m.toolRect.w,
            });
        }
        await applyZoom('[document.body]', 1);

        fs.writeFileSync(path.join(__dirname, 'zoom-probe.json'), JSON.stringify(out, null, 2));
        console.log('ZOOM_PROBE_TARGET ' + JSON.stringify(out.target));
        console.log('ZOOM_PROBE ' + JSON.stringify(out.series));
        app.exit(0);
    };
