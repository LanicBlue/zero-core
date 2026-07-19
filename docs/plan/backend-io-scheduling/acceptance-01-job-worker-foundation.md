# Acceptance 01：Maintenance Job 与 Worker 基础

对应 [Plan 01](plan-01-job-worker-foundation.md)。

## A. Job 状态

- [ ] fresh/upgrade schema 一致，migration 有明确 version/ledger。
- [ ] dedupe、attempt、revision、terminal retention 和 recovery policy 可查询。
- [ ] restart 后 running/cancelling 不会永久遗留或无检查自动重做。
- [ ] job payload 没有 secret、大正文、任意 SQL/module/shell。
- [ ] job 与 WorkRun、SessionTaskEvent 没有 schema 或 owner 混用。

## B. 调度

- [ ] 每 DB writer lease、全局 disk token、lane concurrency 符合 design。
- [ ] queue/按 kind cap、dedupe、FIFO + aging 有确定性测试。
- [ ] queue full 返回稳定错误，不泄漏 promise/listener。
- [ ] shutdown 停止接收、回收 lease并持久化 interrupted。

## C. Worker

- [ ] 固定 kind registry 和 descriptor schema 生效。
- [ ] Database/Statement/Store/service object 不跨线程。
- [ ] 旧 generation、旧 attempt、重复和乱序消息不能污染当前 job。
- [ ] worker crash/cancel/forced termination 有 lease 与状态恢复测试。
- [ ] 百万规模输入没有整体 structured-clone 路径。
- [ ] path traversal、任意 module/SQL/shell 注入被拒绝。

## D. Cooperative lane

- [ ] yield 只发生在 transaction 之外。
- [ ] row cap、8 ms time budget、cursor 和 cancellation 均有测试。
- [ ] slice duration 可观测，p99 门禁可由测试读取。
- [ ] crash 后从已提交 cursor 恢复，不重做已封存 batch。

## E. API 与 metrics

- [ ] list/detail 有 pagination/cap，cancel/retry stable error 完整。
- [ ] API 遵守当前 backend access policy，没有新旁路。
- [ ] `maintenance:changed` 有 revision、限频和 reconnect 查询路径。
- [ ] event-loop delay/heartbeat/ELU、lane/queue/active job 可查询。
- [ ] metrics/event 不含正文、secret、SQL 和绝对 Project 路径。

## F. 隔离

- [ ] 现有 migration、Wiki、archive、backup 行为尚未被静默切换。
- [ ] 没有 generic worker execute 或长期兼容双路径。
- [ ] typecheck、build、unit、integration、check:links 通过。
