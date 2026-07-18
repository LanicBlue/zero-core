# Backend I/O Scheduling：实施路线图

> 设计基线：[design.md](./design.md)
> 状态：计划已于 2026-07-18 经用户确认完成，进入 **Ready**；尚未实施。
> 当前实施安排：等待
> [`wiki-system-redesign`](../wiki-system-redesign/README.md) 最终验收并合并后，从 Plan 00
> 开始。该顺序是人工/文档门禁，不表示 zero-core 已建立对应 FlowDependency。

## 1. 目标

在保留 `better-sqlite3` 短同步 CRUD 的同时，保证数据库迁移、Wiki 索引/维护、
archive export、备份校验和大扫描不会无边界占用 backend 主线程：

- 可测的 event-loop latency budget；
- 可恢复的内部 maintenance job；
- 明确的 worker/child/connection ownership；
- 大事务原子性、revision 和 crash-safety 不退化；
- progress、cancel、retry 和 runtime status 可查询。

## 2. 执行 Agent 读序

每个阶段开始前依次阅读：

1. [issue.md](./issue.md)；
2. [design.md](./design.md)；
3. 本 README；
4. 当前 plan 与 acceptance；
5. 所有已完成阶段 result；
6. Wiki Final result、合并后源码和活动架构；
7. 若已合并，读取 `local-backend-security-boundary` 与 `session-turn-lifecycle` result。

文件/类改名可以在 result 中更新映射；D1–D10、事务语义、job/Work 分界或数值预算需要变化
时必须停止并交回用户，不得由实施 Agent 静默改写。

## 3. 阶段

| 阶段 | Plan | Acceptance | 依赖 | 主要产物 |
|---|---|---|---|---|
| 00 | [Post-Wiki Baseline](plan-00-post-wiki-baseline.md) | [Acceptance 00](acceptance-00-post-wiki-baseline.md) | Wiki Final + merge | 重路径清单、lag/锁/吞吐 baseline、真实所有者映射 |
| 01 | [Job & Worker Foundation](plan-01-job-worker-foundation.md) | [Acceptance 01](acceptance-01-job-worker-foundation.md) | 00 | supervisor、job store、lane、worker protocol、metrics/API |
| 02 | [Startup Migration Isolation](plan-02-startup-migration-isolation.md) | [Acceptance 02](acceptance-02-startup-migration-isolation.md) | 01 | maintenance child、bootstrap journal、async readiness |
| 03 | [Wiki Heavy Operations](plan-03-wiki-heavy-operations.md) | [Acceptance 03](acceptance-03-wiki-heavy-operations.md) | 01–02 | full/diff index、FTS/integrity worker、writer gate |
| 04 | [Archive & File Operations](plan-04-archive-file-operations.md) | [Acceptance 04](acceptance-04-archive-file-operations.md) | 01–03 | archive export、sweep、backup verify/rotation worker |
| 05 | [Cutover & Hardening](plan-05-cutover-hardening.md) | [Acceptance 05](acceptance-05-cutover-hardening.md) | 01–04 | 旧路径删除、100k/1M responsiveness、故障注入、活动文档 |

全部通过后执行 [Final Acceptance](acceptance-final.md)。

```text
wiki-system-redesign FINAL + merge
              ↓
00 → 01 → 02 → 03 → 04 → 05 → FINAL
```

## 4. 外部协调

### Local Backend Security

两者没有语义依赖，但都会修改 backend startup/readiness、`server/index`、Electron child
协议和 health：

- 不得在两个未合并 worktree 中同时实现这些重叠阶段；
- 先合并者成为真实 baseline；
- 后执行者在自己的 Plan 00/result 中映射接口，不恢复旧 startup surface；
- 若 Security 已建立 authenticated generation channel，Plan 02 必须复用，不能增加
  unauthenticated migration status endpoint。

### Session Turn Lifecycle

两者没有状态机依赖。Plan 04 只迁 archive export 的执行域和 job 状态，不改变 Memory turn、
Session/Turn、Stop 或 background event 语义。若 Session effort 先合并，按其 supervisor
接口接线；若后合并，它必须保留 MaintenanceJob 与 SessionTaskEvent 的分界。

### Project Flow / Work / Eval

无实施依赖，可在独立 worktree 并行。MaintenanceJob 不进入 FlowDefinition，不创建
WorkRun，也不要求 Eval Skill 修改。

## 5. 全程不可违反的不变量

- 不把 `better-sqlite3` connection/Statement/Store 跨线程传递。
- 不在同步 transaction callback 内 yield。
- 不用较长 `busy_timeout` 在主线程等待 worker writer。
- 不通过 worker message 复制百万节点、完整 archive JSON 或数据库 dump。
- 不为 responsiveness 放弃 Wiki 原子 revision、归档 export-before-delete 或 migration
  marker/backup。
- 不把返回 Promise 当作 event-loop isolation 的证据。
- 不用 skipped/only、放宽性能阈值、减小 fixture 或 mock 掉重工作通过验收。
- 不保留旧同步生产路径和新 job 路径长期双写/双跑。

## 6. 阶段提交与 result

- 每阶段独立 commit，并创建 `result-XX.md`。
- result 记录 baseline/target commit、环境、改动、命令、job/lag 数据、故障注入和偏差。
- 涉及 SQLite 的阶段必须使用隔离 `ZERO_CORE_DIR`，不得触碰用户活跃数据库。
- Acceptance 02–05 应由非主要实现 Agent复核关键 crash/锁/lag 证据。
- Final 与合并需要用户同意。

每阶段至少运行：

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run check:links
```

涉及完整 backend/Electron heartbeat 的阶段还需运行对应 integration/E2E；Final 必须运行
100k 自动负载和 1M release gate。
