# Design:memory-archive-fixes

> 状态:**决策已定,可进 plan**。
> 对应 issue:[`./issue.md`](./issue.md)(同目录,随文件夹流转)。

## 问题回顾(详见 ./issue.md)

4 个问题:①归档阻塞前台;②settings/memory 的 prompt 配置漏做(压缩 prompt 引擎支持但 UI 没做、记忆提取 prompt 硬编码);③memory wiki 写入旧容器致磁盘散落 + ④UI memory 根展开空(③④共根:createMemory 绕过 per-agent 根)。

## 关键事实(审计)

### 归档管线(①)
- 手动归档入口 [session-router.ts:173-193](../../../src/server/session-router.ts) 同步 await 全管线 → 才建替代 session。DELETE 路径 [session-router.ts:140-158](../../../src/server/session-router.ts) 已是「即时 swap」范式可照搬。
- `archiveSessionManually` [agent-service.ts:1080](../../../src/server/agent-service.ts) 的 memory turn runner 在**活跃 loop** 上跑;delegated 路径 `runDelegatedArchiveMemoryTurn` [agent-service.ts:1021-1054](../../../src/server/agent-service.ts) 已是 **temp loop**(从已持久化 steps 重建上下文)范式 —— 上下文等价,可复用。
- 崩溃恢复 `recoverInterruptedArchives` [archive-service.ts:599](../../../src/server/archive-service.ts) 已扫 `archived=1` 残留重 export;后台化后失败仍由它兜底。
- per-session 锁 `withArchiveLock` [archive-service.ts:268](../../../src/server/archive-service.ts) 已防同 session 并发;后台化不破坏。

### memory 写入路由(③④)
- `createMemory` [wiki-tool.ts:673-691](../../../src/tools/wiki-tool.ts):接受 agent 传 parentId,只校验 `parent.path.startsWith("memory")`。旧全局 Memory 容器(path=`memory`)合格 → agent 把叶子写到旧容器,path 退回 `memory:<slug>` 旧格式。
- store 侧 per-agent 机制**齐全但没被 Wiki 工具调到**:`ensureMemoryAgentRoot` `wiki-node-store.ts:1541` + `upsertMemoryLeafForAgent` `wiki-node-store.ts:1572`(leaf path `memory:<agentId>:<type>:<slug>`)。
- agent 的 memory 锚点 = `wiki-root:memory-agent:<agentId>`(synthetic,`wiki-anchor-injection.ts:174-180`),DB 里无行 → `expandNode` 空(UI ④)。
- 磁盘布局 `diskPathFor` `wiki-node-store.ts:702`:per-agent 根 → `WIKI_DISK_ROOT/memory/<seg>/`,seg 取 `subtreeSeg` `wiki-node-store.ts:661` = **agentId**(非 agentName)。rename 迁移机制已存在 `wiki-node-store.ts:534-543`。

### settings prompt(②)
- 引擎支持压缩 prompt override:`opts.summarySystemPrompt ?? SUMMARY_SYSTEM` [compression-core.ts:406](../../../src/server/compression-core.ts)。
- **读侧已接好**:[compression-trigger-hooks.ts:290-292](../../../src/runtime/hooks/compression-trigger-hooks.ts) 已把 `config.compression.summarySystemPrompt` 转进 opts。config-router [config-router.ts:197-209](../../../src/server/config-router.ts) 整块存 `configData.compression`。→ **压缩 prompt 只差 UI 加 textarea**。

### topic memory 已死(影响 sub-2)
- `extractor-a-service.ts` 主体已删([agent-service.ts:519](../../../src/server/agent-service.ts)、[index.ts:154,250](../../../src/server/index.ts) 明确 "deleted"),代码里只剩注释引用。
- `wiki-root:memory-topic:*` / `createMemoryNodeForTopic` / `ensureMemoryTopicRoot` 是**孤儿** —— createMemory 的 topic-parent 分支不可达。→ sub-2 不必保 topic 路径,收紧到 per-agent 根即可(topic 相关是可清的死代码)。

## 方案

### Sub-1 归档非阻塞化(①)

**A — swap+mark 同步 / memory turn + export + delete 后台(temp loop)**
session-router archive handler 改两段式:
1. 同步:`markArchivedTransient(old)` → `evictSessionFromMemory(old)`(停旧 loop)→ `createSession` 替代 + handover main + recreateLoop → 立即 res 返 newSessionId。
2. 后台(不 await,`.catch` log):`archiveSession(old, {memoryTurnRunner: tempLoopRunner})` 跑 memory turn(用 delegated 那套 temp loop,从持久化 steps 重建)→ export → 删行。锁 + 恢复扫描兜底。

优点:前台零阻塞;复用 delegated temp-loop 范式;崩溃恢复已有。缺点:旧活跃 loop 立即 evict,memory turn 改用 temp loop(上下文等价,但不再是「活跃 loop 自写」)。

**B — 保留旧 loop 隐藏跑 memory turn,再后台 export**
swap 后不 evict 旧 loop,藏在后台跑 memory turn,完事再 evict+export。
缺点:旧 loop 仍占资源 / 仍可能被路由命中 / 并发面大;不如 A 干净。**否决**。

### Sub-2 memory 写入路由统一 + 磁盘用 agentName(③④)

**A — 收紧 createMemory parent + 锚点解析时 ensureMemoryAgentRoot**
1. `isMemoryParent` [wiki-tool.ts:687-689](../../../src/tools/wiki-tool.ts) 收紧:**拒绝**旧全局容器(path===`memory`),只放行 `wiki-root:memory-agent:*` / `wiki-root:memory-topic:*` / 其下 memory 叶子。
2. memory 锚点注入时(`resolveAnchors` 或 wiki 工具初始化)调 `ensureMemoryAgentRoot(agentId, agentName)` 落行 → agent 在 outline 看到自己的 per-agent 根 → createMemory 传它 → leaf 落正处。topic 路径(Extractor A)不受影响(走 memory-topic 根)。
3. 磁盘 seg 改 agentName:`subtreeSeg` 对 memory-agent 根返 agentName(需 callerCtx 带 agentName,或读 agents 表)。agent 改名 → 复用 rename 迁移 `wiki-node-store.ts:534` 迁磁盘文件夹。
4. 启动清理(不写迁移):删除旧全局 Memory 容器(`path=memory`)+ 其下所有叶子(test 数据,用户已确认可删);清孤儿磁盘目录 `auth-system/`、`dev-1/`(无 DB 行残留)。topic memory 死代码(`ensureMemoryTopicRoot`/`createMemoryNodeForTopic`/`wiki-root:memory-topic:*` 分类)顺手清。

优点:根因修复;agentName 可读;无迁移归属负担。缺点:旧 memory 数据丢失(用户已确认全是测试数据,可接受)。

**B — createMemory 无视 parentId,强制走 callerCtx.agentId 的 per-agent 根**
更简单。topic memory 已死(见上),不再需要保 topic 路径 → **B 现在可行**。但 B 隐藏了 agent 对 memory 结构的自主性(以后若恢复多根会再改)。倾向 **A**(显式收紧 parent + ensureRoot),B 作备选。

### Sub-3 settings/memory 补 prompt(②)

### Sub-3 settings/memory 补 prompt(②)

1. MemorySettings 加「压缩摘要 prompt」textarea,绑 `config.compression.summarySystemPrompt`(空 = 默认 SUMMARY_SYSTEM);审/接 compression-trigger-hooks 把它传入 `opts.summarySystemPrompt`。
2. (待决)加「记忆提取 prompt」textarea,绑新 config 字段(如 `archive.memoryPrompt`),`runManualArchiveMemoryTurn`/`runDelegatedArchiveMemoryTurn` 读它覆盖 `ARCHIVE_MEMORY_PROMPT`(空 = 默认 const)。

## 推荐

- Sub-1:**A**(temp loop 后台)。Sub-2:**A**(收紧 parent + ensureRoot + agentName 磁盘 + 启动迁移)。Sub-3:压缩 prompt 必做;记忆提取 prompt 待决(倾向做)。

## 已定决策(2026-07-14 用户拍板)

1. **Sub-1 后台归档完成**:**静默 + 日志**(不给前端发事件)。
2. **Sub-2 旧全局 Memory 容器**:**删除**(不隐藏/不留档)。
3. **Sub-2 旧叶子**:无需迁移归属,**直接删**(目前全是测试运行、无重要数据)。→ sub-2 **不写迁移逻辑**,启动时把旧 `path=memory` 容器 + 其下叶子一并删掉即可。同时清孤儿磁盘目录(`auth-system/`、`dev-1/` —— 无 DB 行的历史残留)。
4. **Sub-3 记忆提取 prompt**:**做** —— MemorySettings 加第二个框,绑 config(如 `archive.memoryPrompt`),`runManualArchiveMemoryTurn`/`runDelegatedArchiveMemoryTurn` 读它覆盖 `ARCHIVE_MEMORY_PROMPT`(空 = 默认 const)。
5. **磁盘命名**:**agentName**(agent 改名触发磁盘 rename 迁移)。topic memory 已死,sub-2 不保 topic 路径(可清死代码)。压缩 prompt 读侧已接好,sub-3 压缩部分纯加 UI textarea。

## 下一步

决策已定 → `/effort plan` 拆 sub(sub-1/2/3 各配 acceptance,③④并入 sub-2)。
