# acceptance-4:cleanup-TTL 安全网 + 孤儿 sweep

> 据 [sub-4.md](./sub-4.md) 独立验收。

## D4 cleanup-TTL

1. sub-1 落地后,`delegator.cleanup()` 对已 terminal(行已删)任务:`deleteDelegatedTask` idempotent no-op,不抛、不影响 registry aging。
2. registry 内存 aging 仍生效:终态 task 超 maxAge 后从内存清(`taskRegistry.cleanup()` 返回值含它),DB 行已删(不重复)。
3. 源码注释说明「primary 删除在 terminal;safety net」。

## D5 sweepOrphanSessions

4. **清存量孤儿**:seed N 个 session(is_main=0、archived=0、updated_at 15 天前)+ 排除 active 集。sweep → 全部被 export JSON + deleteSessionData。返回计数 = N。
5. **不动 main**:is_main=1 的 session 即使超期 → 不被清。
6. **不动 active**:在 activeSessions 集合里的 session 即使 is_main=0 超期 → 不被清。
7. **不动近期**:`updated_at` 在 maxAgeDays(默认 14)内的 is_main=0 session → 不被清。
8. **export-before-delete**:被清 session 的 JSON 落盘 `archives/<agentId>/<id>.json`,内容含 session/steps/summaries;DB 行删后 JSON 仍在。
9. **单条失败不阻断**:某 orphan export 抛 → 该条 skip(log warn),其余继续,返回计数不含它。
10. **idempotent**:再跑一次 sweep → 0(已清的没了)。
11. **启动顺序**:index.ts 启动调 `recoverInterruptedArchives` 之后调 `sweepOrphanSessions`。

## 源码断言

12. `sweepOrphanSessions` 导出于 archive-service;index.ts 启动调用(recovery 之后)。
13. `listSessions` 支持 `{isMain, archived, olderThan, excludeActive}` 过滤(或等价)。

## 回归

14. 既有 task-cleanup-db / archive 测试不回归。
15. `npm run build:lib`(tsc)类型绿。
