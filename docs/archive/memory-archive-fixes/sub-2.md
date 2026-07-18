# Sub-2:memory 写入路由统一 + 磁盘 agentName + 清旧

> 所属 effort:[memory-archive-fixes](./design.md)。修 issue ③④(共根)。

## 目标
agent 写 memory 一律落到**自己的 per-agent 根**(`wiki-root:memory-agent:<agentId>`,leaf path `memory:<agentId>:<type>:<slug>`),磁盘镜像在 `~/.zero-core/wiki/memory/<agentName>/`。UI memory 锚点能展开看到自己的 memory 叶子。旧全局容器 + 散落叶子 + 孤儿磁盘目录清掉(test 数据,用户已确认可删)。

## 机制

### A. createMemory 收紧 parent(根因修复)
[wiki-tool.ts:673-691](../../../src/tools/wiki-tool.ts) `isMemoryParent`:
- **拒绝**旧全局容器(`parent.path === "memory"` —— 即 `854f5747` 那个 legacy container)。
- 只放行 `wiki-root:memory-agent:*` + 其下 memory 叶子。
- topic 路径(`wiki-root:memory-topic:*`)已死,从 isMemoryParent 删除(顺手清死代码)。
- agent 传非法 parent → 返回清晰错误,指明应用自己的 memory 根锚点 id。

### B. 锚点注入时 ensureMemoryAgentRoot 落行
agent 的 memory 锚点 = `wiki-root:memory-agent:<agentId>`(synthetic,当前 DB 无行)。在 Wiki 工具的 scope/anchor 解析处(构 anchors 时)调 `ensureMemoryAgentRoot(agentId, agentName)`(`wiki-node-store.ts:1541`)→ 行落库 → agent 在 outline 看到自己的根 → createMemory 传它 → leaf 落正处。
- agentName 从 callerCtx / agents 表取,一并传 ensureMemoryAgentRoot(它已用 agentName 设 title)。

### C. 磁盘 seg 用 agentName
`wiki-node-store.ts:661` `subtreeSeg`:对 `wiki-root:memory-agent:` 根,返 **agentName**(非 agentId)。diskPathFor → `WIKI_DISK_ROOT/memory/<agentName>/`。
- agentName 需对 disk seg 安全(复用 sanitizeSeg)。空/冲突 → fallback agentId。
- **agent 改名 → rename 磁盘文件夹**:复用既有 rename 迁移机制 `wiki-node-store.ts:534-543`。在 agent-rename 路径(agent-service/agent-store)触发 memory 根的 disk rename + title 更新(ensureMemoryAgentRoot 已纠 title,见 `wiki-node-store.ts:1543-1549`)。本 sub 接 rename 触发;若 agent-rename 钩子不存在,至少保证**新写**用 agentName(改名迁移作 follow-up 也在接受范围 —— 待验既有 rename 机制覆盖面)。

### D. 启动清理(不写迁移,直接删)
启动 index.ts(recoverInterruptedArchives 旁):
- 删 legacy 全局 Memory 容器(`path=memory`,id=`854f5747...`)+ 级联其下所有叶子(delete cascades children + disk body)。决策 2/3 = 删除。
- 清孤儿磁盘目录 `~/.zero-core/wiki/memory/auth-system/`、`dev-1/`(无 DB 行的历史残留)。
- 保留 per-agent 根目录(有 DB 行的)。

### E. 清 topic memory 死代码(顺手)
`ensureMemoryTopicRoot` / `createMemoryNodeForTopic` / `upsertMemoryLeafForTopic` / `memoryTopicRootId` / `MEMORY_TOPIC_PATH_PREFIX` + 分类逻辑里的 `wiki-root:memory-topic:` 分支 —— Extractor A 已删,这些无人调。本 sub 删掉(减负)。若删除波及面过大(被分类逻辑多处引用),保留分类分支但删 store 方法,acceptance 以「createMemory 不再接受 topic parent」为准。

## 改动文件
- [wiki-tool.ts](../../../src/tools/wiki-tool.ts):isMemoryParent 收紧 + 删 topic 分支。
- `wiki-node-store.ts`:subtreeSeg 用 agentName;删 topic 死代码。
- wiki-anchor-injection.ts 或 Wiki 工具 scope 构建处:ensureMemoryAgentRoot 落行。
- [index.ts](../../../src/server/index.ts) 启动:加 legacy 容器 + 孤儿目录清理(挨着 recoverInterruptedArchives)。
- agent-rename 路径:触发 memory 根 rename(若既有机制未覆盖)。

## 范围边界(不做)
- 不迁移旧叶子归属(决策 3 = 直接删)。
- 不动 project wiki(project_id 非空的 6759 行)。
- 不改 anchor 注入的 inject 通道(memory 仍 system 注入)。

## 风险
- **ensureMemoryAgentRoot 调用时机**:放 anchor 解析处要在 read 路径上写 DB(副作用)。需确认 anchor 解析允许写(或挪到首次 createMemory 时 lazy ensure)。lazy ensure 更干净:createMemory 解析 synthetic memory-agent 锚点 id 时 ensure → 落行 → 再 resolve。
- **agentName 磁盘 seg 安全**:sanitizeSeg 后若空/含非法字符,fallback agentId(保证可写)。
- **既有 rename 机制覆盖面**:若不覆盖 memory 根 disk rename,改名后旧文件夹残留 —— 接受(新写用新名),作已知限制记入 acceptance。
