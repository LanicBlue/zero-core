# Plan 01：Maintenance Job 与 Worker 基础

## 目标

建立 design 定义的 job 状态、调度 lane、worker protocol、event-loop metrics 和内部控制
API，但尚不迁移 Wiki/archive 等具体重业务路径。

## 实施范围

### 1. Job store 与 supervisor

新增：

- `MaintenanceJobStore`：schema、snapshot、revision、attempt、dedupe、terminal retention；
- `MaintenanceJobSupervisor`：queue、lane、lease、retry、cancel、shutdown/recovery；
- `MaintenanceJobRegistry`：固定 kind → handler/descriptor schema/recovery inspector；
- 单一 composition owner，其他 service 只提交 descriptor 或订阅 snapshot。

要求：

- 同 dedupe key 只有一个非 terminal job；
- state transition 使用 expected revision/事务；
- startup 把遗留 running/cancelling 标成 interrupted，再按 recovery policy 处理；
- job payload 不存 secret、大正文、任意 SQL 或可执行模块路径；
- retention 清理按 cooperative batch 执行。

新增 schema 必须同时覆盖 fresh 与 upgrade，并进入正式 migration ledger/测试，不由 Store
构造器每次猜测修补。

### 2. Lane 与 lease

实现：

- `wiki_writer_worker` / `core_export_worker` / `disk_worker` / `cooperative_main` /
  `async_native` lane；
- 全局 disk-heavy token；
- 每 DB domain writer lease；
- 有界 queue、按 kind cap、dedupe 和 FIFO + aging；
- shutdown drain 和 lease 回收。

bootstrap process 的真实迁移在 Plan 02；本阶段只实现公共 snapshot/journal adapter contract。

### 3. 固定 worker protocol

创建固定 entry 和 schema-validated message：

```text
start(jobId, attempt, generation, kind, descriptor)
progress(jobId, attempt, generation, seq, phase, completed, total?)
heartbeat(jobId, attempt, generation, seq)
terminal(jobId, attempt, generation, seq, resultRef | error)
cancel(jobId, attempt, generation)
```

- registry 显式列出允许 kind；
- worker 不能接收任意函数、module、SQL/shell；
- descriptor path 必须来自 host resolved root 并在 worker 再校验；
- 大 payload 使用 worker 自取或 chunk/spool；
- late/duplicate/out-of-order event 由 fencing/idempotency 测试覆盖；
- worker crash 回收 lease 并进入 interrupted/inspection。

### 4. Cooperative scheduler

实现同时按 row cap 与 8 ms budget 判断的 slice controller：

- transaction 外 yield；
- AbortSignal/supervisor cancellation；
- durable cursor adapter；
- 每 slice duration metrics；
- 测试使用 fake clock 和真实 heartbeat，不用 sleep 猜测。

### 5. Metrics、API 与事件

实现 design 第 5 节 API、`maintenance:changed` 和 event-loop metrics：

- pagination/filter，不返回无限 job history；
- cancel/retry 使用 stable error；
- API 服从当前 backend access policy；
- metrics 不含正文、绝对 Project 路径、SQL 或 secret；
- status endpoint 本身只做有界读取，不执行 integrity 等重工作。

本阶段不做完整 Renderer UI。

## 测试

- job transition、dedupe、revision、retention；
- lane concurrency、公平性、queue full、lease；
- worker protocol/fencing/crash/cancel/path validation；
- cooperative slice/yield/cursor/crash；
- API pagination/error/access policy；
- event-loop metrics 和 event 限频；
- shutdown/restart interrupted recovery。

## 明确不做

- 不切换 migration、Wiki、archive 或 backup 生产路径。
- 不新增 generic worker execute API。
- 不把 MaintenanceJob 接到 Flow/Work/SessionTaskEvent。
- 不用长 `busy_timeout` 实现 lease。

## 完成定义

[Acceptance 01](acceptance-01-job-worker-foundation.md) 通过并创建 `result-01.md`。
