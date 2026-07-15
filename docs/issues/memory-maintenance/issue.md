# Issue: memory-maintenance

- **状态**:① issues(问题记录)
- **提出**:2026-07-15
- **类型**:改进(记忆质量 / 机制)
- **来源**:2026-07-15 每日扫描建议(方向 2)

## 问题

per-agent memory 子树(`wiki-root:memory-agent:<agentId>`,memory-archive-fixes sub-2 刚统一了写入路由)是当前唯一长期记忆主线,但**完全没有"维护阶段(memory maintenance)"**——记忆一旦写入就永久静置,**跨子树的语义重复、同主题矛盾、过时记忆无人治理**。随记忆累积,树会越来越脏:agent 把 stale 记忆和 fresh 上下文同等对待。业界共识(Letta / Zep / Mem0 与 [arXiv 2606.06448](https://arxiv.org/html/2606.06448v1) 的 maintenance 阶段)把长期记忆的 **dedup / consolidation / conflict resolution / forgetting** 列为必备四件套。compression-archive-simplify sub-3a 的 fresh-tail 边界去重只防**相邻**重复,不防**跨子树**重复。

## 现状 / 真相源 / 影响面

### 记忆写入路径(memory-archive-fixes 后)
- per-agent 根 [wiki-node-store.ts](../../../src/server/wiki-node-store.ts) `ensureMemoryAgentRoot` / `memoryAgentRootId`(~[331](../../../src/server/wiki-node-store.ts#L331) / [338](../../../src/server/wiki-node-store.ts#L338) 行),叶子 `upsertMemoryLeafForAgent`,磁盘 seg 用 agentName(sub-2)。
- 写入触发器:压缩流程(compression-archive-simplify)+ memory turn(归档前)+ `Wiki` 工具(agent 手动)。**三者全部只写不维护**。

### 现有可复用元数据(project_wiki 列,[db-migration.ts:821](../../../src/server/db-migration.ts#L821))
已有:`created_at`、`updated_at`、`provenance`(可扩展承载 maintenance 历史)、`flags`(TEXT,可承载维护标记)、`relations` / `links`。
**缺失**:无 `last_accessed` / `access_count`(**读不计数**,无法做 recency 衰减召回);无任何相似度 / 冲突检测能力。

### ⚠️ 关键约束:无向量能力可复用
KB 子系统(`kb-*.ts` / `knowledge.db` / 向量检索)**已从 `src/server` 删除**(与 [arch/06-knowledge-subsystems.md](../../arch/06-knowledge-subsystems.md) 描述不符,文档待更)。当前 `src/` 内无任何 embedding / 向量调用(`package.json` 仅 `@ai-sdk/openai`,用于 chat)。→ 语义去重**不能**假设有现成向量基础设施,需在 design 阶段定机制:

- **方案 A — LLM 驱动合并(推荐起点)**:维护 pass 调 LLM 对某 agent 的 memory 子树做 dedup / 合并 / 冲突消解,产物回写(可标 provenance=`maintained`)。**贴合现有 compression / archive 的 LLM 驱动风格,零新依赖**。
- **方案 B — 重引入 embedding**:加 embedding provider + 向量存储,做语义近邻去重。能力强但工作量大、要新 provider 配置(等同把删掉的 KB 能力以"记忆维护"角色重新引入)。

### 影响面(若推进)
memory-agent 子树维护 hook(挂在归档后 / 周期 cron / 手动)+ 可能的 schema 扩列(`last_accessed` / `access_count`)+ 读侧埋点(`Wiki` 工具 docRead / ExpandNode 时计数)+ 维护产物回写路径。方案 A 改动集中在 server 新增一个 service + 复用现有 provider;方案 B 额外引入 embedding 管线(更大)。

## 下一步

进 ② design 细化方案(`/effort design`)。核心待决策:① 维护机制选 A(LLM 合并)还是 B(embedding),还是先 A 后 B;② 维护触发时机(每次归档后 / 周期 cron / 手动 API);③ 是否加 `last_accessed` / `access_count` 做衰减召回(涉及读埋点 + 索引);④ 冲突消解策略(同 subject 不同 value 时,保留 / 合并 / 标记由谁裁决——agent、维护 LLM、还是用户)。**暂不实施。**

> 附带:建议更 [arch/06-knowledge-subsystems.md](../../arch/06-knowledge-subsystems.md),把 KB 已删的事实同步进去(当前该文档仍把 KB 描述为"冻结但仍存在"的唯一真相源,与代码不符)。
