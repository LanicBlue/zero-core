# Issue：Agent Eval Harness Skill

Agent 需要一套能对任意注册 Project 运行、可以随使用经验持续演进的 Eval 设施。把 runner、
grader、profile 或 scenario 固化进 zero-core 核心会提高发布耦合，也不利于 Agent 自己
维护该设施。

本 effort 只交付内置 `agent-eval-harness` Skill：

- `SKILL.md`、scripts、profiles、scenarios 和自测；
- deterministic outcome/trajectory 诊断及可选 model judge adapter；
- archive JSON 与可选 OpenTelemetry GenAI/OTLP trajectory adapter；
- 增量分析、checkpoint、稳定报告、可选 OTel evaluation result 与 Flow finding；
- seed 后可显式注册为普通 Project 的自主演进方式。

Flow/Work/Session/VFS/worktree 和管理 UI 是上游设施，不属于本 effort。
zero-core 原生 OTel instrumentation、实时 collector/export pipeline 和观测 UI 也不属于本
effort；它们若需要实施，应进入独立的 Agent Observability effort。
