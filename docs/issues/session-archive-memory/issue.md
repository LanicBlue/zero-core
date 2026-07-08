# Issue:session-archive-memory

- **状态**:① issues(问题记录)
- **提出**:2026-07-08
- **类型**:改进(机制加固 / 架构)

## 问题

框架有后台 session(cron 触发、delegated 子代理,跑完就沉在 sessions.db 里),也有压缩引擎(L1 单 turn 压缩 / L2 抽记忆节点写进 wiki memory 树)——但**两者没接上**:后台 session 跑完后不会自动归档,也不会自动把产出沉淀成记忆。记忆提取要主动触发,后台 session 的产出基本"跑完即丢"。需要:① 后台 session 完成后自动归档;② 归档时自动提取记忆(走现有 L2 → wiki memory 路径),让无人值守跑的 session 真正"学到东西留给后续 session"。

## 现状 / 真相源 / 影响面

### session 生命周期
- `src/server/session-db.ts:269` — sessions 表有 `archived` 字段(软删除标记,但**无"已完成/归档"专门状态**,也无完成后自动归档)。
- `src/server/session-db.ts:342-357` — `createSession()` 支持 `"chat"` / `"delegated"`。
- `src/server/session-db.ts:271-275, 407-418` — delegated session 经 `sessionKind="delegated"` + `visibility="hidden"` 从聊天列表排除。
- `src/server/session-db.ts:160-184` — `turn_state` 表含 `phase` + `source`;`source` 标识触发源(user/work/**cron**/**background**)。
- `src/server/session-db.ts:806` — cron 触发 session 标 `source="cron"`。

### session 产出 / 无摘要
- `src/runtime/session.ts:316-336` — `rebuildFromTurns()` 从 turns 表重建历史。
- **无原生"完成后总结"机制**——除非压缩引擎主动跑,产出就是一堆 turns,不会被读回来给后续 session 用。

### cron / 后台触发
- `src/server/cron-analysis.ts:944-982` — `resolveSessionForCron()` 路由 cron session(项目级 + 全局观察)。
- `src/shared/types.ts:1178-1202` — `cron_runs` 表记 `sessionId/success/error/durationMs`(**只记执行元数据,不沉淀产出/记忆**)。

### 框架记忆机制(已存在,但需主动触发)
- `src/runtime/compression-engine.ts:68-94` — L1(单 turn→一句话)+ L2(从压缩 turn 抽记忆节点)。
- `src/runtime/compression-engine.ts:40-44` — L2 产 `MemoryNodeInput { subject, type, content }`。
- `src/server/extraction-cursor-store.ts:37-51` — `extraction_cursor_store` 跟踪每 session 已提取到哪个 step(**支持增量,但没有自动触发点**)。
- `src/shared/types.ts:909-910` — 记忆写进全局 wiki 树的 `memory` 节点(**不是独立 memory store**)。

### recovery(跑一半的 session)
- `src/runtime/agent-loop.ts:567-607` — `resume()` 从 `lastCompletedStepSeq` 续。
- `src/server/session-db.ts:908-978` — `getIncompleteTurns()` / `getIncompleteTurnSessionIds()`。

### gap(待 design 定)
- **无后台 session 完成后的自动归档**(archived 字段在,但没人按时设它)。
- **无 session 完成后自动提取记忆**:压缩引擎 + extraction cursor 都在,但缺触发点(PostTurnComplete? cron 收尾?session 状态翻转?)。
- **记忆只进全局 wiki memory 树**,无项目隔离(对比 wiki 已有 project 沙箱)——后台 session 多为项目级,记忆是否也该 project-scoped。
- **cron_runs 只记元数据**,不串到记忆/产出。

## 下一步

进② design 细化方案(`/effort design`)。design 要定:
- "session 完成"的判定(怎么算跑完 → 触发归档 + 提取)。
- 归档与记忆提取的触发点(hook?cron 收尾?session 状态机?)。
- 提取走现有 L2 + extraction_cursor(复用)还是新建路径;记忆写全局还是 project-scoped。
- 后台 vs 前台 session 的差异化策略(后台必提取,前台按需?)。
- 记忆的去重 / 失效 / 检索(后续 session 怎么读回来用)。
