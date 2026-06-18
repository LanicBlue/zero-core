# Plan P9 — 清理 dead path + 债务(最后)

> **依赖**:P2(废 agent-as-tool)+ P4(废 project 调度通道)+ P7(废 router)。最后做。
> **对应规范**:§6。**验收**:`acceptance-P9.md`。
> **文件**:`src/main/ipc.ts`、`src/main/ipc/{cron,orchestrate,pm}-handlers.ts`、`typed-ipc.ts`、`src/main/ipc/core.ts`、`src/server/cron-analysis.ts`(legacy aliases)。

**为什么最后**:前面阶段都在「停用」这些旧路径(停止读写/调用),本阶段确认无引用后物理删除,避免中间态破坏。

## 设计细节要求

### dead IPC path(§6.1)

1. 确认 `src/main/ipc.ts` registerIpc 无任何调用方(grep);删 registerIpc + `src/main/ipc/{cron,orchestrate,pm}-handlers.ts`。
2. `typed-ipc.ts`(setContextGetter 等)+ `core.ts` 的 ctx 装配——若仅被 dead path 用,一并删;若被其他复用,保留必要部分。
3. 删后 ROUTE_MAP(`ipc-proxy.ts`)是唯一 IPC 注册路径(契约 1.1)。

### agent-tool-entries 表 DROP(P2 停读写后)

4. `db-migration.ts` 加 DROP TABLE agent-tool-entries(空表/已无引用,安全 drop)。

### CronAnalysisManager legacy aliases(§6.2)

5. 删 `restoreSchedulesForProjects/scheduleProject/unscheduleProject/rescheduleProject`(cron-analysis.ts:184-201,no-op);确认 project-router 旧调用方已在 P4/P5 清。

### 其余债务(§6)

6. 扫 §6 剩余项逐一清。

## 风险

- **删过头误伤**:dead path 文件可能被某处隐式 import;删前 grep 全仓引用 + build 验证。
- **DROP agent-tool-entries**:确认 P2 后无任何读写;fresh + 旧库 migration 都不崩。

## 不在本阶段

- 所有功能性重构(P0–P8)。本阶段纯清理。
