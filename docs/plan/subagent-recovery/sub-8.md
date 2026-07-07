# sub-8:补完 sub-3 —— 懒重建 + interrupted-status seed

> sub-3 欠交付补完。依赖 sub-1(workbench)、sub-3(recovery 冻结)。对应 design §2.2、§2.4。

## 背景(为什么欠交付)

sub-3 只做了 recovery 冻结过滤(delegated session 不 auto-resume),两件 sub-3.md scope 内的事没做:
1. **懒重建**:`restoreAllSessions`([agent-service.ts:1104](../../../src/server/agent-service.ts#L1104))仍 eager 给所有 chat session 建 loop(design §2.4 要懒)。
2. **interrupted-status seed**:冻结子的 task 记录进父 registry 时没标 `Interrupted`(design §2.3 要父 workbench 显 `[taskX] Interrupted`)。

## 任务

1. **懒重建 `restoreAllSessions`**:
   - 只给"有 incomplete turn"的 session 建 loop;其余推迟到 `activateSession`(UI 显示,已有)。
   - 仍保留 `activeSessions` 锚定(agentId → 最近 session),供 UI/activation。
   - **审假设**:`this.loops.has` / `getRuntimeTaskTree` / config-sync / metrics / sessionManager 等所有假设"启动时 loop 已建"的地方,改成按需建(`getOrCreateLoop` 模式)或容忍缺失。

2. **interrupted-status seed**:
   - `restoreDelegatedTasks`([agent-loop.ts:464](../../../src/runtime/agent-loop.ts#L464))seed 冻结子时,若子 session 有 incomplete turn_state(`session_kind='delegated'` + turn_state phase 非 completed/failed)→ seed status = `"interrupted"`(TaskInfo 已有该枚举)。
   - 父 workbench Task 段(读 registry)据此显 `[taskX] Interrupted`。
   - waited 时间:`TaskGet(interrupted)` 已实现(sub-4)读 `now − created_at`;seed 时 registry 记录带 startedAt/createdAt 供其算。

## 风险

- 懒重建是启动行为改动,易触多处假设;需全面 audit + 回归(UI 列表、metrics、config-sync)。
- interrupted seed 判定要查子 session 的 turn_state(跨表:delegated_tasks → session_id → turn_state),注意性能(批量查)。

## 验收

见 `acceptance-8.md`。
