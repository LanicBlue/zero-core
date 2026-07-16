# Acceptance 01：独立数据库与共享契约

对应 [Plan 01](plan-01-database-contracts.md)。

## A. 自动化验收

- [ ] 临时目录 fresh open 后只在指定位置创建 `wiki.db`、`-wal`/`-shm`（如有），不修改 `sessions.db`。
- [ ] `PRAGMA journal_mode` 为 WAL，`foreign_keys=1`，busy timeout 已设置。
- [ ] 七类核心表/FTS 均存在，列、唯一约束、外键和索引与设计一致。
- [ ] 同一 DB 连续初始化两次不报错、不重复 root、不改变 root revision/created_at。
- [ ] 固定根恰好为 `wiki-root/{knowledge,memory,projects}`，无旧 `wiki-root:global` 等合成 ID。
- [ ] `normalizeWikiPath` 对合法路径产生唯一 canonical form。
- [ ] `.`、`..`、空段、反斜线、控制字符、scheme 和越界长度被拒绝。
- [ ] `isSameOrDescendant("wiki-root/a", "wiki-root/ab")` 为 false。
- [ ] `UNIQUE(path)` 与 `UNIQUE(parent_id,name)` 均有失败测试。
- [ ] 删除被 link target/source binding 引用的节点符合 RESTRICT/CASCADE 设计。
- [ ] FTS insert/update/delete 与 rebuild 后结果一致。
- [ ] audit `request_id` 重复不会产生两条记录。
- [ ] 对 Agent/UI 暴露的共享 view 序列化结果不含内部 `id/parent_id/source_id/target_id`。

## B. 结构审查

- [ ] 新 Wiki schema 不位于 `SessionDB` 或 `db-migration.ts` 的旧 `project_wiki` migration 中。
- [ ] 新模块没有读取 `project_wiki` 或 `WIKI_DISK_ROOT`。
- [ ] canonical path 逻辑只有一个权威实现；repository/service/tool 不各自拼字符串。
- [ ] repository 层没有混入 Agent grants 或 Prompt 逻辑。
- [ ] SQL 热路径存在 path、parent、target 和 repository/source 索引。

## C. 验证命令

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run check:links
```

额外运行新 Wiki database/path test 文件并记录测试数量。

## D. 必备证据

`result-01.md` 必须包含：

- `sqlite_master` 表和索引摘要。
- `PRAGMA foreign_key_check`、`integrity_check` 结果。
- 固定根查询结果，只展示 path/kind/revision，不展示为 Agent API 设计的内部 ID。
- path edge case 测试表。
- 新增/修改文件清单与 commit SHA。

## E. 拒绝条件

以下任一出现即不通过：

- 为复用现有代码把新节点继续写进 `project_wiki`。
- 用磁盘 Markdown 作为正文事实源。
- Agent-facing 类型包含内部 ID。
- schema 依赖旧 Wiki 数据迁移才能启动。
- 通过关闭 foreign key 或删除失败测试绕过约束。

