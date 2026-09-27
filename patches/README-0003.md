# 补丁 0003：界面缩放（UI size）

**目的**：低分辨率设备（低分屏笔电、手机、平板）上界面元素太小 / 太挤。给用户一个 **75% ~ 200%** 的界面缩放开关。

**放哪**：设置面板底部新增一行「界面大小 / UI size: ［−］ 100% ［+］」（点百分比回到 100%），存 `localStorage: kl-ui-scale`。

## 为什么只缩放"界面外壳"，不缩放整个页面

实测（Electron 40 / Chromium 144，窗口 1424×861，默认画布 1153）：

| 做法 | 结果 |
| --- | --- |
| 对 app 根 / `body` 加 `zoom`（**错误做法**） | 画布**后备尺寸与显示尺寸脱钩**：zoom=1.5 时画布后备仍是 1153，但渲染宽变成 1730 > 窗口 1424 → **画布被拉模糊 + 右边被切掉**（zoom=1.25 时就已经 1441 > 1424 溢出） |
| 只对 `.kl-toolspace` / `.kl-d-modal-root` / `.top-overlay` 加 `zoom`（**本补丁**） | 工具栏变大、画布保持原生 1:1 清晰，且 app 会把画布重新排布让出空间 |

> 踩坑：页面里有 **多个 `.g-root`**（app 根 + 状态浮层 + 模态框根），`document.querySelector('.g-root')` 会抓到尺寸为 0×0 的那个 → 缩放了完全看不出变化。挑元素要按面积最大来选。

## 关键点：缩放外壳的同时必须同步 app 的布局常数

`kl-app.ts` 里工具栏宽度是写死的：`private readonly toolWidth: number = 271`，画布空间按 `uiWidth - toolWidth` 计算。如果只把外壳用 CSS 放大，画布预留的空间不变 → **工具栏会压住画布**。

所以本补丁把 271 拆成"基准 + 缩放"：

```ts
private readonly toolWidthBase: number = 271;
private get toolWidth(): number { return Math.round(this.toolWidthBase * getUiScale()); }
```

- `.kl-toolspace` 元素自身的 `width` 用**基准 271**（视觉放大交给 CSS `zoom`，两处都乘就变成平方了）；
- 画布布局（含左布局里原本硬编码的 `left: 271`，共 3 处）改用 `this.toolWidth`；
- 缩放变化时 `onUiScaleChange` → `refreshUiScale()`（`resize()` 有"尺寸没变就 return"的守卫，直接调它唤不动布局）。

## 实测验收（每档都量过，不是"应该没问题"）

| 设置 | 生效 CSS zoom | 工具栏视觉宽 | 画布后备宽 | 画布/工具栏重叠 |
| --- | --- | --- | --- | --- |
| 100% | 1 | 271 | 1153 | 0 |
| 125% | 1.25 | **339** | 1085 | 0 |
| 150% | 1.5 | **407** | 1017 | 0 |
| 75% | 0.75 | 203 | 1221 | 0 |

工具栏始终贴住窗口右缘（right 恒为 1424）、画布后备分辨率始终等于自身 CSS 宽度（**1:1，不模糊**）、**重叠恒为 0**。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/app/script/klecks/ui/ui-scale.ts` | **新增**：缩放状态（localStorage 持久化、0.75~2 步进 0.125）、注入 `<style>` 给外壳加 `zoom`、变更订阅 |
| `src/app/script/app/kl-app.ts` | `toolWidth` → `toolWidthBase` + 缩放 getter；3 处硬编码 271 改用 getter；构造末尾注册 `onUiScaleChange`；新增 `refreshUiScale()` |
| `src/app/script/klecks/ui/tool-tabs/settings-ui.ts` | 设置面板新增「界面大小」控件（−/百分比/+） |

## 生成这个补丁时踩的坑（给以后加补丁的人）

`git apply` 默认**只改工作树、不改索引**。想生成"某个补丁之上的增量补丁"，必须先 `git add -A` 把基线补丁的结果**放进索引**，再覆盖文件、再 `git diff`；否则 `git diff` 拿到的是"base → 现在"，会把前一个补丁的改动也吞进来（现象：0003 里出现 0001 的 `+import Checkbox` 行，导致应用时报 `patch does not apply`）。

另外仓库 `core.autocrlf=true`：用脚本改过的文件若混入 LF 行，生成的补丁上下文行尾不一致，也会 apply 失败 —— 改完统一成 CRLF 再生成。
