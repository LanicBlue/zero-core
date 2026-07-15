# Issue: archive-no-residual

- **状态**:① issues(问题记录)
- **提出**:2026-07-15
- **类型**:改进(架构/正确性)

## 问题

委托任务(delegated task)进入终态后,系统不应留下任何遗留——两条不变式:

1. **任务结束**:`delegated_tasks` 行删除,指向的子 session 归档。
2. **父 session 归档**:它派发的 `delegated_tasks` 行删除,这些行指向的子 session 归档(递归)。

> 「不应该有遗留。」

## 现状 / 真相源 / 影响面

### 已正确实现的部分(归档管线本身是崩溃可恢复的)

[archive-service.ts](../../src/server/archive-service.ts) 的 `archiveSession` 已是**二级缓冲 + 启动恢复**模型,对应用户设计后两点:

- **① memory ephemeral turn(可选)**:子 session 归档前跑一轮 `persist:false` turn 让 agent 自写 wiki([archive-service.ts:363-381](../../src/server/archive-service.ts#L363-L381))。
- **② mark `archived=1`(瞬态检查点)**:[`markArchivedTransient`](../../src/server/session-db.ts) — mark→export+delete 之间崩 → 重启可恢复([archive-service.ts:393-397](../../src/server/archive-service.ts#L393-L397))。
- **③ 原子 export**:`<id>.json.tmp` → JSON.parse 校验 → `rename` → 才 `deleteSessionData`([archive-service.ts:505-540](../../src/server/archive-service.ts#L505-L540))。任一步失败 → 不删行、可重试。
- **④ 启动恢复扫描**:[`recoverInterruptedArchives(db)`](../../src/server/archive-service.ts#L599) 在 `index.ts` 启动时扫 `archived=1 且仍有行` 的 session,重 export + 删行。

即「session 归档写入记忆需要时间、做二级缓冲、启动恢复被打断的归档」**已落地**。

### 真正的缺口

#### Gap A:terminal 归档触发未在所有派发 loop 上接线

`archiveDelegatedSession` 的回调**只在一处赋值**:
[agent-service.ts:1385](../../src/server/agent-service.ts#L1385) `sessionConfig.archiveDelegatedSession = ...`,位于 `createLoopForSession`。

而 [sendProjectPrompt 的 lazy-rebuild](../../src/server/agent-service.ts#L1654) (`if (!loop) new AgentLoop(...)`) **不接** `archiveDelegatedSession` → 该 loop 派的子 agent 进入终态时,[delegator `fireOnTaskTerminal`](../../src/runtime/subagent-delegator.ts#L260) 因 `onTaskTerminal` 为 `undefined` 在 [L261](../../src/runtime/subagent-delegator.ts#L261) 早退 → **子 session 永不归档** → 子 session + `delegated_tasks` 行同时遗留。

这正是用户 DB 实测 **264 行 completed** 累积的根因之一(那批 wiki 标注/探索任务很可能由 project loop 派发)。

#### Gap B:`delegated_tasks` 行删除绑在慢归档末尾

当前行删除发生在归档管线**最末**的 `deleteSessionData`(按 `session_id` 删 [session-db.ts](../../src/server/session-db.ts))。意味着:

- memory turn(秒级~分钟级 LLM 调用)跑完 + export 成功之前,**行一直留**;
- Gap A(归档根本没触发)→ 行永远留;
- 用户实际观察到的「task 完成 get 后仍留在 UI」即此(行在 → [restoreDelegatedTasks](../../src/runtime/agent-loop.ts#L1265) loop 重建时 re-seed 回内存 registry)。

已落地的 band-aid:`delegator.cleanup()` TTL 1h 清终态行(tool-quality-pass 后续,e82311c)——治标,不修管线。

#### Gap C:父 session 归档不级联

`deleteSessionData` 只按 `session_id`(自身)删,不按 `parent_session_id` 级联子任务 + 子 session。父归档时它派发的整棵委托子树成孤儿(`listDelegatedTasks({parentSessionId})` 查询能力 [session-db.ts:1708](../../src/server/session-db.ts#L1708) 已有,归档路径没用)。

## 下一步

进 ② design 细化方案(`/effort design`)。核心待决策:

1. **行删除与慢归档解耦**(用户设计点 1):terminal 时立即删 `delegated_tasks` 行——但归档触发要用到行里的 `sessionId`/`targetAgentId`/`modelId`([archiveDelegatedSession:987-989](../../src/server/agent-service.ts#L987-L989)),故**删行须排在「捕获子 session 信息 + fire 归档」之后**(同 tick,fire-and-forget)。
2. **Gap A 接线**:`sendProjectPrompt` 的 loop(及任何其它建 loop 处)接 `archiveDelegatedSession`,或抽共享建 loop 原语。
3. **Gap C 父归档级联**:父 session 归档时按 `parent_session_id` 递归归档子 session + 删行。
4. **cleanup-TTL 去留**:管线修好后 TTL 是纯安全网还是删除。
5. **孤儿子 session 兜底**:行已立即删但归档从未触发(Gap A 修好前已累积的存量)的子 session,如何被启动扫描发现并归档。

**暂不实施。**
