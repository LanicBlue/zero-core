# Plan M0 — 身份/上下文分离地基 + coding 场景全角色预设

> **依赖**:无(根)。
> **对应 RFC**: §2.1(身份分离)/ §2.11(session bundle)/ §4.1-4.4(数据模型)/ §5(影响清单)/ §3(预设)。
> **验收**: `acceptance-M0.md`(前置见 `plan-overview.md` A0)。

**为什么第一**:v0.8 整个 RFC 建在「角色全局化 + session 携带上下文 bundle」上。这层不立,后面全落空。同时纵向交付 coding 场景角色预设,使后续每个 M 都有「能被驱动的人」。

## 设计细节要求

### 数据层

1. `AgentRecord` **瘦身**:移除 `projectId` / `cronSchedule` / `cronPrompt` / `wikiRootNodeId` / `lastScannedRef`;加 `roleTag?: string`(仅 UI 分组与预设入口,非运行时类型)、保留 `workspaceDir?`(全局/独立 agent 默认 workspace;项目角色 session 走 project.workspaceDir 忽略此项)。**不加** `workflowRole` / `subAgentChain`(RFC §4.1,决策 1)。
2. `ProjectRecord` 精简为 `{ id, name, workspaceDir, createdAt, updatedAt }`。删 `analysisInterval` / `status` / `analystCronId` / `analystSessionId`(决策 4)。
3. `SessionRecord` 加 `context?: { projectId?: string; workspaceDir: string; wikiRootNodeId: string }`(决策 42)。
4. DB migration:`agents` 表删列 + 加 `roleTag`;`projects` 表精简;`sessions` 表加 `context` 列(JSON)。**同步 `AGENT_COLUMNS`、`PROJECT_COLUMNS`、`SESSION_COLUMNS` 三处**。
5. workspaceDir 规范化:`path.resolve` + `fs.realpath` 归一落库;一个 workspaceDir 只能绑一个 Project(唯一约束,防 split-brain);创建后不可改(Q1,决策 5)。

### session 上下文 bundle 与路由

6. **`{角色, projectId} → session` 路由**:查找键 = `(agentId, context.projectId)`。存在则续接(返回已有 session),不存在则新建(填入 bundle)。这是 discuss/通知/cron 三者的统一入口预埋(决策 43)。实现为独立 helper(`resolveSessionByRoleProject` 或类似),供 M1(cron)、M3(通知)、M4(discuss)复用。
7. **bundle 谁塞给 session**:
   - 被同步调用(子 agent)→ **继承 caller session 的 bundle**,caller 可 per-call 覆盖(如限定子目录)。
   - 被异步触发(M1 cron、M3 notification)→ 来自触发器的 scope。
8. `delegateTask` 扩展签名:传目标 agent **全配置**(toolPolicy、agentId)+ **per-call 覆盖**(workspace、scope、bundle 覆盖);同步调用时把 caller bundle 传下去。身份/toolPolicy/历史用目标 agent 自身(决策 16)。

### 子 agent 走 delegateTask(删 createRoleLoopFactory)

9. 删 `src/server/agent-service.ts` 的 `createRoleLoopFactory`;子 agent(developer/reviewer/qa/analyzer/planner)全部走 `delegateTask` + toolPolicy + caller bundle 继承(RFC §5 编排层)。
10. toolPolicy 对 agent-tool 已 opt-in;**以 `AgentToolEntry.id`(稳定)为 key 存配置,UI 显示工具名** —— 改名不断引用、删工具才 orphan(决策 2)。确认现有 `AgentToolEntry.id` 实现稳定再依赖。

### coding 场景角色预设模板(纵向交付)

11. 内置**角色预设模板**(全局角色,prompt + toolPolicy + roleTag 组合),一键实例化:lead / PM / archivist / analyzer(多 lens:UI/安全/性能/架构)/ planner(多领域:功能/bugfix/重构/调研)/ developer / reviewer / qa / zero。模板只是起点,可任意组合(RFC §3)。
12. 各预设的 toolPolicy 按调用关系接好:**lead 放行 planner/dev/review/qa + Orchestrate**;**PM 放行 analyzer**;**archivist 放行 analyzer(架构 lens)+ wiki 树读写工具**;dev/review/qa 继承 caller(决策 1/2 + §3 表)。
13. **机制未上线前预设的降级表现要诚实标注**:M0 阶段这些 agent 已存在且可对话,但 PM 没有 cron 驱动(M1)、archivist 没有 wiki 树(M2)、lead 没有 Orchestrate(M3);M0 验收只覆盖「身份 + bundle + 子 agent 委托 + 路由」,不覆盖角色完整行为。

### project / agent 管理工具(zero 用)

14. zero 全局管理角色的工具层:封装 ProjectStore/AgentStore —— create/update/delete project、create/update/delete agent(含实例化预设)、set toolPolicy、expose-as-tool(决策 24)。cron 管理工具留 M1。

## 风险

- 删 `createRoleLoopFactory` 可能牵连旧 M1-M5 调用点 —— 改前 grep 全部调用方,确认归入 M0 还是后续 M。
- `delegateTask` 扩展签名是底层改动,影响面大;先确认现有所有 caller。
