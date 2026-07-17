# Issue: agent-eval-harness

- **状态**:③ plan(执行计划)
- **提出**:2026-07-16
- **类型**:新功能(质量基础设施)
- **来源**:2026-07-16 每日扫描建议(方向 1)
- **设计**:[design.md](./design.md)

> 2026-07-17 的设计讨论改变了最初落地方向：Eval 不再作为写入 zero-core
> AgentLoop 的固定测试子系统，而是一个包含脚本、profiles、scenarios 和测试的
> 内置 Skill；项目级 Flow 只负责状态、依赖与组合事实，Work 自己声明 trigger 和
> Agent 执行配置；
> `.zero-core` 使用内层 Git 管理过程文档，同一 Project Session 通过逐 turn execution
> context 执行不同任务。下文的问题证据仍有效，早期实现建议以
> [design.md](./design.md) 为准。

## 问题

zero-core 目前没有 **Agent trajectory/outcome 质量评估套件**。`tests/` 有 unit/e2e/spike，E2E 还包含 `tool-evaluator.ts`，但它们主要验证代码和单工具契约，不提供跨 turn 的 Agent 行为评分、基线数据集或 CI 退化门禁。后果是记忆、压缩、工具描述和 prompt 的质量变化难以重复比较。

本 issue 采用 [τ-bench](https://github.com/sierra-research/tau-bench) 等公开评测的设计方向：同时校验 **tool-call 轨迹与最终副作用状态**（Wiki/DB/文件），不只比较回答文本。外部框架只是研究输入，最终方案仍要适配 zero-core 的本地副作用模型。

## 现状 / 真相源 / 影响面

### 现成可复用的底座
- **`mock-language-model.ts`**([src/runtime/mock-language-model.ts](../../../src/runtime/mock-language-model.ts))已实现"JSON fixture 重放事件序列"的 `LanguageModelV2` mock,被 `provider-factory` 在 `type=mock` 时调用,**目前只用于 E2E 测试**。这正是 eval harness 需要的"确定性重放"底座——eval 可直接复用,无需从零造。
- **持久化齐全(生产 session replay 的原料)**:`steps` + `tool_executions` + `messages` + `sessions` 表已落全量 step([session-db.ts](../../../src/server/session-db.ts),`turns`→`steps` rename 后)。一个生产 session 的完整轨迹(每步消息 + 每次工具调用 + 结果)都在表里 → 可作为 eval 场景的**录制源**。

### 缺口
- **无场景库**:没有"标准 agent 任务 + 期望轨迹 / 期望终态"的 fixture 集合。
- **无断言框架**:没有"重放后校验 tool-call 序列 / wiki 子树内容 / DB 状态"的 assertion 层(tau-bench 式校验副作用)。
- **无生产→fixture 转换**:真实 session → mock fixture 的录制/转换工具缺失(生产 replay 的前置,见下方"相关方向")。
- **无可复用执行入口**:没有可由 Agent 在任意注册 Project 上调用、扩展和维护的
  Eval Skill；某次评估是否阻断后续 Work 也没有配置化表达方式。

### 目标影响面

- 新增内置 `agent-eval-harness` Skill，自包含 `SKILL.md`、脚本、profiles、
  scenarios 和测试。
- 建立带内层 Git 的项目级 `.zero-core/` 控制目录，以及按 turn execution context
  映射的 `flow://` 文档目录。
- 建立独立于旧 Requirement 的 Project FlowDefinition、Work trigger 和轻量 WorkRun
  模型。
- 支持 FlowInstance 之间同/跨 Project 的 milestone dependency，由配置指定哪些
  transition 必须等待依赖满足。
- 支持同 Project FlowInstance 按配置 split/merge，以独立、不可变 lineage 保存组合
  关系；跨 Project 组合由 dependency 协调。
- 保留同一 Agent 在同一 Project 上的长期 Session，用不可变 TurnInvocationContext
  切换当前 worktree、Work 和文档挂载。
- 不把 Eval 逻辑写进 AgentLoop，不默认修改被评估项目代码，也不设置全局 CI 门禁。

## 相关方向

- **生产 session replay / 确定性复现**:仍是高价值数据源，但不再要求与本 effort
  强绑定。当前归档已经是 `~/.zero-core/archives` 下的普通 JSON；专用分析 Agent
  可以把该目录作为 workspace，由全局 Cron 或归档 Project 的 Cron Work 增量调用
  Eval Skill。生产运行态重建可独立演进。

## 下一步

按本目录 [README.md](./README.md) 的阶段与 acceptance 执行。当前外部实施安排是先等待
`wiki-system-redesign` 完成最终验收并合并，再执行 Plan 00 reconciliation；这不是
zero-core 已建立的 Flow 控制。**当前尚未实施。**
