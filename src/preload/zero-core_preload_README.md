# src/preload/

## 核心功能
Electron 预加载脚本：在渲染进程加载前运行，通过 contextBridge 以受控方式把
IPC 通道暴露为 `window.api`，使渲染层在 contextIsolation 下仍能调用主进程能力。

## 输入
- 渲染层对 window.api 各方法的调用
- 来自主进程 ipcMain 的回推事件（`agent:event`、`app:ready` 等）

## 输出
- `window.api` 对象：覆盖 config / agents / providers / mcp / kb / templates /
  sessions / messages / chat / files / logs / tool-executions / webfetch /
  skills / memory / projects / requirements / wiki / lead 等全部 IPC 通道
- 事件订阅 API（onAgentEvent 等）

## 定位
src/preload/index.ts，Electron 主窗口 webPreferences.preload 指向的脚本；
位于渲染层与主进程之间，是 IPC 通道在渲染侧的唯一合法入口。

## 依赖
- 外部：electron（contextBridge、ipcRenderer）
- 内部：../shared/preload-types.ts（WindowApi 类型契约）、../shared/ipc-api.ts
  （通道名与参数类型）

## 维护规则
- 新增 IPC 通道时必须同步：shared/ipc-api.ts（契约）、shared/preload-types.ts
  （WindowApi）、本目录 index.ts（实现）、对应 main/ipc/*-handlers.ts
- 禁止在 preload 中直接 require Node 模块或访问 fs/网络，所有副作用走主进程
- 通道命名与 main 端、shared 端必须三方一致，避免 invoke 走丢
