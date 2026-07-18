# Agent Eval Harness Skill：实施路线图

> 状态：设计完成，尚未实施。
> 外部前置：`project-flow-system` Final、`agent-work-runtime` Final。
> UI effort 不是前置，可与本 effort 并行。
> 共同合同：[Agent Project Automation](../agent-project-automation.md)。

## 阶段

| 阶段 | Plan | Acceptance | 依赖 | 主要产物 |
|---|---|---|---|---|
| 00 | [Upstream Reconciliation](plan-00-upstream-reconciliation.md) | [Acceptance 00](acceptance-00-upstream-reconciliation.md) | Flow + Work Final | Tool/VFS/archive/OTel 基线 |
| 01 | [Eval Skill & Archive Analyst](plan-01-eval-skill-archive-analyst.md) | [Acceptance 01](acceptance-01-eval-skill-archive-analyst.md) | 00 | bundled Skill、runner、profiles/scenarios、archive/OTLP adapters |
| 02 | [Hardening](plan-02-hardening.md) | [Acceptance 02](acceptance-02-hardening.md) | 01 | 打包、兼容、故障、安全、性能、文档 |

全部阶段通过后执行 [Final Acceptance](acceptance-final.md)。

```text
project-flow-system FINAL ─┐
                           ├→ 00 → 01 → 02 → FINAL
agent-work-runtime FINAL ──┘
```

## 不变量

- Eval 是 Skill，不是 zero-core 固定业务服务。
- 启动只 seed，不自动注册/执行。
- 默认 deterministic，model judge 显式启用。
- Eval 只诊断，不直接修复目标项目代码。
- archive 分析不读私有 DB、不修改 archive。
- OTel 只是 Skill adapter，不替代版本化 Eval 合同或业务状态真相源。
- 默认不发送 telemetry；输入内容和输出 export 都由 profile 显式启用并 redaction。
- 本 effort 不修改 AgentLoop/Provider/Session/Flow/Work runtime，不实现原生实时埋点。
- 本地 Skill 演进不自动写回 bundled source。
