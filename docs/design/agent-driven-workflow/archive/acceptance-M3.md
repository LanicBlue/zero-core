# Acceptance M3 — Orchestrate 引擎 + lead 交付管线

> **前置**: `plan-overview.md` A0 通用前置(本文件不重复)。

- [ ] Orchestrate DSL 引擎存在(parallel/pipeline/if/for/barrier 至少最小子集)
- [ ] lead 调 planner 出大纲 → 自己拆 DSL(指定各节点 agent)→ 提交 Orchestrate
- [ ] **`Orchestrate.confirm` 门状态机**:提交后停住(不返回、不超时、不占资源、不发下一次 API call);`pending` → `confirmed`(run)/ `rejected`(返回 false + 理由)
- [ ] 看板有「plan 待确认」提醒入口
- [ ] 验收工作(单测/smoke/审查)作为流程节点自动执行,产出 manifest(改了哪些文件、跑了哪些测试、审查结果)
- [ ] requirement 状态转移 + Project 通知路由正确:ready→lead session / verify→PM session / accept→archivist session
- [ ] pickup 幂等(`assignedAgentId` 已写则跳过)
- [ ] cron 兜底:通知漏掉时对应角色 cron 补上
- [ ] 驳回回路:plan 驳回 lead 自重 Orchestrate / verify 未通过通知 lead 补
- [ ] commit 引用 requirementId(`feat: ... [req-123]`)
- [ ] lead 管 feature 分支(进 build 建 worktree 独立目录 / 每步 commit 引用 reqId / 默认串行)

### 端到端验证
- [ ] **一条 ready 需求走完:plan(confirm)→ build → verify → manifest**,通知正确路由到对应角色 session
- [ ] confirm 前不执行;confirm 后才 run;rejected 返回 false
