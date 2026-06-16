# Plan M3 — Orchestrate 引擎 + lead 交付管线

> **依赖**: M0(delegateTask 扩展)+ M2(lead 读 wiki 做 plan)。
> **对应 RFC**: §2.6 / §2.9 / §2.15 / §2.17b / §4.5 / §4.7 / §5 编排层。
> **验收**: `acceptance-M3.md`(前置见 `plan-overview.md` A0)。

## 设计细节要求

1. **Orchestrate DSL 引擎**(系统工具,`src/runtime/tools/orchestrate-tool.ts`):节点 `parallel` / `pipeline` / `if` / `for` / `barrier`;每个节点引用 lead toolPolicy 放行的 agent-tool(具体调 agent 仍走 toolPolicy + delegateTask 继承 caller bundle)(决策 48)。
2. **lead 是 DSL 作者**:lead 调 planner 出大纲 → **自己把大纲拆成 Orchestrate DSL**(指定各节点用哪个 agent)→ 提交给 Orchestrate 工具(决策 11/48)。Orchestrate 是执行引擎,不是 DSL 作者。
3. **`Orchestrate.confirm` 门状态机**:
   - lead 调用 Orchestrate 提交流程 → 工具**停住、未返回、不超时、不占资源(不发下一次 API call)**,等用户确认。
   - 状态:`pending`(等确认)→ `confirmed`(run)/ `rejected`(返回 false + 驳回理由)。
   - 审核暂停本质 = 「工具调用还没返回、在等用户反馈」(决策 11)。
   - 用户在哪看到有 plan 待审 = 看板提醒入口(OQ4)。
4. **验收工作作为流程节点**:单测/smoke/审查在 Orchestrate 流程内自动执行,**产出 manifest**(这个需求改了哪些文件、跑了哪些测试、审查结果如何)(决策 34)。
5. **requirement 状态转移 + Project 通知**:进 `ready` → 通知 lead session(pickup);进 `verify` → 通知 PM session;verify accept → 通知 archivist session(合并 main)。通知目标走 M0 的 `{角色, projectId} → session` 路由(决策 10)。
6. **pickup 幂等**:`assignedAgentId` 已写则跳过(OQ5)。
7. **cron 兜底**:ready/verify 交接点若通知漏掉,对应角色的 cron(scope=该 project)扫到补上。
8. **驳回回路**:plan 门驳回 → lead 自重 Orchestrate 流程(同角色);仅需求本身有问题才退 discuss 通知 PM。verify 不通过(PM 判未覆盖)→ PM→lead 通知补(决策 11)。
9. **约定 commit 引用 requirementId**(如 `feat: ... [req-123]`)喂 traceability(决策 21)。
10. **lead 管 feature 分支**:进 build 时建 feature worktree(独立目录,`{workspace}.worktrees/req-{id}/`,分支 `req-{requirementId}`);每步 commit 引用 reqId;默认串行(决策 25/28)。

## 风险

- `Orchestrate.confirm` 的「停住不占资源」语义是关键 —— 确认实现路径(工具 result 挂起 + 外部 resolve),别退化成轮询或长连接占资源。
- DSL 引擎的状态机复杂度高(parallel/barrier 的同步);先实现最小子集(parallel + pipeline + confirm),if/for 可后置。
