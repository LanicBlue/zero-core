# store

## 核心功能
前端状态管理层，使用 Zustand 管理渲染进程的全局状态，包括聊天、Agent、页面导航、主题、交互、MCP、Provider、模板等各领域状态。

## 输入
IPC 调用结果（通过 window.api）、用户交互事件

## 输出
React 组件消费的 Zustand store 状态和 actions

## 定位
src/renderer/store/ — 渲染进程状态管理层，连接 UI 组件与主进程 IPC

## 依赖
zustand（状态管理库）；../preload（通过 window.api 调用 IPC）

## 维护规则
- 新增状态域需创建独立 store 文件
- store 中的异步操作通过 IPC 调用主进程，不直接访问文件系统
- 状态结构变更需检查所有消费组件
