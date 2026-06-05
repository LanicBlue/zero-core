# themes

## 核心功能
主题样式定义，通过 CSS 变量覆盖实现亮色和暗色两套主题，控制应用的配色方案。

## 输入
theme-store.ts 的主题选择状态、[data-theme] 属性

## 输出
CSS 自定义属性（dark.css / light.css），控制应用全局配色

## 定位
src/renderer/styles/themes/ — 渲染进程主题层，被 global.css 引用

## 依赖
../global.css（CSS 变量基础定义）；theme-store.ts（主题切换状态）

## 维护规则
- 新增颜色变量需在两个主题文件中同时定义
- 变量名变更需全局搜索替换所有引用
- 主题预览可通过 ThemeSettings.tsx 查看
