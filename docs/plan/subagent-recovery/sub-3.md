# sub-3:recovery 按 session_kind 分流 + 懒重建

> 依赖:无(纯 recovery 层,可与 sub-1 并行)。对应 design §2.2、§2.4。

## 实际实现(本次)

**核心修复(已落)**:`doRecoverIncompleteSessions` 加 `session_kind` 过滤 —— `session.sessionKind === "delegated"` 的子 **跳过 auto-resume**(冻结,turn_state 留 incomplete),只有 chat session auto-resume。这是关键正确性修复(消除子脱钩 auto-run)。

**延后**:
- **懒重建 `restoreAllSessions`**:`listAllSessions` 已过滤 `session_kind='chat'`([session-db.ts:363](../../../src/server/session-db.ts#L363)),delegated 本就不被 restore。chat session 的 eager 重建是启动成本,非正确性 bug;改懒风险高(需审 getRuntimeTaskTree/config-sync/metrics 对 loop 已建的假设),留作后续优化。
- **interrupted-status seed**:冻结子 task 在 workbench 显 `Interrupted` 的 seeding 逻辑属 sub-4(workbench/TaskGet 处理 interrupted task),不在本 sub。

## 目标

启动 recovery 按 `session_kind` 分流:父 chat session auto-resume,委派 delegated session 冻结等父决策。同时把 `restoreAllSessions` 改成懒重建。

## 范围 / 改动

- **`doRecoverIncompleteSessions`**([agent-service.ts:1047](../../../src/server/agent-service.ts#L1047)):
  - 遍历 `getIncompleteTurns()` 时加 `session_kind` 过滤 —— 只 `session_kind='chat'` 的 auto-resume。
  - `session_kind='delegated'` 的子:**跳过 auto-resume**,冻结(turn_state 留 incomplete)。
- **`restoreAllSessions`**([agent-service.ts:1104](../../../src/server/agent-service.ts#L1104)):
  - 改懒:只给"有 incomplete turn"的 session 建 loop;其余推迟到 `activateSession`(UI 显示,已有)或父续子时(sub-4 TaskResume)。
- **`restoreDelegatedTasks`**([agent-loop.ts:464](../../../src/runtime/agent-loop.ts#L464)):确保 seed 的中断子带 `status: "interrupted"`(TaskInfo 已有该枚举)→ 父 workbench 显 Interrupted。
- **审计**:`this.loops.has` / `getRuntimeTaskTree` / config-sync 等假设 loop 已建的地方,改成按需建或容忍缺失。

## 不在本 sub

- TaskResume 续冻结子(sub-4)。
- workbench 显 Interrupted 的渲染(sub-1 通道 + sub-4 收件箱)。

## 风险

- 懒重建后,任何假设"启动时所有 loop 都已建"的代码会断 —— 需审 `getRuntimeTaskTree`(递归 runningSubloops)、config-sync target、metrics 等。
- 冻结子的 turn_state 一直 incomplete,下次重启幂等再现(已接受,§2.3)。

## 验收

见 `acceptance-3.md`。
