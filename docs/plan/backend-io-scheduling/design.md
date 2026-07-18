# Design: backend-io-scheduling

> **状态**：2026-07-18 经用户确认；Ready，尚未实施。
> **问题**：[issue.md](./issue.md)。
> **外部前置**：`wiki-system-redesign` Final PASS + 用户同意合并。

## 0. 结论

zero-core 保留 `better-sqlite3` 作为 Core/Wiki 的短路径数据库实现，同时建立一个内部
`MaintenanceJobSupervisor`：

1. 需要大原子事务的 Wiki 索引/FTS 操作，放到持有独立 SQLite connection 的专用 worker；
2. 大文件序列化、hash、校验和扫描放到 worker，不能把巨大 payload structured-clone
   回主线程；
3. 可以安全拆分的数据库工作使用短事务、持久 cursor 和显式 event-loop yield；
4. 启动布局/schema 迁移放到独立 maintenance child process，在任何业务 DB handle
   打开前完成；
5. 在线备份等已有真正异步 native API 的路径继续复用，不机械重写；
6. 所有重任务都有 job identity、进度、attempt、取消、恢复和 event-loop lag 证据。

目标不是让主线程“零同步 I/O”，而是禁止**无边界同步工作**。小而有上限的
`prepare().get()/run()`、短事务和少量配置文件读取仍可留在主线程。

## 1. 设计不变量

### D1：事件循环预算

生产主线程不得运行数据量随 Session、Wiki 节点、Git tree、数据库页数或备份大小无界增长
的同步循环、同步序列化、同步文件读写或 SQLite statement。

首版预算：

- cooperative main-thread slice 目标不超过 8 ms；
- 调度器记录的 slice p99 不超过 16 ms；
- 100k/大归档集成负载下，10 ms heartbeat 的最大间隔不超过 200 ms；
- 同一负载下本机 live/status 请求（服从当时 backend access policy）p99 不超过 250 ms。

验收在空闲的受控机器执行并记录硬件、OS、Node 和磁盘。不能在失败后只放宽阈值通过；
如单个不可拆 SQLite statement 超预算，必须迁到 worker 或把预算变更交回用户。

### D2：短同步 CRUD 保留

有索引、有限结果集、无用户规模循环的短查询/事务可以在主线程执行。所有 list/search
必须有 SQL limit 或业务 cap；“通常很小”不是无边界操作的证明。

### D3：connection 不跨线程

`better-sqlite3` `Database`、Statement、Store 和 service object 都不能传给 worker。
worker/child 只接收小型、可验证的 job descriptor，并在自己的执行域内 open/close
专属 connection。connection 必须在 terminal event 前关闭。

### D4：原子性不为 yield 让路

不能在一个 `better-sqlite3` transaction callback 中 `await setImmediate()`。需要整批
原子可见的操作在 worker 的单事务中完成；可拆分操作用多个短事务和 durable cursor。
禁止为了 responsiveness 暴露半完成索引、推进错误 revision 或删除未验证归档。

### D5：主线程不等待 SQLite busy

主线程 connection 使用 fail-fast/极短 busy 策略。已知长 writer 由 supervisor 的
database lease 隔离，短写请求进入有界 FIFO；未知外部锁返回稳定 busy/retry 状态并通过
异步 backoff 重试，不能让 `busy_timeout` 同步睡眠数秒。

### D6：重任务可观察、可恢复

每个重任务有稳定 job id、dedupe key、kind、lane、attempt、phase、progress、revision、
heartbeat、错误类别和 recovery policy。进程崩溃后不能把 `running` 永远遗留，也不能
不加判断地重做已提交副作用。

### D7：控制事件 fencing

worker 消息必须携带 `jobId + attempt + workerGeneration + seq`。旧 worker 或旧 attempt
的晚到 progress/terminal event 只能进入诊断记录，不能改变当前 job 或新任务。

### D8：维护任务不是 Agent Work

`MaintenanceJob` 是应用内部运行任务：

- 不属于 Project Flow；
- 不创建 Work/WorkRun；
- 不绑定 Agent Session 或 TurnRun；
- Agent/HTTP 调用者取消等待不自动取消已经持久化的维护任务；
- 只有显式、已授权的 job cancel 才请求终止任务。

### D9：重活不通过消息复制回主线程

百万节点 Git tree、完整 Session payload、归档 JSON、数据库 dump 等不得通过
`postMessage` 整体 structured-clone。worker 从已验证的路径/DB snapshot 自取数据，或使用
有上限的 chunk/spool protocol。

### D10：不建立通用代码执行器

worker protocol 使用固定 kind registry 和 schema validation，不接收模块路径、函数文本、
任意 SQL 或 shell 字符串。路径由 host 从受信 Project/ZERO_CORE_DIR 事实源解析，worker
再次校验边界。

## 2. Maintenance job 模型

```ts
type MaintenanceJobState =
  | "queued"
  | "waiting_for_lease"
  | "running"
  | "cancelling"
  | "succeeded"
  | "cancelled"
  | "failed"
  | "interrupted";

type MaintenanceLane =
  | "bootstrap_process"
  | "wiki_writer_worker"
  | "core_export_worker"
  | "disk_worker"
  | "cooperative_main"
  | "async_native";

interface MaintenanceJobSnapshot {
  id: string;
  kind: string;
  dedupeKey: string;
  state: MaintenanceJobState;
  lane: MaintenanceLane;
  attempt: number;
  phase: string;
  progress?: {
    completed: number;
    total?: number;
    unit: "rows" | "nodes" | "bytes" | "steps";
  };
  cancellable: boolean;
  recoveryPolicy: "resume" | "restart" | "inspect";
  createdAt: number;
  updatedAt: number;
  heartbeatAt?: number;
  errorClass?: string;
  revision: number;
}
```

Runtime job 元数据写入 `core.db` 的专用 store；payload 只保存稳定业务 ID、revision、
小 descriptor、cursor 和 artifact reference，不保存 credential、大正文、绝对 Project
root 或整个索引输入。每次 attempt 由 host 根据 Project/ZERO_CORE_DIR 事实源重新解析并
校验路径，再把临时 resolved root 发给 worker。启动迁移发生在 Core DB 可用之前，因此
复用数据库布局 marker 并增加独立 bootstrap journal；它实现同一 snapshot 投影，但不依赖
`maintenance_jobs` 表。

### 2.1 状态与 retry

```text
queued → waiting_for_lease → running → succeeded
                              ├──────→ failed
                              ├──────→ interrupted → queued (按 recovery policy)
                              └──────→ cancelling → cancelled
```

- 同一 `dedupeKey` 只有一个非 terminal job。
- retry 增加 attempt，不改 job id；必须先执行该 kind 的 recovery inspection。
- `inspect` 类型不得自动重跑，必须确认 SQLite marker/artifact/commit 状态后再决定。
- terminal job 保留有界历史；retention 清理本身走 cooperative batch。
- progress 最多每 250 ms 或每个显式 phase 发布一次，避免事件风暴。

### 2.2 调度与背压

- `bootstrap_process` 全局独占。
- `wiki_writer_worker` 每个 `wiki.db` 同时一个 writer job。
- `core_export_worker` 可并行只读 snapshot，但受全局 disk-heavy token 限制。
- 首版全局 disk-heavy token 默认为 1，防止 Wiki、archive、hash 和 backup 同时打满磁盘。
- CPU/file worker 上限为 `min(2, max(1, availableParallelism - 1))`。
- queue 有总量和按 kind 上限；重复请求合并到现有 job，不无限排队。
- scheduler 使用 FIFO 加 aging，不能让持续小任务永久饿死长任务。

## 3. 执行域

### 3.1 Bootstrap maintenance process

布局迁移和大 schema migration 在业务 connection 建立前由独立 Node child 执行：

```text
backend parent
  → validate paths + acquire bootstrap lock
  → spawn fixed maintenance entry
  → child open exclusive DB → checkpoint/copy/migrate/verify/marker
  → progress/heartbeat over IPC
  → child closes all handles and exits
  → parent verifies marker → DatabaseManager opens Core/Wiki → ready
```

父进程保持 lifecycle IPC/stdio heartbeat；普通 HTTP/WS 业务 surface 在数据库 ready 前不
开放。若 `local-backend-security-boundary` 已合并，则 startup progress 复用其可信
generation channel，不能增加未认证 health 旁路。

child crash、超时或未知 marker 结果均 fail closed。commit/promote 临界段不可强制取消；
父进程先请求 graceful abort，只在 child 声明 safe phase 或无 heartbeat 且已超故障阈值时
终止，并在下次启动执行 inspection。

### 3.2 SQLite writer worker

需要整批 rollback/commit 的 Wiki full index、large diff、FTS rebuild 等由 worker 自己
打开 `wiki.db` 并持有 writer lease。主线程：

- 继续通过 WAL 执行有界读取；
- 不直接尝试竞争写锁；
- 把短写请求放入有界 FIFO，在 worker commit/rollback 后按原授权和 expected revision
  重新验证再执行；
- 对调用者暴露 waiting/busy，而不是同步卡在 `SQLITE_BUSY`。

worker job descriptor 只包含 project/repository id、经过 host 校验的 root、目标 Git
revision 和 binding revision。Git tree/diff 在 worker 内读取或写入受控 spool，不能先在
主线程构造百万条数组再发送。

取消通过 shared cancellation flag 和算法 safe point 检查。进入 SQLite commit/promote
phase 后 `cancellable=false`；强制 terminate 后必须执行 integrity/revision inspection。

### 3.3 File/CPU worker

Archive JSON 序列化、hash、压缩、备份校验、目录扫描等在 worker 内执行。worker 可使用
同步库，但必须：

- 定期报告 progress/heartbeat；
- 对大输出流式写临时文件并计算 hash；
- 原子 rename 前验证 schema/size/hash；
- 不把完整结果回传主线程；
- 返回 artifact manifest，最终业务状态转换由主线程短事务完成。

### 3.4 Cooperative main lane

只有满足以下条件的任务可用 cooperative main：

- 每个 item 都能独立提交或由 cursor 恢复；
- 每个 transaction 有固定 row/byte 上限；
- 批间使用显式 scheduler yield；
- 每个 slice 同时受 row cap 和 8 ms time budget；
- cancellation 只在 transaction 之间生效；
- 不依赖一个跨 yield 的 SQLite transaction。

它适合 job retention、按 Session 的 orphan sweep 提交、旧 artifact 清理等，不适合
full index、FTS rebuild 或单个巨大 JSON.stringify。

### 3.5 Async native lane

已有 `Database.backup()` 等真正异步的 native API 保持原实现，但仍纳入 job progress、
disk-heavy lease、cancel/recovery 和 event-loop 验收。不能因为返回 Promise 就默认它已经
满足预算，必须以 heartbeat 证据确认。

## 4. 重点流程

### 4.1 Wiki full/incremental index

1. host 校验 Project binding、root、target revision 和权限，创建/dedupe job；
2. supervisor 获取 wiki writer + disk lease；
3. worker 自取 Git tree/diff，在自己的 connection 中开始事务；
4. 每批节点检查 cancellation、更新内存 progress，并以限频消息报告；
5. rename、stable id、curated summary/content、links 和 source binding 继续遵守 Wiki
   Final 契约；
6. 成功时同一事务最后推进 `indexed_revision`；失败/取消整批 rollback；
7. connection 关闭后 worker 报 terminal；
8. 主线程验证 revision，失效一次 Wiki cache，发布一次 domain event，再 drain 短写队列。

读者在长事务期间只看到上一个 committed WAL snapshot。不得为 responsiveness 改成半索引
可见。若单事务导致 WAL/磁盘压力超出 release gate，后续可设计 generation/staging schema，
但不在首版未经测量提前引入双真相源。

### 4.2 Archive export

Memory turn/Session 业务决策仍由现有 archive pipeline 负责；进入 export 后：

1. 短事务把 Session 标记为待导出并创建/dedupe archive job；
2. worker 以只读 Core connection 读取稳定 archived Session，流式生成临时 artifact；
3. worker 校验并原子 promote，返回 manifest/hash/size；
4. 主线程短事务重新核对 session id、archive state 和 artifact manifest，再删除 DB 行；
5. terminal 状态和 artifact reference 持久化。

调用者取消等待不删除 job。失败保留 DB 行和临时/正式 artifact 的可检查状态；retry 先按
manifest 检查“未写、已写未删、已删已完成”三种情况。启动 recovery 只重排 interrupted
job，不在主线程同步遍历并导出全部 Session。

### 4.3 Backup、integrity 与 FTS

- snapshot 使用已验证的 async native backup；
- manifest hash、verify、rotation 和 restore 文件操作进入 disk worker；
- restore 是独占 maintenance mode，所有 DB handle 关闭后执行；
- `integrity_check`、`foreign_key_check`、FTS rebuild/optimize 在 worker connection 执行；
- HTTP 请求只创建 job 或查询结果，不能在 handler 内直接运行重 statement。

### 4.4 普通大查询

主线程 API/tool 的搜索、list、history 和 audit 查询必须有 cap/cursor。确实需要导出全量时，
转换为 export job/artifact；不能用一个返回巨大 JSON 的普通 endpoint 绕过本设计。

## 5. 可观测性与控制面

新增受现有 backend access policy 保护的内部 API：

```text
GET  /api/runtime/maintenance/jobs
GET  /api/runtime/maintenance/jobs/:id
POST /api/runtime/maintenance/jobs/:id/cancel
POST /api/runtime/maintenance/jobs/:id/retry
GET  /api/runtime/health/event-loop
```

状态通过既有 WS/data-change 机制发布 `maintenance:changed`，payload 只含 snapshot 和
revision，不含路径、SQL、Session 内容或 secret。API 是否代理到 Renderer、最终首页布局
和逐 action Agent tool 权限不在本 effort；后续
[`archive-observability`](../../issues/archive-observability/issue.md) 可直接消费。

`monitorEventLoopDelay`、heartbeat gap、event-loop utilization、active job/lane、queue depth
和最近 long-stall 进入结构化 runtime metrics。原始 reasoning、Wiki/Session 正文和绝对
Project 路径不得进入 telemetry。

## 6. 与其他生命周期的关系

### Session / Turn

Maintenance job 不要求 Session 保持 active Turn。若 Tool/API 选择等待 job，Turn 只持有一个
可取消 waiter；Stop 取消 waiter，不取消 job。job terminal event 可由现有普通通知/查询呈现，
不伪装成 `SessionTaskEvent`。

### Project Work

内部 reindex/archive/migration 不是 Agent 自主排程的 WorkRun。未来 Work 可以调用“请求
reindex”API，但 supervisor 仍拥有实际 job、dedupe、lease 和恢复。

### Provider

Provider retry/circuit 与 maintenance scheduler 相互独立。event-loop 卡顿不能被误报成
Provider timeout；最终验收必须在重任务期间验证 Provider/WS timer 仍按时运行。

## 7. 错误、取消与关机

- 稳定错误至少包括 `JOB_NOT_FOUND`、`JOB_NOT_CANCELLABLE`、`JOB_ALREADY_TERMINAL`、
  `JOB_QUEUE_FULL`、`JOB_LEASE_BUSY`、`JOB_WORKER_CRASHED`、`JOB_RECOVERY_REQUIRED`。
- graceful shutdown 停止接收新 job，等待短临界段，通知 worker safe cancel，并持久化
  interrupted；不能在未知 commit 状态直接宣称 failed。
- worker crash 后 supervisor 回收 lease；SQLite job 下一步必须检查 transaction/revision，
  artifact job 检查 tmp/final manifest。
- retry 不重用旧 worker generation，不覆盖原错误/attempt 审计。
- cancel 是请求，不保证能中断单个 native SQLite statement；状态必须明确
  `cancelling` / `not_cancellable`，不能假装即时成功。

## 8. 迁移与切换

1. Wiki Final 合并后先建立实际重路径清单和 lag baseline。
2. 引入 supervisor/worker/metrics，但暂不改变业务路径。
3. 先迁启动迁移，验证 child recovery。
4. 再迁 Wiki writer/maintenance，保持 Wiki 事务契约。
5. 再迁 archive/backup/file heavy 路径。
6. 删除旧 fire-and-forget、同步 handler 和重复 startup sweep。
7. 建立允许保留的 sync I/O/SQLite inventory；新增无边界路径必须过审和测试。

切换不保留长期双实现或环境变量 fallback。每个阶段的 adapter 必须在同阶段或明确后续阶段
删除，最终只能有一个生产 owner。

## 9. 被拒绝的替代方案

### 全面换 libSQL/异步 ORM

影响所有 Store、事务和测试，不能自动解决巨大 payload、恢复和任务可观测性。首版拒绝；
未来可在真实 lag/锁争用数据表明 worker connection 不足时另开数据库 effort。

### 给所有循环加 `setImmediate`

无法在同步 transaction callback 中安全 yield，也不能拆开单个 FTS/integrity statement；
会诱导半提交。只允许用于已经证明可分批的 cooperative lane。

### 只增加 worker pool

没有 job、lease、fencing 和 recovery 时，worker 会与主线程争 SQLite writer、复制巨大输入，
并在 crash 后留下未知状态。worker 是执行域，不是完整设计。

### 只把函数标成 async / fire-and-forget

同步工作仍先占满当前事件循环；Promise 形式不是隔离证据。

### 每个重任务使用 WorkRun

把内部数据库维护暴露为 Agent workflow 会增加配置摩擦、权限混淆和启动自依赖，且无法处理
Core DB 尚未打开的迁移。拒绝。
