# ipc

## 核心功能
Electron IPC（进程间通信）处理器层，将渲染进程的调用桥接到主进程的实际业务逻辑，覆盖会话、Agent、工具、配置、MCP、日志、模板、知识库等所有交互通道。

## 输入
渲染进程通过 ipcRenderer 发出的 IPC 调用

## 输出
主进程业务逻辑执行结果，通过 ipcRenderer 返回给渲染进程

## 定位
src/main/ipc/ — Electron 主进程 IPC 处理层，连接 preload 和 server

## 依赖
../shared/ipc-api.ts（IPC 通道定义）；../shared/types.ts（共享类型）；../server/*（实际业务逻辑 Store 和 Router）；electron（ipcMain/ipcRenderer）

## 维护规则
- 新增 IPC 通道需同时在 core.ts 注册、ipc-api.ts 定义、preload 暴露
- handler 函数需保持轻量，业务逻辑委托给 server 层
- typed-ipc.ts 确保类型安全的 IPC 调用
