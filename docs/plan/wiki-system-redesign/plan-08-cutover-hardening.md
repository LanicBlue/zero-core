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

必须显式处理当前启动写入点：

- 删除 `db-migration.ts` 的 `migrateWikiTableSchema`、`migrateWikiDetailToDisk`、`safeAddColumn(project_wiki.links)` 和 fresh `CREATE TABLE project_wiki` 调用/定义。
- fresh `core.db` 不再创建 `project_wiki`；已有 Core DB 中的旧表保持原样但任何生产代码不得 touch。
- 删除 `server/index.ts` 的旧 `ensureWikiSkeleton(wikiStoreGlobal)`、`rebuildStaleStructureLayouts` 及旧 WikiSkeletonService 装配。
- 删除 data-change-hub 对 `project_wiki` 的广播(`data-change-hub.ts` 的 `UI_COLLECTIONS` 白名单)与 renderer 订阅;同时清理 server 端订阅者 `project-work-hook-manager.ts`(订阅 project_wiki domain 事件)与 `renderer/components/requirements/ProjectPage.tsx` 的 `<option value="project_wiki">` 下拉项——这两处在 hub 停播后成 dead code,必须一并删除而非保留。

不能只“停止注册”而保留可被其他模块调用的旧全局 singleton/fallback。

`core.db.project_wiki`（原 `sessions.db.project_wiki`）旧表可以保留为未读取的历史表，或通过显式维护命令删除；启动过程不得静默清除。代码中不得再查询/写入它。

### 2. 文件系统隔离

重写 Wiki path guard，保护：

```text
${ZERO_CORE_DIR}/db/core.db{,-wal,-shm}
${ZERO_CORE_DIR}/db/wiki.db{,-wal,-shm}
${ZERO_CORE_DIR}/backups/core
${ZERO_CORE_DIR}/backups/wiki
${ZERO_CORE_DIR}/wiki/.runtime
```

Read/Write/Edit/Grep/Glob/Shell 不能绕过 Wiki tool 操作数据库或备份。管理备份服务是唯一例外，不通过 Agent shell。

attachments 若允许 Agent 读取，必须经 Wiki attachment API 和 grants，不能开放整个 Wiki 目录。

### 3. 备份与完整性

实现管理级 snapshot：

- 使用 SQLite Backup API 或 `VACUUM INTO`。
- Core/Wiki 各自使用 Backup API 生成独立 snapshot；一个 manifest 记录两个 source path、时间、schema version、hash 和业务 revision，不声称跨库同一 SQLite transaction。
- 不直接复制活跃 `wiki.db`。
- 支持 restore 到新临时 DB 并验证 integrity/foreign key/roots/counts。
- 可选本地 Git 只提交一致 snapshot 或 JSONL change log，不 commit 活跃 WAL DB。

Core 与 Wiki 的 checkpoint、VACUUM、integrity 和 restore 各自独立；写 Wiki 的测试必须证明不会触发 Core checkpoint/mtime/WAL 变化。外部诊断仅可 readonly 打开 snapshot 或显式 readonly URI，绝不对活跃 DB 执行 checkpoint/VACUUM/migration。

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

启动只 eager bootstrap 固定 root 和有界状态核对；Project full reindex 是可观察的 background job。大型仓库不能阻塞 server ready，Prompt/UI 必须显示 pending/stale/indexing。

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

Plan 05–07 的中间 commit 不可单独发布。最终切换以 release gate 为原子边界：正式 runtime、tool、Prompt、REST/IPC/UI 全部只指向新 service，旧 ProjectWikiStore/router/anchor injection/data subscriber 同一最终变更集不可达。验收需要运行时断言，而非只 grep 文件名。

## 明确不做

- 不迁移旧 Wiki 数据。
- 不保留 legacy fallback。
- 不因性能问题改回百万小文件。
- 不在此阶段加入 embedding/sections/symbol graph。

## 完成定义

先通过 [Acceptance 08](acceptance-08-cutover-hardening.md)，再由独立验收 Agent 执行 [Final Acceptance](acceptance-final.md)。
