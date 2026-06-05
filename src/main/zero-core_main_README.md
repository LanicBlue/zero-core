# main

## 核心功能
Electron 主进程模块，负责应用生命周期管理、BrowserWindow 创建和 IPC 通道注册。

## 输入
Electron app 生命周期事件、IPC 通道定义

## 输出
应用窗口、已注册的 IPC handler、测试环境初始化

## 定位
src/main/ — Electron 主进程层，连接渲染进程与服务层

## 依赖
electron（BrowserWindow、app 等 API）；./ipc（所有 IPC handler）；../core（常量、配置）

## 维护规则
- 新增 IPC 通道需在 ipc.ts 中注册对应 handler
- 窗口配置（大小、标题等）变更在 index.ts 中修改
- test-setup.ts 需与主入口保持功能对齐
