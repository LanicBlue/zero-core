# Agent Work Runtime：实施路线图

> 状态：设计完成，尚未实施。
> 外部前置：`project-flow-system` Final、`session-turn-lifecycle` Final。
> 共同合同：[Agent Project Automation](../agent-project-automation.md)。

## 阶段

| 阶段 | Plan | Acceptance | 依赖 | 主要产物 |
|---|---|---|---|---|
| 00 | [Upstream Reconciliation](plan-00-upstream-reconciliation.md) | [Acceptance 00](acceptance-00-upstream-reconciliation.md) | Flow + Session Final | 合并后接口映射 |
| 01 | [Work & WorkRun](plan-01-work-and-workrun.md) | [Acceptance 01](acceptance-01-work-and-workrun.md) | 00 | Work trigger、持久 queue |
| 02 | [Invocation Context](plan-02-invocation-context.md) | [Acceptance 02](acceptance-02-invocation-context.md) | 01 | Project Session、逐 Turn context |
| 03 | [VFS & URI](plan-03-vfs-uri-cutover.md) | [Acceptance 03](acceptance-03-vfs-uri-cutover.md) | 02 | `.zero-core` 隐藏、`flow://`、`skill://` |
| 04 | [Worktree Execution](plan-04-worktree-execution.md) | [Acceptance 04](acceptance-04-worktree-execution.md) | 03 | linked worktree 执行与清理 |
| 05 | [Work API & Tool Cutover](plan-05-work-api-tool-cutover.md) | [Acceptance 05](acceptance-05-work-api-tool-cutover.md) | 01–04 | Project work config、Work runtime tool |
| 06 | [Hardening](plan-06-hardening.md) | [Acceptance 06](acceptance-06-hardening.md) | 01–05 | 恢复、故障、性能、清理 |

全部阶段通过后执行 [Final Acceptance](acceptance-final.md)。

```text
project-flow-system FINAL ─┐
                           ├→ 00 → 01 → 02 → 03 → 04 → 05 → 06 → FINAL
session-turn-lifecycle FINAL┘
```

## 不变量

- Flow 只发事件；Work trigger 创建持久 WorkRun。
- Project Session 不绑定 Flow，Work 运行上下文不写回长期 Session。
- 同一 Session 不并发运行两个 Turn；busy run 不 skip。
- Agent 调整队列必须显式、可审计且限制在当前 Agent Session。
- `skill://`/`flow://` 是应用 VFS，不冒充任意 Shell 的 OS 沙盒。
- 要求 worktree 的执行失败时不回退主目录。
