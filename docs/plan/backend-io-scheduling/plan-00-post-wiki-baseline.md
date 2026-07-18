# Plan 00：Wiki 合并后重 I/O 基线

## 目标

不实现调度功能；确认 Wiki Final 已通过并合并，在合并后真实代码上定位全部无边界同步
工作，建立 event-loop lag、SQLite 锁、启动和吞吐 baseline。

## 当前实施前置

- Wiki `result-final.md` 结论 PASS。
- 用户已同意 Wiki 合并，当前 checkout 包含目标 merge commit。
- 不从 Wiki 并行 worktree 或旧 `SessionDB` 文件映射开始。

任一不满足，按当前人工计划报告 blocked。Plan 00 不创建运行时 Flow/Work 状态。

## 实施范围

### 1. 环境和回归 baseline

记录：

- commit、Wiki merge commit、dirty files；
- Node、npm、Electron、better-sqlite3、CPU、内存、OS、磁盘类型；
- typecheck、build:lib、unit、build、E2E、check:links；
- 100k Wiki benchmark 和现有 archive/backup/migration 测试。

只使用隔离 `ZERO_CORE_DIR` 和临时 Git repository。

### 2. 重路径 inventory

为每条路径记录：

| 字段 | 内容 |
|---|---|
| operation | 启动 migration、full/diff index、FTS、integrity、archive、sweep、backup 等 |
| entry/owner | API/tool/startup/service/file/function |
| execution domain | backend main / native async / worker / child |
| DB/file calls | connection、transaction、sync fs、JSON/hash/git |
| bound | rows/bytes/time 是否有硬 cap |
| atomicity | 必须整批原子、可分批、artifact protocol |
| cancellation/recovery | 当前真实行为 |
| caller semantics | 同步等待、202/job、fire-and-forget |
| conflicts | Security/Session/Wiki/Project result 接口 |

同时扫描普通 API/tool 的无 cap list/search/export；不要只搜 `Sync` 后缀。

### 3. 响应性 harness

新增独立测试/benchmark harness，但不改生产执行路径：

- 10 ms main-thread heartbeat；
- `monitorEventLoopDelay` 和 event-loop utilization；
- 本地 live/status HTTP latency；
- WebSocket ping/event latency；
- worker/native thread CPU 与 backend CPU；
- SQLite busy/locked 次数和等待时间；
- job 前后 RSS、WAL、DB/artifact 大小。

至少测：

1. fresh 与 legacy 布局启动；
2. 100k Project full index；
3. large incremental diff；
4. FTS rebuild、integrity check；
5. 大 Session archive export；
6. 多 orphan sweep；
7. snapshot + verify + rotation。

测试保存原始 JSON 报告，不用 console 摘要代替证据。

### 4. 事务与锁实验

在临时数据库验证并记录：

- worker connection 持有 Wiki write transaction 时，主线程 WAL read 是否继续；
- 主线程短写在当前 busy timeout 下实际阻塞多久；
- worker rollback/commit 后 revision 和 FTS 状态；
- child/worker 被终止时 SQLite transaction/临时 artifact 的恢复状态；
- 现有 async backup 是否满足 event-loop 预算。

不得在生产代码中临时放宽 busy timeout 或 foreign key。

### 5. 数值判定

将每个场景与 design D1 对比，明确：

- baseline 最大 heartbeat gap / event-loop p99/max / HTTP p99；
- 哪些单 statement 超预算；
- 哪些路径可 cooperative batch；
- 哪些必须 worker/child；
- 哪些已有 async native 证据，可以保持。

## 明确不做

- 不引入 job 表、worker pool 或生产 API。
- 不修改 migration、Wiki、archive、backup 行为。
- 不把 benchmark 结果写成“已修复”。
- 不在 baseline 阶段调整 D1 数值预算。

## 完成定义

[Acceptance 00](acceptance-00-post-wiki-baseline.md) 通过并创建 `result-00.md`。
