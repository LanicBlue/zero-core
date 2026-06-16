# Acceptance M2 — 全局 wiki 记忆树 + archivist

> **前置**: `plan-overview.md` A0 通用前置(本文件不重复)。

### wiki 树
- [ ] `WikiNode` 重构为全局唯一记忆树;`type` 含 header/intent/structure/project/memory;叶子带 `docPointer`;结构断言带 `provenance`;traceability 带 `requirementIds`
- [ ] project 子树挂在 `project` 节点下;memory 节点位置预留(实际写入由 M5)
- [ ] wiki 查询按 session 的 `wikiRootNodeId` 截断(在 store 层强制):项目角色 session 看不到别的 project、看不到全局 memory 上层结构

### archivist-service
- [ ] archivist 对实际项目文档只读、对 wiki 树可读写(限自己 project 子树)
- [ ] git 增量扫描 `lastScannedRef` 按 (archivist, project) 维度;合并后 `git log/diff <last>..main` 只重读变化;feature WIP 不进 wiki
- [ ] 意图从 artifact 聚合(代码结构 + commit/需求文档/ADR/注释);缺失时 flag「无记录理由」,不发明
- [ ] provenance 打标(structure/derived/confirmed)
- [ ] 意图↔结构分歧信号工作(需求未实现 flag / 代码有能力需求没覆盖 flag)
- [ ] archivist 管 main 分支 git(commit PM 文档 / 合并 feature→main / 非 repo 自动 init / 清理 worktree)
- [ ] 写入守卫靠 prompt + 工具能力,无 AST/hook 后门

### 端到端验证
- [ ] archivist 扫一个 repo → 建出 project wiki 子树
- [ ] **PM session(根 = A 子树)只看到 A,看不到 B、看不到全局 memory 上层**
- [ ] archivist 试图写别的 project 子树 / 写代码文件 → 被拒(工具能力/prompt)
