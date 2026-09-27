# NOTICE — 上游归属与品牌说明

## 上游

本仓库是 **[bitbof/klecks](https://github.com/bitbof/klecks)**（Kleki.com 的官方开源版）的**外壳 + 补丁**，不包含上游源代码本身。

- 上游许可：**MIT License, Copyright (c) bitbof**
- 补丁基线提交：`d705854a21388a9258971b65bbfecafc98b5288e`（2026-09-26，版本 0.11.4.1）
- 用到的上游公开信息：仓库 README、kleki.com/about 的 roadmap、GitHub issue 列表

`patches/` 下的两个补丁是对上游作品的**修改**，按 MIT 条款同样以 MIT 许可分发。

## 品牌

上游明确说明：Kleki 的名称与品牌**不在** MIT 授权范围内（"you may not use Klecks to offer a service branded or presented as 'Kleki' without a license from bitbof"）。因此：

- 本产物一律命名为 **Kleks**，不称 Kleki；
- 本仓库**不包含**上游图标、Logo 或其它品牌素材；
- 构建时可用 `tools/make_icon.py` 从**你自己 clone 的上游源码**里的 PNG 现场生成 `.ico`（该图标仅用于本地个人构建）。

若要在线上对外提供带 Kleki 品牌的服务，请另行联系上游作者取得授权。

## 第三方

- Electron / Chromium：MIT 及各自的第三方许可（随 Electron 运行时附带 `LICENSES.chromium.html`）
- 上游依赖（ag-psd、polygon-clipping、transformation-matrix、json5 等）：各自许可，随上游 `dist/licenses.js` 一并展示
