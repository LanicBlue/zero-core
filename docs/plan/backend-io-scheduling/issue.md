# Issue: backend-io-scheduling

- **状态**：③ plan（用户已确认，Ready）
- **提出**：2026-07-18
- **类型**：可靠性 / 性能（P1）
- **设计**：[design.md](./design.md)

## 问题

zero-core backend 在单个 Node.js 事件循环中同时承担 HTTP、WebSocket、Agent runtime、
SQLite、归档和维护任务。`better-sqlite3` 的同步 API 很适合短查询和短事务，但当前还有多条
无边界重任务直接运行在 backend 主线程：

- [`runMigrations()`](../../../src/server/db-migration.ts) 在启动路径同步执行全部 schema
  探测和迁移；
- [`archive-service.ts`](../../../src/server/archive-service.ts) 在归档导出和孤儿清理中
  同步 `JSON.stringify`、写文件、重读和 `JSON.parse`；
- 日志及若干备份、hash、扫描路径仍使用同步文件 I/O；
- `wiki-system-redesign` 的目标实现新增独立 `wiki.db`、全量/增量 Git mirror、FTS
  rebuild、完整性检查、备份校验和数据库布局迁移。其当前 worktree 基线
  `4e544fc` 中，这些大部分仍由同步 `better-sqlite3` 事务或同步文件 API 执行。

函数声明为 `async`、使用独立 SQLite connection，或者在调用外层加一个
`void promise.catch(...)`，都不会自动把其中的同步工作移出 backend 事件循环。

## 已核实影响

### 运行时停顿

Wiki 全量索引、大 Git diff、FTS rebuild、`integrity_check`、大 Session archive export
和启动后的 orphan sweep 都可能连续占用主线程。在此期间：

- HTTP/IPC 代理请求不能及时完成；
- WebSocket stream、Stop、Wait、Provider 恢复和后台任务事件不能及时处理；
- UI 看起来像 backend 掉线，用户可能重复操作；
- 同一进程内其他 Agent Session 也被无关维护任务拖住。

### 启动不可见

数据库布局迁移和 schema migration 在 `server.listen` 之前同步完成。它们不会阻塞一个
已经对外服务的 backend，但会阻塞 backend 自身的 lifecycle/heartbeat，令 Electron main
无法区分“仍在迁移”“进程卡死”和“native addon 崩溃”。

### Wiki 放大

把大量小 Markdown 正文收敛到 SQLite 可以减少 Windows 文件数量和逐文件 I/O，这是收益；
但它也把批量索引、FTS、备份和完整性检查集中到少数数据库操作。独立 `wiki.db` 只隔离
数据域，不等于独立执行线程。当前 100k benchmark 主要验证吞吐量和 query plan，没有验证
backend event-loop lag、WebSocket heartbeat 或并发 API 响应。

### 恢复与可观测性不足

部分后台工作只有内存锁和日志，没有统一 job id、progress、attempt、cancel、retry 和
crash recovery 语义。已有 [`archive-observability`](../../issues/archive-observability/issue.md)
记录了归档状态不可见问题；本 effort 提供可复用的 backend job 基础，但不负责最终 UI。

## 目标影响面

- backend event-loop 延迟预算与自动化测量；
- 内部 maintenance job 状态、持久化、调度 lane、进度和恢复；
- worker thread / maintenance child process 的固定协议和 connection ownership；
- 数据库启动迁移、Wiki 索引与维护、archive export / sweep、备份校验等重路径；
- API/事件中的 job 状态与稳定错误；
- 活动架构、运维和性能验收文档。

## 非目标

- 不全面替换 `better-sqlite3`，不把短同步 CRUD 视为缺陷。
- 不在本 effort 迁移到 libSQL、远程数据库或数据库服务进程。
- 不把 Project `Work` / `WorkRun`、Agent Session 后台任务与内部 maintenance job 合并。
- 不改变 Wiki 节点、归档内容、Session、Provider 或 Flow 的业务语义。
- 不借性能修复放宽事务、revision、权限、审计或 crash-safety 契约。
- 不完成归档/维护的最终前端管理体验；后续 UI 可消费本 effort 的 API 和事件。
- 不顺带解决日志 secret redaction；同步日志的性能与敏感信息治理仍由 D-014 单独收敛。

## 当前实施安排

该 effort 必须等待 `wiki-system-redesign` 最终验收并合并，然后由 Plan 00 在合并后源码上
重新测量。它与 `local-backend-security-boundary` 共享 backend startup/readiness 文件，
与 `session-turn-lifecycle` 共享 archive/background integration 文件；这些是合并协调关系，
不是产品语义依赖。不得从 Wiki 旧基线或当前并行 worktree 开始写实现。
