# Acceptance M0 — 身份/上下文分离地基 + coding 场景全角色预设

> **前置**: `plan-overview.md` A0 通用前置(本文件不重复)。
> **核心原则**:验收只验证「身份 + bundle + 子 agent 委托 + 路由」,不验证下游 M 的能力(如不验 PM 的 cron 驱动 —— 那是 M1)。

### 数据层
- [ ] `AgentRecord` 已删 `projectId` / `cronSchedule` / `cronPrompt` / `wikiRootNodeId` / `lastScannedRef`,已加 `roleTag?`
- [ ] `ProjectRecord` 精简为 `{ id, name, workspaceDir, createdAt, updatedAt }`,运行态字段已删
- [ ] `SessionRecord` 已加 `context?: { projectId?, workspaceDir, wikiRootNodeId }`
- [ ] `db-migration.ts` 的 `AGENT_COLUMNS` / `PROJECT_COLUMNS` / `SESSION_COLUMNS` 三处已同步;fresh DB 跑通
- [ ] workspaceDir 规范化(resolve + realpath)落地;workspaceDir 唯一约束生效;创建后不可改

### bundle 与路由
- [ ] `resolveSessionByRoleProject(agentId, projectId)` find-or-create 实现存在;存在则续接、不存在则新建并填 bundle
- [ ] 同步调用子 agent 时,子 agent session 的 bundle 继承自 caller;caller 可 per-call 覆盖
- [ ] `delegateTask` 签名已扩展(目标 agent 全配置 + per-call 覆盖 + caller bundle 传下去);身份/toolPolicy/历史用目标 agent 自身

### 子 agent
- [ ] `createRoleLoopFactory` 已删除;grep 无残留调用
- [ ] toolPolicy 对 agent-tool 以 `AgentToolEntry.id` 为 key(UI 显示 name);改名不断引用

### 全角色预设
- [ ] coding 场景预设模板存在:lead / PM / archivist / analyzer(多 lens)/ planner(多领域)/ developer / reviewer / qa / zero
- [ ] 各预设 toolPolicy 按调用关系接好(lead 放行 planner/dev/review/qa + Orchestrate;PM 放行 analyzer;archivist 放行 analyzer + wiki 工具)
- [ ] 预设可一键实例化为全局 agent
- [ ] zero 的 project/agent 管理工具可用(create/update/delete project、agent、set toolPolicy、expose-as-tool)

### 端到端验证(本 M 核心)
- [ ] **一个全局 PM agent,经两个 session(各自携带 project A / project B 的 bundle)服务两个 project**
- [ ] `{PM, A}` 路由稳定续接(多次触发返回同一 session)
- [ ] 调 analyzer 时,analyzer session 继承到 caller(PM-A)的 bundle
- [ ] 预设 agent 已存在且可对话(机制未上线不影响身份存在)
