# Plan Review Resolution：wiki-system-redesign

> 日期：2026-07-16  
> 状态：设计与计划已按评审修订，等待独立 re-review；re-review PASS 前不得实施。

## 1. 用户确认的新增决策

1. 所有活动 SQLite 文件统一放入 `${ZERO_CORE_DIR}/db/`。
2. `sessions.db` 改为 `db/core.db`，`SessionDB` 改为 `CoreDatabase`；现有 Core 业务数据安全切换保留。
3. 已退役 `knowledge.db` 直接精确删除，不迁移、不备份、不保留 legacy runtime。
4. Wiki 使用独立 `db/wiki.db`，拥有独立 connection/migration/WAL/checkpoint/backup/close。
5. Agent/Project Wiki 根使用稳定业务 ID 路径段；名称只作为 `attributes.display_name`，rename 不移动子树。
6. Core DB 是 Agent/Project/Work/Cron/Session 事实源；Wiki 不复制这些对象，Work/Cron 不扩大 Agent grants。

## 2. Blocker 处理

| Blocker | 处理 | 落点 |
|---|---|---|
| B1 Prompt/runtime 内联 | 接受 | Plan 05 定义 server compiler、generic dynamic sections、config-sync StepEnd 安全边界；AgentLoop 禁止 Wiki import/字面 section/invalidate；Acceptance 05 加真实 wiring/E2E |
| B2 独立 DB 低估 | 接受成本 | 新增 Plan/Acceptance 00；DatabaseManager、多 DB ready 顺序、独立 WAL/backup/readonly contract 写入 Plan 00/01/08 |
| B3 `project_wiki` 启动写入 | 接受 | Plan 08 明列四处 migration/fresh CREATE、ensure skeleton、subscriber 删除；旧表不由启动 touch |
| B4 SQLite TEXT affinity | 接受 | Plan 01 禁用 SqliteStore，明确 DDL；Acceptance 01 使用 PRAGMA 校验 INTEGER affinity |
| B5 跨 sub 契约 | 接受两项、澄清 audit | Plan 01 固定 WikiErrorCode/kind/action/access/view；默认 grants 改用 `memory://`/`project://`；auditId 明确为公开 opaque receipt，不是 node internal ID |
| B6 archive UNIQUE | 接受 | schema 改为 active partial unique path/sibling；archive 后允许同路径重建，restore 冲突 |

## 3. Concern 处理摘要

- 设计 Phase 与 plan 对齐为 00–08，并增加每阶段 contract ownership 表。
- Plan 02 给出 WikiService TypeScript 签名；search scope helper 明确为 internal。
- CallerCtx.wikiAccess 由 Plan 04 定义、Plan 05 正式注入。
- Markdown section 固定 CommonMark AST、ATX/Setext 和明确边界/oracle。
- Tool schema 保持顶层 flat `z.object`。
- Regex worker/ripgrep 固定 pattern/candidate/bytes/time/result 限额与错误码。
- Plan 03 列出 WikiSkeletonService、ArchivistGit、server routes 和 workflow 的正式替换接入点。
- 动态地址为内建 resolver，不写地址表；静态 alias 才持久化。
- root/Memory/Project 初始 summary 确定性非空。
- attributes 支持 patch；move root revision +1、后代 revision 不变；大 move 有上限。
- FTS 固定显式 transaction，索引 `name/summary/content`。
- Git rename swap 使用 transaction 临时路径。
- Memory 所有归档路径统一调用 WikiService archive primitive。
- `wiki-root` grant 允许但要求 impact、二次确认与审计。
- Project full reindex 后台执行，不阻塞 server ready。
- Plan 06 明确合并两套 IPC 和所有 nodeById 消费方。
- Final Acceptance 增加在途 publish、运行中 project switch、最后 grant `[]`、双 DB 独立、runtime legacy absence 和 move 双 parent UI 失效。
- 不采用“测试文件数量 ≥ N”或“每阶段必须三个 verifier”作为机械质量指标；高风险 Plan 05/08/Final 仍推荐多方向独立验收。

## 4. Re-review 要求

独立评审者应重新读取 design、README、Plan/Acceptance 00–08 与 Final Acceptance，并至少确认：

- 文档之间的路径、类型、错误码、阶段依赖无矛盾；
- 6 个 blocker 已由可执行验收覆盖，而不是只增加说明文字；
- 新 Plan 00 没有把 `knowledge.db` 变成迁移/保留对象；
- `core.db/wiki.db` 的跨库关系没有伪装成 SQL FK 或跨库原子事务；
- 正式 runtime/UI/cutover 入口都有接线与 legacy absence 断言。

re-review 结果写入 `plan-review-r2.md`。只有明确 `PASS` 才把路线图状态改为“待实施”。

