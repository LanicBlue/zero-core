# Plan 08：最终切换、旧实现清理与加固

## 目标

删除所有旧 Wiki runtime 路径，补齐数据库保护、备份、规模验证、架构文档和发布门禁，使新系统成为唯一实现。此阶段不新增替代性产品功能，重点是证明没有旧路径、旁路或组合缺陷。

## 依赖

- Acceptance 01–07 全部通过。

## 实施范围

### 1. 删除旧实现

根据实际引用清理：

- `ProjectWikiStore` 兼容层。
- legacy `/api/project-wiki` router/IPC/preload。
- 旧 `WikiStore` 的磁盘正文、短 ID、synthetic root、anchor-scope 方法。
- `wiki-anchor-injection.ts`。
- `wiki-scan-cursor-store.ts`（游标已进 repositories）。
- `createMemory/updateMemory/docRead/docWrite/docEdit`。
- `wikiAnchors/wikiAnchorNodeIds` runtime/form/template wiring。
- header/intent/structure/project_wiki 兼容类型与 prefix。
- 只验证旧实现的测试。

不能只“停止注册”而保留可被其他模块调用的旧全局 singleton/fallback。

`sessions.db.project_wiki` 旧表可以保留为未读取的历史表，或通过显式维护命令删除；启动过程不得静默清除。代码中不得再查询/写入它。

### 2. 文件系统隔离

重写 Wiki path guard，保护：

```text
${ZERO_CORE_DIR}/wiki/wiki.db
${ZERO_CORE_DIR}/wiki/wiki.db-wal
${ZERO_CORE_DIR}/wiki/wiki.db-shm
${ZERO_CORE_DIR}/wiki/backups
${ZERO_CORE_DIR}/wiki/.runtime
```

Read/Write/Edit/Grep/Glob/Shell 不能绕过 Wiki tool 操作数据库或备份。管理备份服务是唯一例外，不通过 Agent shell。

attachments 若允许 Agent 读取，必须经 Wiki attachment API 和 grants，不能开放整个 Wiki 目录。

### 3. 备份与完整性

实现管理级 snapshot：

- 使用 SQLite Backup API 或 `VACUUM INTO`。
- snapshot 前后记录 source DB revision/time/hash。
- 不直接复制活跃 `wiki.db`。
- 支持 restore 到新临时 DB 并验证 integrity/foreign key/roots/counts。
- 可选本地 Git 只提交一致 snapshot 或 JSONL change log，不 commit 活跃 WAL DB。

备份计划不要求每次全库 LLM 或逐节点扫描。大库的周期由管理配置决定；默认可按时间 + change count 触发。

### 4. 性能与规模

新增可重复 benchmark 脚本，至少支持：

```text
--nodes=100000
--nodes=1000000（发布前手工规模验收）
```

覆盖：

- canonical path read。
- parent expand/pagination。
- incoming/outgoing links。
- FTS top-k。
- authorized multi-scope search。
- subtree move（有界测试）。

自动测试优先断言 `EXPLAIN QUERY PLAN` 使用 path/parent/target/FTS 索引，避免硬件差异造成 flaky。发布结果记录参考硬件、数据规模、耗时和内存。

### 5. 数据库维护

提供管理任务：

```text
integrity_check
foreign_key_check
fts rebuild/verify
optimize/analyze
snapshot
explicit legacy cleanup
```

不得每日对百万节点逐行 hash 或每次全量 Git commit 活跃 DB。

### 6. 架构文档

更新：

- `docs/arch/04-tools-subsystem.md`
- `docs/arch/05-persistence.md`
- `docs/arch/06-knowledge-subsystems.md`
- `docs/arch/07-renderer-and-ipc.md`
- `docs/arch/08-cross-cutting.md`
- `docs/arch/12-glossary.md`

说明 Wiki DB、data/management plane、grants/context、Project mirror、API/UI 和备份。旧描述不得继续声称正文在磁盘 Markdown或 anchors 决定 scope。

### 7. 最终集成测试

增加从空环境启动的 E2E fixture：

```text
fresh Wiki DB
→ create Agents
→ bind Git project and full index
→ compile Prompt
→ Agent Wiki calls
→ UI browse/search/edit
→ Git rename + sync
→ snapshot + reopen/restore
```

所有路径从应用正式入口执行，不只直接调用 service。

## 明确不做

- 不迁移旧 Wiki 数据。
- 不保留 legacy fallback。
- 不因性能问题改回百万小文件。
- 不在此阶段加入 embedding/sections/symbol graph。

## 完成定义

先通过 [Acceptance 08](acceptance-08-cutover-hardening.md)，再由独立验收 Agent 执行 [Final Acceptance](acceptance-final.md)。

