# Session / Turn Lifecycle：实施路线图

> 设计基线：[design.md](./design.md)  
> 状态：计划已于 2026-07-17 经用户确认，进入 **Ready**；尚未实施。  
> 当前实施安排：等待 [`wiki-system-redesign`](../wiki-system-redesign/README.md) 最终验收并
> 合并后执行 Plan 00。该顺序是当前人工计划，不是 zero-core 已建立的 Flow 控制。

## 目标

建立 Session/Turn 唯一状态机，统一 Stop、普通队列、软插队、Wait、AskUser、后台任务、
跨 Turn 事件、system continuation、Provider retry/recovery 和 compacting。

## 执行 Agent 必读

每阶段开始前依次阅读：

1. [issue.md](./issue.md)
2. [research.md](./research.md)
3. [design.md](./design.md)
4. 本 README
5. 当前 plan/acceptance
6. 已完成阶段的 result
7. Wiki 合并结果、当前源码和活动架构文档

若实现细节变化但 D1–D21 仍成立，只更新接口映射。若无法满足决策或 acceptance，停止并
回到设计讨论，不得保留新旧状态双真相源。

## 阶段

| 阶段 | Plan | Acceptance | 依赖 | 主要产物 |
|---|---|---|---|---|
| 00 | [Post-Wiki Reconciliation](plan-00-reconciliation.md) | [Acceptance 00](acceptance-00-reconciliation.md) | Wiki final + merge | 源码映射、复现、跨计划边界 |
| 01 | [Runtime State Core](plan-01-runtime-state-core.md) | [Acceptance 01](acceptance-01-runtime-state-core.md) | 00 | TurnRun、supervisor、snapshot、event fencing |
| 02 | [Cancellation & Stop](plan-02-cancellation-stop.md) | [Acceptance 02](acceptance-02-cancellation-stop.md) | 01 | cancellation tree、Stop pause、AskUser settle |
| 03 | [Inbox & Handoff](plan-03-inbox-handoff.md) | [Acceptance 03](acceptance-03-inbox-handoff.md) | 01–02 | invocation inbox、soft insert、atomic handoff |
| 04 | [Wait & Background Barrier](plan-04-wait-background.md) | [Acceptance 04](acceptance-04-wait-background.md) | 01–03 | task event inbox、hard barrier、continuation |
| 05 | [Provider Retry & Recovery](plan-05-provider-retry-recovery.md) | [Acceptance 05](acceptance-05-provider-retry-recovery.md) | 01–04 | transactional proposal、circuit、恢复控制合同 |
| 06 | [Compacting & UI](plan-06-compacting-ui.md) | [Acceptance 06](acceptance-06-compacting-ui.md) | 01–05 | compacting、统一 snapshot、首页 Provider Control Center |
| 07 | [Cutover & Hardening](plan-07-cutover-hardening.md) | [Acceptance 07](acceptance-07-cutover-hardening.md) | 01–06 | 删除旧真相源、race/restart/E2E、文档 |

全部通过后执行 [Final Acceptance](acceptance-final.md)。

```text
wiki FINAL + merge
        ↓
00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → FINAL
```

Agent Work Runtime Plan 02 必须在本计划核心契约可用后做 reconciliation；不能并行实现另一套
Turn/queue 生命周期。

## 提交与验收

- 每阶段独立 commit，并生成 `result-XX.md`。
- result 记录 commit、真实文件映射、命令、测试数、失败注入和偏差。
- 至少运行 typecheck、build:lib、相关 unit；涉及 UI/WS 时运行 build/E2E。
- 不允许以 skipped/only、延长 timeout 或保留旧布尔状态 fallback 通过验收。
- Final 由非主要实施 Agent 验证；最终合并仍由用户决定。
