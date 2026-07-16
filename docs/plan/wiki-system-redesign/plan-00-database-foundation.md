# Plan 00：数据库基础、统一布局与命名

## 目标

在 Wiki 重构前统一 zero-core 的 SQLite 生命周期与物理布局：把承担应用核心状态的 `sessions.db` 改名为 `db/core.db`，删除已经退役且无运行时读取者的 `knowledge.db`，建立可管理多个独立 SQLite 数据库的基础设施。完成后，现有业务仍只使用 Core DB；`db/wiki.db` 由 Plan 01 创建。

## 依赖

无。本阶段必须先于 Plan 01–08 完成。

## 事实与边界

- `sessions.db` 不只保存 session，还保存 Agent、Project、Work、Cron、Provider、配置、任务和遥测，因此改称 Core DB。
- `knowledge.db` 对应的 KB/embedding 子系统已经从生产源码删除；本阶段直接删除该文件及其 WAL/SHM，不迁移、不备份、不改名保留。
- 本阶段保留 `core.db` 中现有业务数据；“不迁移旧 Wiki 数据”仅指 `project_wiki` 和旧磁盘 Wiki 正文，不代表丢弃 Agent/Project/Session 数据。
- 不创建新 Wiki schema，不读取旧 Wiki 正文，不开始 Project 重建。

## 实施范围

### 1. 统一目录与路径模块

正式布局：

```text
${ZERO_CORE_DIR}/
├── db/
│   ├── core.db
│   ├── core.db-wal
│   ├── core.db-shm
│   └── wiki.db          # Plan 01 才创建
├── wiki/
│   └── attachments/
└── backups/
    ├── core/
    └── wiki/
```

新增单一 `database-paths.ts`，提供 `coreDbPath/wikiDbPath/coreBackupDir/wikiBackupDir`。生产代码、脚本和测试不得自行拼接 `sessions.db`、`knowledge.db` 或 `wiki.db`。

### 2. `SessionDB` 改为 `CoreDatabase`

- 将连接所有者和默认文件名改为 `CoreDatabase` / `core-database.ts`。
- 本阶段允许类继续包含现有 Session 专属方法，避免同时进行大规模 repository 拆分；后续可渐进提取 `SessionRepository`。
- Store 构造参数、AgentService、Server composition root、CLI、测试和公共导出统一使用 `CoreDatabase`。
- 不保留生产可调用的 `SessionDB` alias；如迁移 commit 内临时存在，必须在 Acceptance 00 前删除。
- **范围警示(compile-gate):** `SessionDB`→`CoreDatabase` 是全仓机械改名(约 50 文件、186 处引用,每个 store 构造参数类型都是它),不是局部编辑。implementer 必须一次性改全 + `npm run typecheck`/`build:lib` compile-gate 全绿;Acceptance 00 须断言全仓无残留 `SessionDB` 引用(grep 命中 0,不含注释里的历史说明)。

### 3. DatabaseManager

新增服务端唯一数据库生命周期管理器。**完整对称 interface(目标形状)**:

```ts
interface DatabaseManager {
  readonly core: CoreDatabase;
  readonly wiki: WikiDatabase;        // Plan 01 起持有;Plan 00 阶段 open 前 wiki 项未设
  open(): void;                        // core 先 open,wiki(Plan 01+) 后 open;全部 ready 前 block agent-service/recovery 构造
  close(): void;
  health(): DatabaseHealthMap;         // { core, wiki }(Plan 00 阶段 wiki 项省略)
  checkpointCore(): void;
  checkpointWiki(): void;              // Plan 01 实现;core/wiki 的 WAL checkpoint 各自独立
  backupCore(dest): string;            // Plan 08 snapshot 用
  backupWiki(dest): string;            // Plan 08 snapshot 用;core/wiki backup 各自独立
}
```

**Plan 00 只实现 core 部分**(`core`/`open`/`close`/`health` 的 core 项/`checkpointCore`);`wiki`/`checkpointWiki`/`backupCore`/`backupWiki` 为占位,由 Plan 01/08 按此**已锁定的签名**补齐——Plan 01 不得临时改名或只补 `wiki` 字段而不补对应的 checkpoint/backup 方法,以免 core/wiki 形状不对称。Manager 统一负责打开、关闭、health、checkpoint、backup 和路径,但不提供跨库 SQL、跨库 transaction 或共享 migration。

### 4. `sessions.db → db/core.db` 启动切换

切换发生在任何 CoreDatabase 连接建立前：

```text
core.db 存在、sessions.db 不存在
→ 正常打开 core.db

core.db 不存在、sessions.db 存在
→ 以独占维护流程打开旧库
→ WAL checkpoint(TRUNCATE)并关闭
→ SQLite Backup API/安全复制到 db/core.db.tmp
→ integrity_check + foreign_key_check
→ 原子 promote 为 db/core.db
→ 将旧 sessions.db 保存为 backups/core/pre-layout-<timestamp>.db
→ 删除旧 WAL/SHM
→ 写 layout-v1.json

两者都不存在
→ 创建 fresh db/core.db

两者都存在且没有有效完成标记
→ 启动失败并返回 DATABASE_LAYOUT_CONFLICT，不猜测事实源
```

布局标记 `${ZERO_CORE_DIR}/db/layout-v1.json` 至少记录 source/target、时间、版本、源/目标 hash、integrity 结果和完成状态。中断恢复必须幂等。

`DATABASE_LAYOUT_CONFLICT` 是 DatabaseManager 启动错误码,**独立于 Plan 01 的 `WikiErrorCode` 命名空间**(后者只覆盖 Wiki 工具/服务操作)。本阶段 DatabaseManager 错误码闭集仅此一个;后续若新增启动/布局错误码,须在此处集中声明,不得散落到 wiki 操作码。

### 5. 删除退役 `knowledge.db`

在布局 bootstrap 中检测并删除：

```text
${ZERO_CORE_DIR}/knowledge.db
${ZERO_CORE_DIR}/knowledge.db-wal
${ZERO_CORE_DIR}/knowledge.db-shm
```

要求：

- 删除前确认目标是上述精确白名单路径，禁止 glob/递归删除。
- 记录结构化日志 `retired_database_deleted`；不存在时幂等 no-op。
- 不读取内容、不导入到 `core.db/wiki.db`、不生成 backup。
- 删除 `build-codegraph.ts` 和活动架构文档中仍宣称 KB DB 存在的陈旧描述。

### 6. 周边路径同步

必须同步修改：

- self-update snapshot/restore 和“应用是否仍运行”的 WAL/SHM 检测；
- `check-turns.cjs`、集成测试脚本和诊断工具；
- Platform/health API 的数据库路径与可写状态；
- 测试 fixture 默认文件名；
- backup/restore 路径；
- 文件系统保护规则的 Core DB 路径；
- 架构文档和代码图生成器。

外部诊断只允许以 SQLite readonly URI 打开 snapshot 或显式只读 Core DB，不得执行 checkpoint/VACUUM/migration。

## 必须新增的测试

建议：

```text
tests/unit/database-layout.test.ts
tests/unit/database-manager.test.ts
tests/unit/core-database-compat.test.ts
tests/unit/retired-knowledge-db-cleanup.test.ts
```

覆盖 fresh、旧库切换、中断恢复、双库冲突、WAL、完整性失败、knowledge 精确删除、相邻文件不误删、self-update restore 和既有 Core 业务数据 round-trip。

## 明确不做

- 不拆分所有 Core repository。
- 不创建 `wiki.db` 或 Wiki schema。
- 不迁移 `project_wiki` 或旧 Markdown。
- 不保留或导入 `knowledge.db`。
- 不用 `ATTACH DATABASE` 构造跨库 transaction。

## 完成定义

仅当 [Acceptance 00](acceptance-00-database-foundation.md) 全部通过并提交 `result-00.md`，才可进入 Plan 01。

