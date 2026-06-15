# themes 目录说明书

## 核心功能

主题变量定义：`dark.css` 与 `light.css` 分别覆盖 `global.css` 中声明的 CSS 变量（前景/背景/边框/强调色/语义色等），实现明暗主题切换。

## 输入

- 无（纯 CSS 变量覆盖）

## 输出

- 在 `:root[data-theme="..."]` 等选择器下生效的主题变量集

## 定位

渲染进程样式子层，由 `store/theme-store` 通过设置根元素属性来激活对应主题。

## 依赖

- 父级 `../global.css`（变量骨架）
- `../../store/theme-store`（主题切换）

## 维护规则

- 新增 UI 语义色（success/warning/error/info）须在两个主题文件中同步定义。
- 变量命名须与 `global.css` 声明保持一致，避免遗漏导致回退。
- 新增主题文件须在 theme-store 中注册可选项。
