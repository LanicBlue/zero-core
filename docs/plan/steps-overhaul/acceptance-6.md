# acceptance-6:wiki topic 节点支持

## 验收清单
- [ ] `createMemoryNodeForTopic(topicId, ...)` / `ensureMemoryTopicRoot(topicId)` 能建 topic 根 + 叶子。
- [ ] topic 节点 `deriveTypeFromPosition` 正确归类为 memory(不被错归 structure)。
- [ ] topic 根挂 global root 下,不撞 knowledge/projects/memory 容器名。
- [ ] Wiki 工具能 create/update memory type 节点(原限制放开)。
- [ ] Extractor A 拿到 global-anchor callerCtx 的 Wiki 工具实例(fire-and-forget 无 session 也能用)。
- [ ] upsert by (parentId+path) 稳定;`flags`/`detail` 可用(冲突标注 + 合并正文)。
- [ ] `searchMemoryNodes` 能找到 topic 节点。
- [ ] 三层 tsc + vitest。

## 怎么验
建 topic 节点 → search/expand 能查到;Wiki 工具读写 memory type 成功。
