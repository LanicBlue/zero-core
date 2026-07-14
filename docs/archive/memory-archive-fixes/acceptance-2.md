# Acceptance-2:memory 路由统一 + 磁盘 agentName + 清旧

> 对应 [sub-2.md](./sub-2.md)。修 ③④共根。verifier 按此写测试。

## 验收项

1. **createMemory 拒绝旧全局容器**:createMemory 传 parentId = 旧 `path=memory` 容器(`854f5747`)→ 返回错误(不接受)。测试:构造 legacy 容器行,调 createMemory,断言 error。
2. **per-agent 根落行**:agent 触发 Wiki 工具 scope 构建后(或首次 createMemory),`wiki-root:memory-agent:<agentId>` 行存在于 `project_wiki`(readonly 查验)。
3. **leaf 落 per-agent 根**:createMemory 传 per-agent 根 + subject/title → 新叶 parent_id = per-agent 根 id,path = `memory:<agentId>:<type>:<slug>`(非旧 `memory:<slug>`)。
4. **磁盘用 agentName**:新 memory leaf 的 body 落 `~/.zero-core/wiki/memory/<agentName>/`(非 `<agentId>`)。测试:agentName="测试员" agentId="abc-123" → 文件夹名 = sanitized agentName。
5. **UI memory 锚点可展开**:resolveAnchors 返回 memory 锚点 `wiki-root:memory-agent:<agentId>`;`wikiGetChildren(该 id)` 返回该 agent 的 memory 叶子(非空)。端到端 ④修复。
6. **启动清旧**:跑启动清理后 ——
   - 旧 `path=memory` 容器行 + 其下叶子从 `project_wiki` 删除。
   - 孤儿磁盘目录 `~/.zero-core/wiki/memory/auth-system/`、`dev-1/` 删除。
   - per-agent 根目录(有 DB 行)保留。
7. **topic 死代码清理**:wiki-node-store 删 ensureMemoryTopicRoot/createMemoryNodeForTopic/memoryTopicRootId 后,`build:lib`(tsc)绿;既有 wiki 测试全绿;createMemory 不再接受 `wiki-root:memory-topic:*` parent。
8. **回归**:既有 wiki scope guard / anchor injection 测试全绿(memory 锚点仍 system 注入,kind 仍 memory)。

## 测试形态
- 单元:mock WikiStore,测 createMemory parent 校验 + leaf path/parent。
- 集成:真 SQLite(temp DB),跑启动清理,验行/磁盘状态。
- 磁盘:tmpdir 跑 diskPathFor,验 `<agentName>` seg + sanitize。

## 反例(必须不成立)
- ❌ 新 memory leaf 落到旧全局容器或磁盘 memory/ 根层(散落)。
- ❌ 磁盘文件夹用 agentId(不可读)而非 agentName。
- ❌ UI memory 根 expand 返回空(③④未修)。
- ❌ 清旧误删 project wiki(project_id 非空行)或 per-agent 根目录。

## 已知限制(接受,不算 FAIL)
- agent 改名后,旧 agentName 磁盘文件夹可能残留(若既有 rename 机制不覆盖 memory 根)—— 新写用新名即可。验证既有 rename 覆盖面,覆盖则无此限制。
