# Final Acceptance：Backend I/O Scheduling

> 由非主要实现 Agent执行。任一核心数据正确性或响应性门禁失败，均不得声明 Final PASS。

## 1. 前置

- [ ] `result-00.md` 至 `result-05.md` 齐全且阶段 acceptance PASS。
- [ ] 当前 checkout 包含各阶段 commit，无生产 fallback/未提交实现文件。
- [ ] 从隔离 `ZERO_CORE_DIR`、临时 Git Project、fresh DB 和 legacy migration fixture 开始。
- [ ] 记录 commit、dirty files、Node/npm/Electron/better-sqlite3、CPU/RAM/OS/磁盘。
- [ ] 准备 100k 自动 fixture、1M release fixture、大 Session、多 orphan 和备份 fixture。

## 2. Startup migration

1. 启动 legacy fixture，并在 copy、verify、promote 前后分别故障注入。
2. 观察 parent lifecycle heartbeat、child progress、journal 和 ready。
3. 重启恢复并验证 Core/Wiki。

- [ ] parent 不打开 competing business handle，不阻塞 lifecycle heartbeat。
- [ ] normal API/WS 只在数据库 ready 后开放。
- [ ] 所有 crash point 可判定恢复，无数据丢失、重复迁移或双 source。
- [ ] integrity、foreign key、schema/layout marker 和 backup 正确。

## 3. Wiki 100k 运行时场景

在 full index、large diff、FTS rebuild 和 integrity 中持续：

- 每 10 ms 记录 heartbeat；
- 请求 live/status 和有界 Wiki read；
- 保持 WS ping/event；
- 提交短 Wiki write并分别等待、取消；
- 请求同一 reindex 验证 dedupe。

- [ ] heavy operation 在 worker connection，主线程不争长 writer lock。
- [ ] 读者只见 committed snapshot；短写在 commit 后重新鉴权/revision。
- [ ] failure/cancel 不推进 revision；success 只发一次 invalidation/event。
- [ ] D1 的 heartbeat max、slice p99、HTTP p99 全部通过。
- [ ] Wiki rename/content/link/FTS/integrity correctness 全部通过。

## 4. Archive 与文件场景

1. 归档大 Session，同时运行多个 orphan job。
2. 在 temp write、promote、DB delete 处 crash/restart。
3. 并发 snapshot、verify、rotation，并请求同一 job retry。

- [ ] 完整 payload 不进入主线程消息/job store。
- [ ] artifact verified 后才删 DB；每个 crash point 可幂等恢复。
- [ ] 单 Session 失败不阻断其他 job，active Session 不被 sweep。
- [ ] disk token/backpressure 生效，不形成 I/O 风暴。
- [ ] D1 与现有 archive/backup correctness 同时通过。

## 5. 取消、关机与 fencing

- [ ] waiter/Turn Stop 只取消等待，不意外取消 durable job。
- [ ] 显式 cancel 在 safe point 生效，commit phase 明确拒绝。
- [ ] graceful shutdown 和 forced worker/child kill 后状态为可恢复 interrupted/inspect。
- [ ] 旧 attempt/generation 的晚到 terminal 不能覆盖新 attempt。
- [ ] restart 后无永久 running job、遗留 lease、listener 或 worker。

## 6. 1M release gate

- [ ] 实际 1M Wiki full index、查询、FTS/maintenance 完成。
- [ ] 同时测 heartbeat、HTTP、WS、CPU/RSS/WAL/disk/busy 和 queue。
- [ ] D1 全部通过，数据库 integrity/foreign key/FTS 正确。
- [ ] 没有百万对象 structured-clone 或 per-node 磁盘文件。
- [ ] 报告包含完整环境、commit、命令和原始 JSON。

## 7. 权限与边界

- [ ] maintenance API 遵守当前 backend access policy。
- [ ] worker descriptor 不能执行任意 module/SQL/shell，路径逃逸被拒绝。
- [ ] job/event/metrics 不泄露 secret、正文、SQL 或绝对 Project 路径。
- [ ] MaintenanceJob 未进入 FlowDefinition、WorkRun 或 SessionTaskEvent 真相源。

## 8. 全量回归与文档

- [ ] typecheck、build:lib、unit、build、E2E、check:links 全绿。
- [ ] Wiki、Session、Provider、archive、backup、startup/Security（若已合并）无回归。
- [ ] 活动架构、运行手册、code graph 和技术债状态与代码一致。
- [ ] 无 skipped/only、timeout/预算放宽、fixture 缩小、mock heavy work 或兼容 fallback。

## 9. Final result

验收 Agent 创建 `result-final.md`，至少包含：

- 验收 commit 和所有阶段 commit；
- 100k/1M 原始报告路径和摘要；
- migration/Wiki/archive crash matrix；
- event-loop/HTTP/WS 数值；
- correctness 与全量命令；
- 未解决限制；
- 明确 `PASS` 或 `FAIL`。

只有本文件全部满足且用户同意，effort 才可合并/归档。
