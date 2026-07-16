# Plan 01：独立数据库与共享契约

## 目标

建立新 Wiki 的无业务集成地基：独立 `wiki.db`、完整 schema、共享类型、canonical path、固定根与低层 repository。完成后，新存储可以被单元测试直接使用，但现有运行时和 UI 尚不切换。

## 依赖

- Acceptance 00 已通过；活动主库已经是 `${ZERO_CORE_DIR}/db/core.db`。

## 输入与边界

依据总设计第 3–5 节。采用 clean cutover：

- 不读取或迁移 `project_wiki`。
- 不导入 `~/.zero-core/wiki` 旧 Markdown。
- 不修改旧 Wiki tool、Prompt 或 UI 行为。
- 不把新表加入 `CoreDatabase` 或 `core.db`。

## 实施范围

### 1. 目录与数据库生命周期

新增独立 Wiki 模块，建议结构：

```text
src/server/wiki/
├── wiki-database.ts
├── wiki-schema.ts
├── wiki-path.ts
├── wiki-node-repository.ts
├── wiki-link-repository.ts
├── wiki-repository-store.ts
├── wiki-audit-repository.ts
└── index.ts
```

本阶段只新增 `src/server/wiki/` 与 shared contract；不删除或改名现有 `src/server/wiki-*.ts`、router/tool/runtime 路径。旧实现的原子替换归 Plan 05–08。

`WikiDatabase` 默认打开 `${ZERO_CORE_DIR}/db/wiki.db`，测试允许传临时绝对路径。它由 Plan 00 的 DatabaseManager 持有，负责：

- 创建父目录。
- 设置 WAL、foreign_keys、busy_timeout。
- schema 初始化和 schema version。
- 暴露 transaction、integrity check、close。
- 拥有独立的 migration、WAL、checkpoint、health 和 close；不建立第二个指向 `core.db` 的连接，也不使用 `ATTACH DATABASE`。
- DatabaseManager 必须在 WikiDatabase/Wiki repositories ready 后才允许 AgentService/recovery 构造。

### 2. Schema

实现设计中的：

- `wiki_nodes`
- `wiki_links`
- `wiki_addresses`
- `wiki_repositories`
- `wiki_source_bindings`
- `wiki_nodes_fts`
- `wiki_audit_log`

要求：

- foreign key 行为与设计一致。
- active 节点使用 partial unique indexes：`path WHERE archived_at IS NULL` 与 `(parent_id,name) WHERE archived_at IS NULL`；表级永久 UNIQUE 禁止使用。
- JSON 字段使用 `json_valid` CHECK。
- FTS 是 external-content 可重建索引，字段固定为 `name/summary/content`；由 repository 显式 transaction 更新，不使用 trigger。
- schema 初始化幂等。
- schema 版本只服务新 Wiki DB，不包含旧 Wiki 迁移步骤。

### 3. Canonical path

提供单一共享实现，至少包含：

```ts
normalizeWikiPath(input: string): string
joinWikiPath(parent: string, name: string): string
parentWikiPath(path: string): string | null
isSameOrDescendant(scope: string, path: string): boolean
validateWikiName(name: string): void
```

约束：

- 根路径唯一为 `wiki-root`。
- 分隔符统一 `/`。
- 拒绝空段、`.`、`..`、反斜线、控制字符和逻辑地址 scheme。
- descendant 判断按路径段，不得把 `wiki-root/a` 错配到 `wiki-root/ab`。
- 保留 Git 路径大小写；大小写策略不得依赖 Windows 文件系统行为。

### 4. 共享类型

在 `src/shared/` 定义与服务、工具、REST、UI 共用的新类型：

- `WikiNodeView`
- `WikiNodeKind`
- `WikiLinkView`
- `WikiRepositoryView`
- `WikiAddressView`
- `WikiAuditView`
- 分页 cursor/result
- 稳定错误 code union：

```text
INVALID_REQUEST, INVALID_PATH, INVALID_NAME,
INVALID_ADDRESS, ADDRESS_UNRESOLVED,
NOT_FOUND, ACCESS_DENIED, ALREADY_EXISTS,
WRITE_CONFLICT, EDIT_TARGET_NOT_FOUND, EDIT_TARGET_AMBIGUOUS,
SOURCE_MANAGED, SOURCE_UNAVAILABLE, SYNC_FAILED,
REGEX_INVALID, REGEX_LIMIT_EXCEEDED, REGEX_TIMEOUT,
HARD_DELETE_BLOCKED, MOVE_TOO_LARGE, INTERNAL_ERROR
```

- `WikiAction`、`CompiledWikiGrant/Access` 和 v1 closed `WikiNodeKind`：`root/namespace/project/directory/source_file/source_symlink/source_submodule/knowledge/memory/node`。

新 view 不包含 node/link/source 的 DB 内部 ID。repository 内部类型可有 ID，但不能进入 tool/API view。`wiki_audit_log.audit_id` 是公开 opaque operation receipt，可作为 `auditId` 返回，不属于该禁令。

### 5. 固定根 bootstrap

幂等创建：

```text
wiki-root
wiki-root/knowledge
wiki-root/memory
wiki-root/projects
```

kind 分别为 `root/namespace/namespace/namespace`。四个 root 使用确定性非空 summary；重复启动不得改变 created_at、增加 revision 或产生重复行。

### 6. Repository 层

本阶段只实现无授权的低层数据访问：

- node 按 path、ID、parent 查询。
- 直接 children 分页。
- link 插入、删除、incoming、outgoing。
- repository/source binding CRUD。
- FTS rebuild 与基本查询。
- audit append 与 request_id 去重。

DDL 必须由裸 `Database.exec()` 或等价明确 SQL 执行，所有 INTEGER 列保持 INTEGER affinity。禁止复用 `SqliteStore<T>` 创建或迁移 Wiki 表；move/FTS/audit 需要专用 transaction repository。

业务校验、地址解析和 Agent 授权留给 Plan 02。

## 必须新增的测试

建议：

```text
tests/unit/wiki-v2-database.test.ts
tests/unit/wiki-v2-schema.test.ts
tests/unit/wiki-v2-path.test.ts
tests/unit/wiki-v2-repositories.test.ts
```

覆盖 fresh DB、二次打开、active partial unique、archive 后同路径重建、foreign key、INTEGER affinity、FTS 显式同步/重建、固定根幂等和 path edge cases。

## 明确不做

- 不连接 AgentStore/ProjectStore。
- 不实现 grants、地址 resolver 或 Prompt。
- 不注册新 Wiki tool。
- 不删除旧文件。
- 不使用自动生成的 UUID 作为 Agent API。

## 完成定义

仅当 [Acceptance 01](acceptance-01-database-contracts.md) 全部通过并提交 `result-01.md`，才可进入 Plan 02。
