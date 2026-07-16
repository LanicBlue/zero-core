# Result 01：独立数据库与共享契约

对应 [Acceptance 01](acceptance-01-database-contracts.md) / [Plan 01](plan-01-database-contracts.md)。

- **实施 commit**：`7047b65`(branch `worktree-wiki-redesign`)— feat(wiki-system-redesign): sub-01 独立 wiki.db + 共享契约 + repository 层
- **验收**：3 方向独立 verifier(规约 / 对抗 / 架构)全 PASS,§A.1-15 + §B.1-6 核心项零 FAIL、零 lens 分歧(round-2,见"验收记录")
- **结论**：✅ Acceptance 01 全部通过,可进入 Plan 02。

---

## 1. sqlite_master 表与索引摘要(§D / §A.3)

7 张核心表 + schema-version:
- `wiki_nodes`(id/parent_id/name/path/kind/summary/content/attributes_json/revision/created_at/updated_at/archived_at,12 列)
- `wiki_links`(source_id/target_id/relation/attributes_json + 审计列)
- `wiki_addresses`(address/scheme/resolver/target_id/alias/attributes_json/prompt_policy + 审计列)
- `wiki_repositories`(repository_id/project_node_id/project_id + 审计列)
- `wiki_source_bindings`(node_id/repository_id/source_path/source_kind + 审计列)
- `wiki_audit_log`(audit_id/request_id/action/actor/path/old_revision/new_revision/payload_json/created_at)
- `wiki_nodes_fts`(FTS5 virtual,name/summary/content,content='wiki_nodes',content_rowid='id')
- `wiki_schema_version`(version/applied_at)

索引:`uq_wiki_nodes_active_path`、`uq_wiki_nodes_active_sibling`(均 partial `WHERE archived_at IS NULL`)、`idx_wiki_nodes_parent/kind/archived`、`idx_wiki_links_target`、`idx_wiki_addresses_target`、`idx_wiki_source_bindings_repo`、`idx_wiki_audit_created/node/actor`。
证据:`wiki-v2-schema.test.ts` §A.3(9 tests,sqlite_master + table_info + foreign_key_list 全核)。

## 2. PRAGMA table_info 亲和 + partial unique SQL(§A.9 / §A.14 / §B.6)

- **INTEGER 亲和**:6 张整数表的所有整数列 PRAGMA type === `INTEGER`(wiki_nodes.id/parent_id/revision、wiki_links.source_id/target_id、wiki_addresses.target_id/revision、wiki_repositories.project_node_id、wiki_source_bindings.node_id、wiki_audit_log.old_revision/new_revision)。`SELECT revision+1`(revision=1)→ 数字 `2` 而非 `'11'`;`UPDATE … SET revision=revision+1` 读回数字。DDL 裸 `db.exec()`,**未用 `SqliteStore<T>`**(grep 仅 prohibition 注释)。
- **partial unique**:
  ```sql
  CREATE UNIQUE INDEX uq_wiki_nodes_active_path ON wiki_nodes(path) WHERE archived_at IS NULL;
  CREATE UNIQUE INDEX uq_wiki_nodes_active_sibling ON wiki_nodes(parent_id, name) WHERE archived_at IS NULL;
  ```
  无表级永久 UNIQUE。重复 active path / sibling → UNIQUE 拒;归档后同路径 active 可建(2 行共存,1 active);restore 占用 active 路径 → UNIQUE 拒。
- **热路径索引(EQP 验证)**:path→active_path、parent→idx_parent、link target→idx_links_target、source_binding repo→idx_source_bindings_repo、address target→idx_addresses_target、repository project→UNIQUE auto-index。

## 3. foreign_key_check / integrity_check(§A.10)

`PRAGMA foreign_key_check` = 空;`PRAGMA integrity_check` = `ok`(fresh + reopen + 混合 update/hardDelete 序列后均 ok)。`foreign_keys=1` 为 FK 执行者。
FK 行为:wiki_links.source_id CASCADE / target_id RESTRICT;wiki_nodes.parent_id RESTRICT;wiki_addresses.target_id RESTRICT;wiki_repositories.project_node_id RESTRICT;wiki_source_bindings.node_id + repository_id CASCADE。7 个 real-DELETE 测试逐条验证。

## 4. 固定根查询(只 path/kind/revision,无内部 ID)(§A.5)

| path | kind | revision |
|---|---|---|
| wiki-root | root | 1 |
| wiki-root/knowledge | namespace | 1 |
| wiki-root/memory | namespace | 1 |
| wiki-root/projects | namespace | 1 |

投影严格 [path, kind, revision](Object.keys 断言,无内部 id 泄漏)。无 `wiki-root:global` 合成 ID(`LIKE '%:%'` 0 行)。双/三开幂等:revision=1 + created_at 不变,无重复。

## 5. Canonical path edge cases(§A.6/7/8)

| 输入 | 结果 |
|---|---|
| `wiki-root/knowledge/topic`、`wiki-root//knowledge//topic`、`wiki-root/knowledge/topic/`、` wiki-root/knowledge/topic ` | 同一 canonical `wiki-root/knowledge/topic`(折叠重复/末尾 `/`、裁空白) |
| `wiki-root/a` vs `wiki-root/ab` | `isSameOrDescendant` = **false**(段匹配,非字符串前缀) |
| `.`、`..`、空段、`\`、控制字符(U+0000-001F/007F/TAB)、`memory://`/`project://`/`runtime://`、name>256、path>32 段 | 全拒(INVALID_PATH / INVALID_NAME) |
| 非 `wiki-root` 前缀(含 `wikiroot`/`Wiki-Root` 大小写变体) | 拒 |
| 大小写 | 保留(case-sensitive 比较) |

权威实现唯一在 `src/server/wiki/wiki-path.ts`(repository/store 不各自拼字符串,§B.4)。

## 6. FTS external-content(§A.11)—— 关键修复

external-content FTS5(`content='wiki_nodes'`)行删除/更新必须用 FTS5 `'delete'` 命令传**旧**列值;裸 `DELETE FROM wiki_nodes_fts WHERE rowid=?` 会损坏索引(SQLITE_CORRUPT_VTAB)或留陈旧 token。
修复(`src/server/wiki/wiki-node-repository.ts`):
- `update()`:getById 捕获 OLD → `ftsDeleteCommand(id, oldName, oldSummary, oldContent)` → UPDATE wiki_nodes → `syncFtsInsert(NEW)`,全在同一 transaction。
- `hardDelete()`:`syncFtsDelete(id)`(读当前 content 跑 'delete' 命令)→ DELETE FROM wiki_nodes。
- `ftsDeleteCommand`:`INSERT INTO wiki_nodes_fts(wiki_nodes_fts,rowid,name,summary,content) VALUES('delete',?,?,?,?)`。
- `syncFtsUpdate`/`syncFtsDelete` 修正为读当前列 + 'delete' 命令;`insert()` 按 §A.11 rebuild 测试契约**不**自动同步(调用方在显式 transaction 内 sync)。
- 无 trigger;0 trigger in fresh DB;rebuild(`'rebuild'` 命令)一致。

## 7. 共享契约(§A.13 / §A.15)

- `WikiNodeView`/`WikiLinkView`/`WikiRepositoryView`/`WikiAddressView`/`WikiAuditView` 无 `id/parent_id/source_id/target_id/project_node_id/node_id` 字段(用 path/parentPath/sourcePath/targetPath/projectId 等);`WikiMutationResult.auditId`/`WikiAuditView.auditId` 为 opaque receipt(允许)。
- `WikiErrorCode` 恰 20 码、`WikiNodeKind` 恰 10 类、`WikiAction` 恰 9 —— 闭集精确断言,后续模块从 `src/shared/wiki-types.ts` 同一 import。

## 8. 验证命令(§C)

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build:lib` | exit 0 |
| `npm run test:unit` | wiki-v2 4 文件 201/201 + sub-00 测试 48/48;全量套件仅 2 个预存非 sub-01 失败(sub5-dead-code-removed git-diff-shape on 未提交树——提交后清;deferred-dangling-tasklink async resume flake)+ Windows better-sqlite3 退出 exit-127(teardown-only,非失败) |
| `npm run check:links` | exit 0,258 链接全解析 |

## 9. 修改文件(§D)

commit `7047b65`:19 文件,+9414/-1282。
- 新增:`src/server/wiki/{wiki-database,wiki-schema,wiki-path,wiki-node-repository,wiki-link-repository,wiki-repository-store,wiki-audit-repository,index}.ts`、`src/shared/wiki-types.ts`、4 个 `tests/unit/wiki-v2-*.test.ts`
- 改:`src/server/database-manager.ts`(接 wiki)、`src/server/wiki-database.ts`(占位→re-export shim)、`docs/visualization/code-graph.{html,json}`
- sub-00 测试维护:`tests/unit/database-manager.test.ts`、`tests/unit/database-layout.test.ts`(plan-00→plan-01 契约翻转:health 含 wiki 键 / wiki getter 实 / checkpointWiki 实 / open() 建 wiki.db;backupCore/backupWiki 占位测试保留)

## 拒绝条件(§E)

| | 结果 |
|---|---|
| (a) 不写进 project_wiki | PASS(grep src/server/wiki 零 code 命中;runtime insert 后 sqlite_master 无 project_wiki) |
| (b) 不用磁盘 Markdown 作正文事实源 | 空洞满足(sub-01 无 disk-mirror 层,wiki_nodes.content DB 列即事实源;sub-03 磁盘镜像后正面断言) |
| (c) Agent 类型无内部 ID | PASS(§A.13) |
| (d) 不用 SqliteStore<T> 致 TEXT 亲和 | PASS(§A.14 + §B.2) |
| (e) schema 不依赖旧 Wiki 迁移 | PASS(fresh DB 自举到 schemaVersion=1,无 migration 输入) |
| (f) 不关 FK / 不删失败测试绕过 | PASS(FK=1 执行者;§A.9/§A.10 FAIL 测试存在并运行) |

## 验收记录

- **round-1**(3 lens + synthesis):FAIL —— BLOCKER 1(§A.11 FTS external-content 裸 DELETE 损坏索引,3 lens 三角确认)+ BLOCKER 2(陈旧 sub-00 测试 pin plan-00 契约,与 plan-01 冲突,12 失败)。
- **implementer FIX**:FTS 用 FTS5 'delete' 命令传 OLD 值,centralize 进 update()/hardDelete(),syncFts* 修正。
- **round-2**(3 lens + synthesis):**PASS** —— BLOCKER 1 全 3 lens 确认(201/201,源码 verified);BLOCKER 2 由架构 lens 翻转 sub-00 测试到 plan-01 现实(48/48)。§A.1-15 + §B.1-6 核心 PASS,零 FAIL。

## 给 Plan 02 的 handoff note

- `insert()` 不自动同步 FTS(§A.11 rebuild 契约)—— plan-02 service 层每个 insert/update/hardDelete 调用须在 `wikiDb.transaction(...)` 内配对 `syncFtsInsert`/audit,否则 FK RESTRICT/unique 冲突会静默 desync FTS 索引(建议 WikiService 包裹或 self-wrap SAVEPOINT-nested transaction)。
- 地址解析 / 授权 / Prompt / Agent loop 集成均归 plan-02+(本 sub 仅低层 repository)。
