# 平台底座笔记（冷启动相关，非 agent 工作流范围）

> 这些是 Electron/Express 进程编排层的工程细节，与 agent-driven workflow 无关。
> 单独记录备查，不进 workflow-spec.md。每条带「我的判断」，需要时再动。

## A. ready 超时与分阶段
**现状**：`backend-spawn.ts` 单一 30s 超时，后端通过 stdout `{type:"ready",port}` 一次性握手。
**风险**：冷机器（首次 migration + 大库 restoreAllSessions）可能顶不住 30s。
**我的判断**：暂不改。30s 对当前库规模（14 session）足够；真出问题再加分阶段 ready（DB ready → routers ready）。优先级低。

## B. 崩溃恢复语义
**现状**（`recovery.ts:recoverWorkflowState`）：
- `build`：running step 标 failed；lead session 丢失 → 只加消息，**不自动续**
- `plan`：lead session 丢失 → reset 回 `ready`
- `verify`：只加消息「请重新触发」，**不自动重跑**

**我的判断**：`plan` reset 合理（计划是 lead 推演产物，丢了重领合理）。`verify` 不自动重跑**偏保守但合理**——验证可能依赖外部状态/成本高，让用户/cron 决定更安全。`build` 不自动续也合理（半截改动重跑有风险）。维持现状，不改。

## C. cron restore 位置
**现状**：`cronManager.restoreSchedules()` 埋在 `recoverWorkflowState()` 内部，外层整体 try-catch。
**风险**：若 restore 之前的某步抛错，cron 不会恢复 → PM 巡检静默失效。
**我的判断**：值得改——把 cron restore 提成独立、更早、单独 try 的小步骤。但属低频路径（前序步骤都 try-catch 过了），优先级中。等真撞到再改。

## D. IPC 注册 vs renderer 加载时序
**现状**：`registerProxyHandlers` 在 `createWindow` 之后；renderer 理论上可能在 ROUTE_MAP 注册完成前 invoke。
**风险**：dev 下 vite 加载延迟通常规避；打包模式有竞态窗口。
**我的判断**：值得做一道防护——要么 createWindow 前先注册 IPC，要么 renderer 等一个 ready 信号。优先级中。

---

## 冷启动链关键锚点（备查）
- 进程入口：`src/main/index.ts:191` `app.whenReady`
- 后端握手：`src/main/backend-spawn.ts:55` spawnBackend / stdout ready 行
- 后端入口：`src/backend.ts:42` main → emit ready 行在 `:48`
- 后端装配：`src/server/index.ts:99` startServer
- migration 触发点（最早副作用）：`server/index.ts:112` runMigrations
- session 重载：`server/index.ts:223` restoreAllSessions
- 工作流恢复：`server/index.ts:376` recoverWorkflowState（内含 cron restore）
