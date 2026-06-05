# common

## 核心功能
通用 UI 组件库，提供代码高亮、日志查看、确认弹窗、Markdown 渲染等跨页面复用的基础组件。

## 输入
React props（代码文本、Markdown 内容、日志流、确认回调等）

## 输出
可复用的 React UI 组件（CodeBlock、MarkdownRenderer、LogViewer、ConfirmModal）

## 定位
src/renderer/components/common/ — 渲染进程通用组件层，被所有页面组件引用

## 依赖
react；shiki（代码高亮）

## 维护规则
- 新增通用组件需确保跨页面可复用、无业务耦合
- CodeBlock 高亮语言支持变更需同步检查 shiki-init.ts
- 组件 Props 变更需向后兼容
