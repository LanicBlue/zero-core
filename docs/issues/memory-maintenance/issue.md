# Issue: memory-maintenance

- **状态**:① issues(问题记录)
- **提出**:2026-07-15
- **类型**:改进(记忆质量 / 机制)
- **来源**:2026-07-15 每日扫描建议(方向 2)

> **⚠️ 现状校正（2026-07-18，wiki-system-redesign cutover 后）**：本 issue 撰写于 cutover 前,下文 legacy 记忆主干描述(`wiki-root:memory-agent:<agentId>` 寻址 / `wiki-node-store.ts` `ensureMemoryAgentRoot` / `project_wiki` 表列)均**已被超越(overtaken)**。当前唯一长期记忆主干是 `db/wiki.db` 的 `wiki-root/memory/<agentId>` 子树(canonical path + `memory://` 逻辑地址 + `memory_type` / `durability` / `confidence` / `review_after` attributes + FTS5)。本 issue 的**核心关切——memory maintenance（dedup / consolidation / conflict resolution / forgetting）——依然有效且适用**于新 wiki.db 记忆子树;只是落地机制需基于 `wiki_nodes` 表(可扩 `last_accessed` / `access_count` 列 + 复用 Wiki 工具读侧埋点),而非已删的 `project_wiki`。详见 [docs/plan/wiki-system-redesign/](../../plan/wiki-system-redesign/)。下文凡 `project_wiki` / `wiki-node-store` / `wiki-root:memory-agent:` 描述按**历史问题陈述**理解,不代表当前架构。

## 问题

per-agent memory 子树（`wiki-root:memory-agent:<agentId>`）是当前长期记忆主线，但没有独立的 maintenance 流程来系统处理跨节点去重、合并、冲突和过时信息。现有 Wiki 工具可以人工更新/删除节点，memory turn 也能继续写入，但没有后台治理或可测量的淘汰策略。外部 memory 系统与相关论文仅作为 design 研究输入，不能直接证明 zero-core 必须采用同一机制。

## 现状 / 真相源 / 影响面

### 记忆写入路径(memory-archive-fixes 后)
- per-agent 根 `wiki-node-store.ts` `ensureMemoryAgentRoot` / `memoryAgentRootId`(~`331` / `338` 行),叶子 `upsertMemoryLeafForAgent`,磁盘 seg 用 agentName(sub-2)。
- 写入触发器:压缩流程(compression-archive-simplify)+ memory turn(归档前)+ `Wiki` 工具(agent 手动)。**三者全部只写不维护**。

### 现有可复用元数据(project_wiki 列,[db-migration.ts:821](../../../src/server/db-migration.ts#L821))
已有:`created_at`、`updated_at`、`provenance`(可扩展承载 maintenance 历史)、`flags`(TEXT,可承载维护标记)、`relations` / `links`。
**缺失**:无 `last_accessed` / `access_count`(**读不计数**,无法做 recency 衰减召回);无任何相似度 / 冲突检测能力。

### ⚠️ 关键约束:无向量能力可复用
KB 子系统（`kb-*.ts` / `knowledge.db` / 向量检索）**已从生产路径删除**，当前架构基线见 [知识子系统](../../arch/06-knowledge-subsystems.md)。因此语义去重**不能**假设有现成向量基础设施，需在 design 阶段选择机制：

- **方案 A — LLM 驱动合并(推荐起点)**:维护 pass 调 LLM 对某 agent 的 memory 子树做 dedup / 合并 / 冲突消解,产物回写(可标 provenance=`maintained`)。**贴合现有 compression / archive 的 LLM 驱动风格,零新依赖**。
- **方案 B — 重引入 embedding**:加 embedding provider + 向量存储,做语义近邻去重。能力强但工作量大、要新 provider 配置(等同把删掉的 KB 能力以"记忆维护"角色重新引入)。

### 影响面(若推进)
memory-agent 子树维护 hook(挂在归档后 / 周期 cron / 手动)+ 可能的 schema 扩列(`last_accessed` / `access_count`)+ 读侧埋点(`Wiki` 工具 docRead / ExpandNode 时计数)+ 维护产物回写路径。方案 A 改动集中在 server 新增一个 service + 复用现有 provider;方案 B 额外引入 embedding 管线(更大)。

## 下一步

进 ② design 细化方案(`/effort design`)。核心待决策:① 维护机制选 A(LLM 合并)还是 B(embedding),还是先 A 后 B;② 维护触发时机(每次归档后 / 周期 cron / 手动 API);③ 是否加 `last_accessed` / `access_count` 做衰减召回(涉及读埋点 + 索引);④ 冲突消解策略(同 subject 不同 value 时,保留 / 合并 / 标记由谁裁决——agent、维护 LLM、还是用户)。**暂不实施。**

> 文档状态：`arch/06` 已于 2026-07-16 同步 KB 退役事实；本 issue 只保留未来 memory maintenance 的问题范围。
