# styles 目录说明书

## 核心功能

渲染进程全局样式入口：`global.css` 定义跨主题通用的 reset、布局、组件类与 CSS 变量骨架；`themes/` 子目录提供明暗主题变量覆盖。

## 输入

- 无（纯样式资源）

## 输出

- 应用于整个渲染进程的 CSS

## 定位

渲染进程样式层，由 `main.tsx` 通过 `import "./styles/global.css"` 引入；主题切换由 `store/theme-store` 配合 `themes/` 完成。

## 依赖

- 被 `src/renderer/main.tsx` 引入
- 主题变量被 `store/theme-store` 切换

## 维护规则

- 新增/调整颜色、间距、字号等令牌统一走 CSS 变量并在 `global.css` 或 `themes/*.css` 中声明。
- 组件级样式优先复用现有 class，避免内联硬编码颜色。
- 新增主题需要在 `themes/` 新增对应文件并由 theme-store 注册。
