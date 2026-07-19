# Acceptance 03：Wiki 重数据库操作隔离

对应 [Plan 03](plan-03-wiki-heavy-operations.md)。

## A. 执行域

- [ ] full index、大 diff、FTS rebuild、integrity 不在 backend 主线程执行。
- [ ] worker 使用独立 connection，terminal 前关闭；Database/Store 不跨线程。
- [ ] Git tree/diff 不整体 structured-clone，Git argv 不拼 shell。
- [ ] Project root/binding/revision 在 host 和 worker 双重校验。
- [ ] 旧同步 handler/production path 已删除。

## B. 事务与 Wiki 语义

- [ ] 失败、取消、worker crash 不推进 indexed revision、不留半索引/审计。
- [ ] rename/swap 保持 stable id、curated content、links、source binding 和 FTS。
- [ ] 读者在长 transaction 中看到上一 committed snapshot。
- [ ] success 后一次 cache invalidation/commit event；failure/cancel 不误失效。
- [ ] 没有 transaction 内 await、分批半可见或 staging 双真相源。

## C. Writer gate

- [ ] 主线程不通过长 busy timeout 等 worker writer。
- [ ] 短写 FIFO 有 cap、AbortSignal、caller/auth/revision 重新验证。
- [ ] queue full、caller cancel 和 unknown external lock 返回稳定状态。
- [ ] worker terminal 后按序 drain；过期 authorization/revision 拒绝而非强写。
- [ ] caller waiter 取消不自动取消 maintenance job。

## D. Maintenance API

- [ ] FTS/integrity/optimize 等 handler 只提交/查询 job，不直接跑重 statement。
- [ ] `202 + snapshot`、dedupe、status、cancel、retry 语义有 API 测试。
- [ ] status endpoint 有 cap，不以长 HTTP request 作为唯一真相源。
- [ ] progress event 与 Wiki content change event 不混淆。

## E. 响应性

- [ ] 100k full index、大 diff、FTS/integrity 期间 heartbeat max 和 HTTP p99 满足 D1。
- [ ] 同期 Wiki read 和 WS heartbeat 持续成功。
- [ ] SQLite busy/locked 次数、WAL 大小、CPU/RSS 和总吞吐有原始报告。
- [ ] 性能通过没有牺牲 Wiki Final correctness tests。

## F. 故障与回归

- [ ] cancel safe point、commit phase拒绝 cancel、worker crash/late event 均有测试。
- [ ] integrity/foreign key/FTS verify 通过。
- [ ] Wiki unit/integration/E2E、typecheck、build、check:links 通过。
- [ ] 全部数据使用隔离 DB/Project。
