# Plan 05：Work API 与 Agent 工具切换

## 目标

在 runtime/service 已验证后，原子切换 WorkDefinition 管理入口和 Agent-facing WorkRun
工具，不保留同名双语义。

## 依赖

Acceptance 00–04 通过。

## 实施范围

- Project 通用 config 注册 `kind: work` validate/publish/activate/list/get；
- Project 增加 `work.fire`，只创建 durable WorkRun，不直接调用 AgentLoop；
- Work 原子切换为
  `current/list/get/defer/prioritize/switch/cancel/retry`；
- CallerCtx 限制 mutation 到当前 Agent Session，switch 两端必须同 Project/Session；
- 提供 WorkDefinition/WorkRun API 给后续 UI，但不实现 renderer；
- 删除 Work create/update/delete/fire 和 ManagementService singleton 的新系统路径。

## 测试

覆盖三工具授权矩阵、definition version/snapshot、manual fire、defer/prioritize/switch、
无 Work 工具 Agent、伪造 scope 和 schema/prompt/registration 原子切换。

## 完成定义

[Acceptance 05](acceptance-05-work-api-tool-cutover.md) 通过并生成 `result-05.md`。
