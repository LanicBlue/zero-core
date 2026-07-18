# Acceptance 05：切换、响应性门禁与文档

对应 [Plan 05](plan-05-cutover-hardening.md)。

## A. Owner 收敛

- [ ] 全部 Plan 00 重路径重新分类，无未解释主线程无边界工作。
- [ ] bounded sync allowlist 每项有硬上限、理由和测试。
- [ ] CI 能发现新增未分类 sync I/O、无 cap 查询、事务大循环和 handler 重 statement。
- [ ] 旧 sync path、adapter、fallback、feature flag、重复 recovery/event 已删除。
- [ ] composition root 只有一个 supervisor/worker/startup owner。

## B. 100k 自动门禁

- [ ] Wiki full/diff/FTS/integrity、archive/sweep、backup/rotation、retention 均真实执行。
- [ ] 并发 heavy jobs 验证 disk token、writer lease、公平性、dedupe、backpressure。
- [ ] heartbeat max、slice p99、HTTP p99 满足 D1。
- [ ] WS/timer/read/short write queue 在负载中保持正确。
- [ ] 原始报告含环境、commit、fixture、吞吐、CPU/RSS/WAL/disk/busy/cancel。

## C. 1M release gate

- [ ] `1M` Wiki 数据实际运行，不用线性外推或 mock。
- [ ] 报告含硬件、OS、Node、磁盘、commit 和完整命令。
- [ ] event-loop/HTTP/WS 门禁通过，且 Wiki correctness/integrity/FTS 正确。
- [ ] 没有 Windows per-node 文件增长或百万 payload structured-clone。
- [ ] 未执行 1M 时 result 明确 FAIL/未完成，不能宣称 effort Final。

## D. 故障与资源

- [ ] parent/child/worker crash、shutdown/restart、late/duplicate event 有跨域测试。
- [ ] busy/corrupt/disk full/permission/job-store/event-loss/reconnect 有稳定结果。
- [ ] migration/commit/promote/delete/restore 临界点不会误报 success。
- [ ] 没有遗留 lease、running job、worker、listener、tmp 或未知 DB/artifact。
- [ ] retry/cancel 保持 attempt/generation fencing。

## E. 文档

- [ ] runtime、DB、archive、startup、API/event、operations 文档与代码一致。
- [ ] 文档明确 short sync/heavy、connection ownership、cancel/recovery 和三类任务分界。
- [ ] 100k/1M 命令、报告字段和故障处理可由新 Agent复现。
- [ ] 技术债只在 Final 证据充分后标 resolved。
- [ ] code graph 与链接检查通过。

## F. 全量回归

- [ ] typecheck、build:lib、unit、build、E2E、check:links 全绿。
- [ ] Wiki Final、archive correctness、Session/background、Security startup（如已合并）无回归。
- [ ] 没有 skipped/only、timeout 放宽、fixture 缩小或旧接口 fallback。
