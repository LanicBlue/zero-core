# docs/design — 正在讨论的设计

本目录只放尚未进入实施计划的设计。设计中的类型、表、路由和命令是目标方案，不代表当前代码已经支持。

当前设计：

- [`external-subagent-mcp/issue.md`](external-subagent-mcp/issue.md)
- [`external-subagent-mcp/design.md`](external-subagent-mcp/design.md)

`session-turn-lifecycle`、`local-backend-security-boundary`、`project-flow-system`、
`agent-work-runtime`、`project-management-ui` 与 `agent-eval-harness` 已进入
[`../plan/`](../plan/README.md)。`wiki-system-redesign` 已完成并移入
[`../archive/`](../archive/README.md)。准确实施依赖以 plan 入口为准；这些人工/文档门禁不是 zero-core 已建立的 Flow 控制。

## 生命周期

1. 问题记录在 [`../issues/`](../issues/README.md)。
2. 讨论成熟后把整个 effort 目录移动到 `design/` 并补 `design.md`。
3. 可执行后移动到 [`../plan/`](../plan/README.md)，增加逐阶段 plan 与 acceptance。
4. 实施完成、验收通过并经用户同意后，移动到 [`../archive/`](../archive/README.md)。

当前架构以 [`../basic/`](../basic/README.md)、[`../arch/`](../arch/README.md) 和源码/测试为准。
