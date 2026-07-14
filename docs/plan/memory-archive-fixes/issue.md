# Issue:memory-archive-fixes

- **状态**:① issues(问题记录)
- **提出**:2026-07-14
- **类型**:bug(多处)/ 机制加固

## 问题

近期 shipped 的「后台持久化 + 归档 + memory wiki」一整套功能在 Windows 实跑中暴露 4 个问题:归档阻塞前台、settings/memory 的 prompt 配置漏做、memory wiki 写入位置错、memory wiki 在 UI 上无法展开。后两者经核实是**同一个根因**。

## 现状 / 真相源 / 影响面

### ① 归档阻塞前台任务
- [session-router.ts:173-193](../../../src/server/session-router.ts) 的手动归档:`await agentService.archiveSessionManually()` 整段阻塞 HTTP,内部跑完整管线(memory ephemeral turn = 一次 LLM 调用 → teardown → mark → 原子 export → 删行),**全部完成后才** `createSession` 建替代 session。期间用户无法工作。
- 对比同文件 [session-router.ts:140-158](../../../src/server/session-router.ts) 的 DELETE 路径已是「先删 + 立刻建替代 + recreateLoop」的即时模式 —— 归档路径没套用。
- memory turn runner:[agent-service.ts:1080-1130](../../../src/server/agent-service.ts)(手动归档在活跃 loop 上跑)/ [agent-service.ts:1021-1054](../../../src/server/agent-service.ts)(delegated 用 temp loop)。后者已是可复用的后台 temp-loop 范式。

### ② settings/memory 的 prompt 配置漏做
- **压缩摘要 prompt**:`SUMMARY_SYSTEM`([compression-core.ts:158](../../../src/server/compression-core.ts))。compression-archive-simplify sub-3b D2 计划「prompt 在 settings/memory 可配」,引擎侧**已支持** override([compression-core.ts:136-140,406](../../../src/server/compression-core.ts) 走 `opts.summarySystemPrompt`)。但 [MemorySettings.tsx](../../../src/renderer/components/settings/MemorySettings.tsx) **只有模型下拉,没有 prompt 输入框** → 用户改不了。UI 那半 sub 漏了。
- **记忆提取 prompt**:`ARCHIVE_MEMORY_PROMPT`([agent-loop.ts:156-163](../../../src/runtime/agent-loop.ts)),归档前 memory ephemeral turn 用,硬编码,**从未计划可配**。

### ③ memory wiki 写入位置错 + ④ UI 无法展开(共根)
只读查 `project_wiki` 表(6761 行,多为 project wiki)的 memory 部分:
- **DB 里一个 `wiki-root:memory-agent:*` 根节点都没有** —— per-agent 方案(v0.8 P2 §11.6,`ensureMemoryAgentRoot`)从未真正落过行。
- 唯一 memory 叶子「Zero Session Notes」挂在**旧全局 memory 容器**(`854f5747`,parent=`wiki-root:global`,path=`memory`)下,path 是旧格式 `memory:zero-session-notes`,**不是** per-agent 的 `memory:<agentId>:<type>:<slug>`。
- 磁盘对应散落在 `~/.zero-core/wiki/memory/Zero Session Notes__bc97b23c.md`(memory 根层),没进任何 agent 子目录;另有 `auth-system/`、`dev-1/` 两个 agent 子目录(历史 per-agent 写入残留)。

根因:[wiki-tool.ts:673-691](../../../src/tools/wiki-tool.ts) 的 `createMemory` 接受 agent 传入的 parentId,只校验 `parent.path.startsWith("memory")` 就放行 → 旧全局 Memory 容器(path=`memory`)合格,agent 把叶子写到旧容器下,**绕过**了 store 的 per-agent 根机制(`upsertMemoryLeafForAgent`/`ensureMemoryAgentRoot` 从未被 Wiki 工具调到)。
- **③**:叶子落旧容器 → 磁盘散落在 memory/ 根层。
- **④**:[wiki-anchor-injection.ts:174-180](../../../src/runtime/wiki-anchor-injection.ts) 给每个 session 注入的 memory 锚点 = `wiki-root:memory-agent:<agentId>`(DB 里不存在);[WikiTreePanel.tsx:79-84](../../../src/renderer/components/layout/WikiTreePanel.tsx) `expandNode` 它 → `getChildren` 空 → 展开是空的。

## 下一步

进② design 细化方案(`/effort design`)。③④ 合并修(共根)。
