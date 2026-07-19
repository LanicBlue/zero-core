# Issue: archive-observability

- **状态**:① issues(问题记录)
- **提出**:2026-07-15
- **类型**:改进(可观测性)
- **来源**:2026-07-15 每日扫描建议(方向 1)

## 问题

memory-archive-fixes sub-1 把手动归档改成「两阶段:SYNC swap + BACKGROUND memory turn→export→delete」,决策为**静默 + 日志**(见 [archive/memory-archive-fixes/design.md](../../archive/memory-archive-fixes/design.md) 已定决策 1)。前台零阻塞的目标达成了,但**静默 = 用户/系统无法感知归档的进度与成败**:后台失败时只有 stderr 日志,前端无任何指示,用户以为归档成功实则记忆未落盘。`recoverInterruptedArchives`([archive-service.ts:599](../../../src/server/archive-service.ts#L599))是崩溃后的兜底重扫,**不是运行时状态可见性**——它只在启动时跑,且不暴露"当前在跑 / 上次结果"。

## 现状 / 真相源 / 影响面

### 归档管线现状(memory-archive-fixes 后)
- 入口 [session-router.ts:186](../../../src/server/session-router.ts#L186) `POST /:agentId/:sessionId/archive`,两阶段:SYNC(markArchivedTransient + evict + createSession 替代 + recreateLoop,立即 res)→ BACKGROUND(`archiveSessionInBackground`)。注释见 [session-router.ts:160-186](../../../src/server/session-router.ts#L160)。
- 后台管线在 [agent-service.ts](../../../src/server/agent-service.ts):temp-loop 跑 memory turn → `archiveSession`([archive-service.ts:327](../../../src/server/archive-service.ts#L327))→ mark(idempotent)→ 原子 export → 删行。失败走 `.catch` 只 log。
- 并发防护 [archive-service.ts:268](../../../src/server/archive-service.ts#L268) `withArchiveLock`(per-session Map)。
- 崩溃恢复 [archive-service.ts:599](../../../src/server/archive-service.ts#L599) `recoverInterruptedArchives`:启动扫 `archived=1` 残留重 export。

### 缺口(无可观测性)
- **无 job 记录**:后台归档不落任何"job/task"行,失败后除日志外无结构化痕迹,事后难追溯。
- **无状态查询**:`/api` 无"当前归档在跑 / 上次归档结果"端点。
- **无前端指示**:用户点归档后立刻换新 session,看不到旧会话归档是否真正完成。
- **无重试入口**:失败只能等下次启动 `recoverInterruptedArchives` 兜底,不能手动重试单个失败归档。

### 影响面(若推进)
新增归档 job 状态持久化(轻量表或复用现有 store)+ `/api/archive/status`(及可选 `/archive/retry`)+ 前端小指示器(归档中 / 上次结果 / 失败重试)。**复用** `withArchiveLock` 与 `recoverInterruptedArchives`,不改管线本体,只在其外层加状态记录与暴露。

## 下一步

等待 Ready、尚未实施的
[`backend-io-scheduling`](../../plan/backend-io-scheduling/README.md) Final。它已决定提供
通用 MaintenanceJob store、archive job 状态以及 cancel/retry/status API；本 issue 后续进
② design 时不再新建第二套 job 表或 archive retry 真相源，只设计用户可见的归档入口、
状态和失败操作（全局、Session 行内或 Dashboard 的具体形态）。在该 effort 实施前，本页
描述的现状缺口仍然成立。**暂不实施。**
