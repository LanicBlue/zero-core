# store 目录说明书

## 核心功能

基于 Zustand 的渲染进程全局状态层，按领域拆分为多个独立 store：agent / agent-tool / chat / interaction / kb / mcp / notification / page / project / provider / requirement / template / theme / wiki。

## 输入

- 各 store 自身的初始状态与 action
- `window.api`：与主进程交互的 IPC 接口
- `../../shared/types`：领域类型

## 输出

- 各 `use*Store` hook，供 components/ 下组件订阅与派发 action

## 定位

渲染进程状态层，位于 `window.api`（IPC）与 UI 组件之间，集中数据获取、缓存与跨组件共享。

## 依赖

- zustand
- `../../shared/types`
- `window.api`

## 维护规则

- 新增领域须新增独立 store 文件，避免单个 store 膨胀。
- store 内部只做数据获取与简单变换，不写 UI 逻辑。
- IPC 接口签名变化时同步对应 store action。
- 部分 store 在模块加载时自动 fetch（如 mcp-store），新增需评估副作用。
