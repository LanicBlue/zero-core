# Acceptance 02：启动迁移隔离

对应 [Plan 02](plan-02-startup-migration-isolation.md)。

## A. Ownership

- [ ] parent 在 bootstrap success 前没有 Core/Wiki business handle。
- [ ] child 使用固定 entry/结构化参数，不执行拼接 shell。
- [ ] child 独占 DB，所有 handle 关闭后才报告 success。
- [ ] parent 不再直接执行无边界 copy/hash/migration/integrity。
- [ ] 没有旧同步 fallback 或双 migration owner。

## B. Journal 与验证

- [ ] journal/marker 有 version、phase、generation、heartbeat、digest 和原子写测试。
- [ ] parent 同时验证 child exit、journal、layout marker、文件和 schema version。
- [ ] concurrent backend/child 被 exclusive lock 拒绝。
- [ ] Core DB ready 后可查询 bootstrap 历史，但 bootstrap 不依赖 Core job 表。

## C. Lifecycle

- [ ] parent 在长迁移期间 lifecycle heartbeat 持续，Electron/CLI 显示 migrating。
- [ ] normal HTTP/WS/business service 在 ready 前不可用。
- [ ] Security 已合并时复用其可信 generation channel，无 auth 旁路。
- [ ] 有 heartbeat 的合法迁移不会被普通 ready timeout 误杀。
- [ ] failed/recovery_required/process dead 可明确区分。

## D. 故障恢复

- [ ] checkpoint/copy/verify/promote/backup 各临界点有 crash fixture。
- [ ] parent crash、child crash/kill、磁盘满、权限、损坏 DB、未知 journal 均 fail closed。
- [ ] promote 临界段不接受破坏性 cancel。
- [ ] fresh、complete restart 和 interrupted recovery 幂等，无数据丢失或重复 backup。
- [ ] integrity/foreign key 和 source/target digest 继续满足 Wiki Final。

## E. 响应性与回归

- [ ] 大迁移期间 parent heartbeat 最大间隔满足 D1，原始报告入 result。
- [ ] migration 总耗时未被当作 event-loop lag。
- [ ] typecheck、build、unit、startup integration/E2E、check:links 通过。
- [ ] 使用隔离旧库 fixture，未触碰用户数据。
