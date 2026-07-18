# Acceptance 04：Archive 与重文件操作隔离

对应 [Plan 04](plan-04-archive-file-operations.md)。

## A. Archive 业务语义

- [ ] Memory turn、mark、Session replacement、export-before-delete 顺序没有改变。
- [ ] 每 Session 一个 deduped job，job 元数据不含消息/step/summary正文。
- [ ] MaintenanceJob 没有复用 WorkRun/SessionTaskEvent。
- [ ] fire-and-forget log 不再是唯一状态；失败、retry、result 可查询。

## B. Worker artifact

- [ ] worker 使用独立 readonly Core connection，完整 payload 不回主线程。
- [ ] temp/stream/hash/validate/atomic promote 有真实大 fixture。
- [ ] terminal result 只有受控 manifest/reference，无正文和绝对路径泄漏。
- [ ] 主线程在短 transaction 中重新验证后才删 DB 行。
- [ ] 已写 artifact + 删除失败可幂等完成，不生成不同内容或重复删除。

## C. Recovery/sweep

- [ ] startup discovery 分页/cooperative，主线程不直接导出全量候选。
- [ ] durable cursor、dedupe、active-session revalidation 和 per-session failure isolation
      有测试。
- [ ] 未写/tmp/final未删/DB已删/hash冲突都被 inspector 正确分类。
- [ ] 未知/冲突 artifact 不被覆盖，进入 recovery_required。
- [ ] restart 不遗留永久 running，也不重复成功副作用。

## D. Backup/file

- [ ] async native snapshot 保留且纳入 disk lease/job。
- [ ] 大 hash/verify/rotation/cleanup/restore 不在 backend 主线程。
- [ ] restore 前关闭 handle，完成后验证并安全重开。
- [ ] ZERO_CORE_DIR/protected path/symlink guard 没有回归。
- [ ] 普通 HTTP handler 没有同步遍历/复制/删除大集合。

## E. 响应性

- [ ] 大 Session export、多 orphan sweep、backup verify/rotation 期间满足 D1。
- [ ] 同期 HTTP、WS、Stop/timer probe 持续响应。
- [ ] event-loop、CPU、RSS、artifact bytes、queue 和总耗时有原始报告。
- [ ] 没有用小 fixture、mock writer 或只测 Promise 返回速度通过。

## F. 故障与回归

- [ ] cancel、worker crash、disk full、permission、corrupt artifact、hash conflict 有测试。
- [ ] archive cascade/correctness、backup restore、typecheck、build、unit/E2E、check:links 通过。
- [ ] 旧同步 export/recovery 路径和仅日志错误路径已删除。
- [ ] 保留的 sync marker/file call 全部在 allowlist 中写明固定 bound。
