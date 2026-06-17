# Plan M2 — 全局 wiki 记忆树 + archivist

> **依赖**: M0(bundle 提供 wikiRootNodeId)。可与 M1 并行。
> **对应 RFC**: §2.7 / §2.13 / §2.16 / §2.17 / §2.19 / §4.6 / §4.2(lastScannedRef 维度)。
> **验收**: `acceptance-M2.md`(前置见 `plan-overview.md` A0)。

## 设计细节要求

### 全局 wiki 记忆树

1. `WikiNode` 重构为**全局唯一记忆树**(数据库,不在项目 workspace):`type: "header" | "intent" | "structure" | "project" | "memory" | ...`;叶子节点带 `docPointer`(指向实际文档路径,实际文档不在 wiki 里);结构断言带 `provenance`(`structure`/`derived`/`confirmed`);traceability 带 `requirementIds`(RFC §4.6)。
2. **project 子树**:挂在 `project` 节点下(该 project 的记忆)。`memory` 节点挂全局类型节点下(不绑 project,跨项目角色技能)—— 但 memory 节点的写入由 M5 的提取者 A 负责,M2 只建树结构与访问机制(决策 37)。
3. **访问根 session 级 + 截断查询**:所有 wiki 查询按 session 上下文的 `wikiRootNodeId` 截断 —— 项目角色 session 根 = project 子树(看不到更大根、看不到别的 project、看不到全局 memory 上层结构);全局 session 根 = 全局根。视角隔离是**结构上强制的**,不是「私有存储 + 自觉」(决策 38)。在 store 层强制,不靠 agent 自觉。

### archivist-service

4. archivist 是**全局角色**(M0 已有预设),经 session 上下文服务某个 project。
5. **对实际项目文档(代码 + 各类文档文件)只读,对 wiki 树可读写(限自己 project 子树)**。archivist 在 project 子树上建结构节点(header→代码文件、intent→需求文档、structure→模块/子系统)+ 指针 + 关系;不写代码、不写需求文档内容(决策 9/18)。
6. **git 增量更新**:扫描游标 `lastScannedRef`(main commit sha)按 **(archivist, project)** 维度记录(archivist 全局化后游标不能挂 agent 上,RFC §2.13/§4.2)。合并后跑 `git log/diff <last>..main`,只重读变化部分更新 wiki;feature 分支 WIP **不进 wiki**(决策 19/26)。周期全量 rescan 兜底漂移。
7. **意图从 artifact 聚合,不发明**:结构层(what)读代码;意图层(why)读 commit message / 需求文档(PM discuss 记下)/ ADR / 注释;复杂模块外包 architecture-lens analyzer(决策 20)。意图只能从人写下的地方提取;缺失时 flag「无记录理由」。
8. **provenance 打标**:每条结构断言标 `structure`/`derived`/`confirmed`,archivist 自己知道哪条该信(决策 33)。
9. **意图↔结构分歧信号**:wiki 意图节点(指向需求文档)↔ 代码结构(指向代码)diff —— 需求未实现 → flag;代码有需求文档没覆盖的能力 → flag。**基线是 wiki 意图节点,不是 docs/basic(docs/basic 砍掉)**(决策 31)。
10. **archivist 管 main 分支 git**:统一 commit PM 写的需求文档、verify 后合并 feature→main、非 repo 自动 init、清理 worktree(RFC §2.15)。archivist 自己的 wiki 产出在数据库,不经 git(决策 27, N1)。
11. archivist 写入守卫 = prompt 自约束 + 工具能力(只对 wiki 树有写工具,对项目文档只读工具),不走 AST/hook(OQ1,决策 39)。

## 风险

- wiki 查询截断若放 store 层要注意性能(子树查询);评估是否需要 materialized path 或闭包表。
- git 操作跨 platform(Windows 路径、worktree 沙盒目录)—— feature worktree 必须独立目录/沙盒(决策 25)。
