# Acceptance P9 — 清理

> **前置**:P0–P8 全完成。**核心**:验「dead path 删除后 build + 全测试绿,dev 无 No handler」。

### dead IPC path
- [ ] `src/main/ipc.ts` registerIpc 已删;`{cron,orchestrate,pm}-handlers.ts` 已删
- [ ] typed-ipc.ts / core.ts ctx 装配:无引用部分已删,必要部分保留
- [ ] grep 全仓无对上述的引用;ROUTE_MAP(ipc-proxy.ts)是唯一 IPC 注册路径

### agent-tool-entries 表
- [ ] DROP TABLE agent-tool-entries migration;fresh + 旧库都不崩
- [ ] grep 无 agent-tool-entries / AgentToolStore 运行时引用

### CronAnalysisManager legacy aliases
- [ ] restoreSchedulesForProjects/scheduleProject/unscheduleProject/rescheduleProject 已删
- [ ] project-router 旧调用方已在 P4/P5 清(grep 无残留)

### 其余债务
- [ ] §6 剩余项已清

### 全局回归
- [ ] `npm run build:lib` 通过
- [ ] **全测试套件绿**(P0–P8 测试 + 已有测试不退化)
- [ ] dev 启动无 `No handler registered for <channel>`
- [ ] fresh + 旧库启动都正常

### 边界
- [ ] 本阶段纯清理,无功能性改动
