# renderer

## 核心功能
Electron 渲染进程，包含 zero-core 桌面应用的全部 UI 代码，基于 React + TypeScript 构建，负责 Agent 管理、聊天交互、工具配置、知识库、MCP 设置等所有可视化界面。

## 输入
用户交互事件、preload 暴露的 window.api IPC 调用结果

## 输出
React UI 组件树、IPC 调用请求（通过 window.api）

## 定位
src/renderer/ — Electron 渲染进程 UI 层，通过 preload 桥接与主进程通信

## 依赖
react、react-dom；../preload（通过 window.api 调用 IPC）；./components（UI 组件）；./store（状态管理）

## 维护规则
- 新增页面路由需在 App.tsx 中注册
- 全局样式变更在 styles/ 目录中处理
- preload.d.ts 需与 preload/index.ts 保持同步
