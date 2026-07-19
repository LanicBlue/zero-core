# Plan 05：切换、响应性门禁与文档

## 目标

完成所有重路径的 owner 收敛，建立防回归门禁、100k/1M 响应性报告、跨域故障注入和活动
文档；不得把未治理的主线程重任务留给“后续优化”。

## 实施范围

### 1. 全量重新 inventory

重跑 Plan 00 inventory，并把每条生产路径归为：

- bounded sync；
- async native；
- maintenance child；
- worker；
- cooperative batch。

建立 versioned sync I/O / main-thread SQLite allowlist，每项写明：

- owner/调用点；
- 数据量硬上限；
- 最坏 statement/file 大小；
- 为什么不随用户数据增长；
- 对应测试。

allowlist 不是按函数名宽泛豁免；新增未分类 `*Sync`、无 cap 查询、事务内大循环或普通 handler
重 statement 使 CI 失败。

### 2. 删除 adapter 和双路径

- 删除旧 sync migration/index/archive/maintenance handlers；
- 删除临时 feature flag、fallback、重复 recovery scan 和旧 event；
- composition root 只有一个 supervisor、worker pool和 startup owner；
- API/tool/UI caller 不再依赖旧阻塞返回格式；
- 历史文档保留历史事实，活动文档只描述当前实现。

### 3. 规模与并发

自动运行：

- 100k Wiki full index + read/write queue + FTS/integrity；
- 大 diff/rename；
- 大 Session archive + 多 orphan；
- snapshot/verify/rotation；
- runtime job retention；
- 多种重任务同时提交，验证 disk token、公平性、dedupe 和 backpressure。

发布前人工运行 1M Wiki gate。报告必须同时包含吞吐、event-loop/HTTP/WS latency、
CPU/RSS/WAL/disk、queue/busy/cancel，不只给总秒数。

### 4. 故障与关机

跨域故障注入：

- parent/child/worker crash；
- graceful shutdown、forced kill、restart；
- worker terminal 晚到/重复/乱序；
- DB busy/corrupt/disk full/permission；
- job store 写失败、progress event 丢失、WS reconnect；
- migration、Wiki commit、artifact promote、DB delete/restore 临界点。

检查没有 unknown state 被误报 success，没有 lease/job/listener 泄漏。

### 5. 活动文档

更新：

- backend runtime/composition；
- Core/Wiki DB lifecycle；
- Session archive；
- startup/readiness/recovery；
- maintenance API/event；
- performance/operations runbook；
- 技术债状态和 code graph。

明确：

- short sync 与 heavy job 判定；
- worker connection ownership；
- cancel/retry/recovery；
- 如何运行 100k/1M 和读取 event-loop report；
- MaintenanceJob 与 SessionTaskEvent/WorkRun 的区别。

## 完成定义

[Acceptance 05](acceptance-05-cutover-hardening.md) 通过并创建 `result-05.md`，再进入
[Final Acceptance](acceptance-final.md)。
