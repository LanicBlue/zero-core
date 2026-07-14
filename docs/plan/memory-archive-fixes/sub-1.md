# Sub-1:归档非阻塞化

> 所属 effort:[memory-archive-fixes](./design.md)。修 issue ①。

## 目标
手动归档(chat 归档按钮)不再阻塞前台:点归档 → 立刻 swap 到干净新 session 可继续工作;memory turn + export + 删行在后台跑,静默 + 日志,失败由既有恢复扫描兜底。

## 机制
session-router 的 `POST /:agentId/:sessionId/archive` 改两段式:

**同步段(阻塞 HTTP,毫秒级)**:
1. `db.markArchivedTransient(oldId)` —— 打 archived=1 瞬态检查点(既有)。
2. `agentService.evictSessionFromMemory(oldId)` —— 停旧 loop + 清 in-memory hook state(既有,archive teardown 已用)。
3. `db.createSession(agentId, undefined, old.context)` + handover main + `recreateLoop`(照搬 DELETE 路径 [session-router.ts:140-158](../../../src/server/session-router.ts))。
4. 立即 `res.json({ success, newSessionId })`。

**后台段(不 await,`.catch(log)`)**:
5. `agentService.archiveSessionInBackground(oldId)` —— 新方法:用 **temp loop**(从持久化 steps 重建,复用 `runDelegatedArchiveMemoryTurn` [agent-service.ts:1021-1054](../../../src/server/agent-service.ts) 范式)跑 memory ephemeral turn → 调既有 `archiveSession` 走 export + 删行。temp loop 必需,因为旧活跃 loop 已在同步段 evict。
   - `archiveSession` 的 mark 在这里再次执行(idempotent,no-op 若已 archived=1)。
   - per-session 锁 `withArchiveLock` 既有,防并发。
   - 失败 → log warn,行仍在(archived=1),下次启动 `recoverInterruptedArchives` 兜底。

## 改动文件
- [session-router.ts](../../../src/server/session-router.ts):archive handler 重写为两段式(同步 swap + 后台 archive)。
- [agent-service.ts](../../../src/server/agent-service.ts):
  - 新增 `archiveSessionInBackground(sessionId)`:构 temp-loop memoryTurnRunner(复用 `buildSessionConfigForArchive` + `runDelegatedArchiveMemoryTurn` 的 temp-loop 构造)+ 调 `archiveSession`。无 teardown(旧 loop 已 evict)。
  - `archiveSessionManually` 保留(给非 swap 场景/测试),或标记 deprecated。本 sub 不删,避免破既有测试。
- 不动 archive-service.ts 管线本身(锁/恢复/export 都复用)。

## 范围边界(不做)
- 不动 delegated 自动归档路径(本就 fire-and-forget,非阻塞)。
- 不改归档 JSON 格式。
- 不加前端「归档完成」事件(决策 1 = 静默)。
- 不动 DELETE 路径。

## 风险
- **temp loop 上下文等价性**:从持久化 steps 重建,与活跃 loop 的 in-memory 视图等价(steps 是唯一真相源)。需验证 ephemeral turn 的 wiki 写入落到对的 agent memory 根(依赖 sub-2 的 per-agent 根已 ensure)。
- **路由命中旧 archived session**:swap 后 main = 新 session,旧 session archived=1 不再被路由命中。需确认 sidebar/routing 不再列 archived session(既有行为)。
