# 补丁说明

两个补丁都基于上游 **`bitbof/klecks` @ `d705854`（0.11.4.1）**。应用顺序无关。

```bash
git clone https://github.com/bitbof/klecks.git && cd klecks && git checkout d705854
git apply ../kleks-desktop/patches/0001-global-symmetry.patch
git apply ../kleks-desktop/patches/0002-visible-rect-render.patch
```

---

## 0001-global-symmetry.patch — 全局对称绘制

**目的**：所有笔刷支持左右 / 上下 / 四向镜像。

**做法**（关键：三种模式按笔刷特性分开，这是踩坑后的结论）

| 模式 | 笔刷 | 原理 |
| --- | --- | --- |
| 通用包装（`live`） | 铅笔 / 素描 / 像素 / 橡皮 | 新增 `brushes/symmetry-brush.ts`，用 Proxy 包住笔刷实例：`set*` 调用记入 callLog 并转发，落笔方法额外用镜像坐标驱动懒创建的镜像实例（创建时重放 callLog 保持参数一致） |
| 笔刷内置（`native`） | 水彩 / 晕染 / 异形图形 | 水彩与晕染**新增** `setXSymmetry/setYSymmetry`：在**同一实例、同一份缓存**里把镜像参数追加进同一次计算，每帧只写回一次；异形图形**本来就有**这套 API，直接驱动 |

**为什么必须分模式（负面结果）**

- 水彩/晕染是"复制整层 + 每帧 `putImageData` 整块覆盖写回"型：**两个实例同时落笔会互相覆盖对方刚写的像素 → 笔画交界处乱闪**。改成串行回放可以不闪，但失去实时性 —— 最终解是把镜像做进**参数层**（同一帧、同一份缓存、一次写回），既实时又不闪。
- `putImageData` **忽略画布变换**，所以没法像异形图形那样在渲染层用 canvas transform 镜像。
- 异形图形**外挂镜像完全无效**（它自己那套对称会接管）。

**取舍**

- `live` 模式的镜像实例会各推一条历史 → **一次对称笔画要撤销两次**；`native` 模式仍是一次撤销。
- `symmetry-brush.ts` 里还留了 `sequential` 模式（落笔期只记录、抬笔后一次性回放），当前**未使用**，留给未来需要它的"整层重合成"型笔刷。

**开关**：设置面板底部新增两个复选框（复用上游已有的 `brush-chemy-mirror-x/y` 翻译键），状态存 `localStorage: kl-symmetry-horizontal / kl-symmetry-vertical`。
**关得掉**：`native` 模式的同步函数每次都写入"有效值 = 本笔刷勾选 ‖ 全局开关"，并用"当前值是否等于上次写入值"识别用户是否动过笔刷自带的勾选框——否则关闭全局开关时笔刷内部标记会一直是 `true`（实测踩过）。

---

## 0002-visible-rect-render.patch — 视口可见区渲染优化

**目的**：大画布 / 多图层时不再每帧重采样整张画布。

**原逻辑**（上游）：每帧每层 `ctx.drawImage(layer.image, 0, 0)`，把**整张 document 画布**交给浏览器缩放 → 成本 ≈ 图层数 × 整张画布像素数（非 `source-over` 的混合模式更贵）。

**现在**：用渲染矩阵的逆把视口四角映回 document 空间取外接盒（+ 按缩放的余量），只画这块源矩形：

```js
ctx.drawImage(img, sx, sy, sw, sh,  sx, sy, sw, sh)
```

混合模式是逐像素运算，少算看不见的部分**结果一致**（不是降质）。带自身 transform 的动态图层（滤镜/FFD 预览）仍走整张绘制。

**收益条件（重要）**：只有"可见面积 < 整张画布"时才省，即**放大作画**时，约 1/缩放²。缩到 fit 看全图时整张本来就可见 → 无收益。实测 2K 画布下可见区占 25% → 该方向成本降约 4 倍。

**诊断**：渲染时暴露 `window.__kleksVisibleRect = {x,y,width,height,docWidth,docHeight,layers}`，便于量化。

**未覆盖**：剪切蒙版分组仍会分配整画布大小的临时画布（`LayerCompositor.drawGroup` 用的是 project 尺寸）——留作后续优化。
