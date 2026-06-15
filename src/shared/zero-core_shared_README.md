# src/shared/

## 核心功能
跨进程共享层：主进程、渲染进程与后端服务共用的类型定义与纯工具函数。
是项目数据模型与 IPC 契约的“单一事实来源”。

## 输入
- 无运行时输入（除 file-utils 等纯函数工具外，主要是类型与契约）

## 输出
- `types.ts`：全部数据模型接口（Agent、Provider、Template、Mcp、Kb、Session、
  Message、Project、Requirement、ProjectWiki、TaskStep、Notification 等）
- `ipc-api.ts`：所有 IPC 通道的参数与结果类型契约（IpcChannelDefs）
- `preload-types.ts`：渲染层 `window.api` 的 WindowApi 类型
- `file-utils.ts`、`github-template-utils.ts`：无副作用的纯工具函数

## 定位
src/shared/，源码最底层；被 main / preload / renderer / server / runtime /
core 任意层引用，自身不反向依赖任何上层。

## 依赖
- 仅依赖 TypeScript 类型与少量无副作用工具；不依赖 Electron、Node fs、网络

## 维护规则
- 任何跨进程共用的类型必须在此声明，禁止在 main/renderer/server 各自重定义
- 新增 IPC 通道需同时更新 ipc-api.ts、preload-types.ts 及对应 main handler
- 数据模型字段变更（增删列）必须同步 server 的 Store 与 db-migration
- 本目录禁止引入运行时副作用（fs/网络/进程 API），保持可被任意进程安全引用
