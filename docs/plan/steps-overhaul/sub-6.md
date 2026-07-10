# sub-6:wiki topic 节点支持(store + 工具)

## 范围
wiki 节点从"按 5 type / 按 agent 分根"支持"按 topic 分根",为 sub-7 的 Extractor A 多步 agent 提供 store 能力。

## 依赖
无(与 sub-4/5 并行可做;sub-7 依赖它)。

## 改动点
- `src/server/wiki-node-store.ts`:
  - 新增 `createMemoryNodeForTopic(topicId, ...)`(平移 `createMemoryNodeForAgent`,键从 agentId 换 topicId);`ensureMemoryTopicRoot(topicId)`。
  - `deriveTypeFromPosition`(`:1721`):认 topic path 前缀(如 `memory-topic:`),否则 topic 节点会被错归 structure。
  - `searchMemoryNodes`(`:1558`):不再硬排除 5 个 `wiki-root:memory:<type>` id;适配 topic 根。
- `src/tools/wiki-tool.ts`:放开 memory type 的 create/update(当前 create 强制 `type ∈ header|intent|structure`,`upsertNodeInScope:1166`);或加 `createMemory` action。
- topic 节点用 `flags`(冲突标注)+ `detail`(合并正文,任意长 markdown);"## 历史"段留痕绕过无 version/history 列。
- Extractor A 的 callerCtx:注入 global-anchor(`WIKI_GLOBAL_ROOT_ID`)的 Wiki 工具实例(fire-and-forget,无 session)。

## 关键不变量
- topic 根挂 global root 下(不撞 knowledge/projects);命名避开 `knowledge`/`projects`/`memory` 容器名。
- upsert by (parentId+path) 稳定绑定。
- `update` 是 patch 语义(undefined=不动,null=清空)—— 多步 agent 部分更新显式传字段。

## 参考
design.md「wiki memory」「可行性已验证」(wiki 区)。
