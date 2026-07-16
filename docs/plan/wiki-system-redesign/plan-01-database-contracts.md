# Plan 01：独立数据库与共享契约

## 目标

建立新 Wiki 的无业务集成地基：独立 `wiki.db`、完整 schema、共享类型、canonical path、固定根与低层 repository。完成后，新存储可以被单元测试直接使用，但现有运行时和 UI 尚不切换。

## 依赖

无。

## 输入与边界

依据总设计第 3–5 节。采用 clean cutover：

- 不读取或迁移 `project_wiki`。
- 不导入 `~/.zero-core/wiki` 旧 Markdown。
- 不修改旧 Wiki tool、Prompt 或 UI 行为。
- 不把新表加入 `SessionDB`。

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

`WikiDatabase` 默认打开 `${ZERO_CORE_DIR}/wiki/wiki.db`，测试允许传临时绝对路径。负责：

- 创建父目录。
- 设置 WAL、foreign_keys、busy_timeout。
- schema 初始化和 schema version。
- 暴露 transaction、integrity check、close。
- 不建立第二个指向 `sessions.db` 的连接。

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
- `UNIQUE(parent_id, name)` 和 `UNIQUE(path)` 同时存在。
- JSON 字段使用 `json_valid` CHECK。
- FTS 是 external-content 或等价的可重建索引。
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
- 稳定错误 code union

新 view 不包含 DB 内部 ID。repository 内部类型可有 ID，但不能进入 tool/API view。

### 5. 固定根 bootstrap

幂等创建：

```text
wiki-root
wiki-root/knowledge
wiki-root/memory
wiki-root/projects
```

kind 分别为 `root/namespace/namespace/namespace`。重复启动不得改变 created_at、增加 revision 或产生重复行。

### 6. Repository 层

本阶段只实现无授权的低层数据访问：

- node 按 path、ID、parent 查询。
- 直接 children 分页。
- link 插入、删除、incoming、outgoing。
- repository/source binding CRUD。
- FTS rebuild 与基本查询。
- audit append 与 request_id 去重。

业务校验、地址解析和 Agent 授权留给 Plan 02。

## 必须新增的测试

建议：

```text
tests/unit/wiki-v2-database.test.ts
tests/unit/wiki-v2-schema.test.ts
tests/unit/wiki-v2-path.test.ts
tests/unit/wiki-v2-repositories.test.ts
```

覆盖 fresh DB、二次打开、约束失败、foreign key、FTS 同步/重建、固定根幂等和 path edge cases。

## 明确不做

- 不连接 AgentStore/ProjectStore。
- 不实现 grants、地址 resolver 或 Prompt。
- 不注册新 Wiki tool。
- 不删除旧文件。
- 不使用自动生成的 UUID 作为 Agent API。

## 完成定义

仅当 [Acceptance 01](acceptance-01-database-contracts.md) 全部通过并提交 `result-01.md`，才可进入 Plan 02。

