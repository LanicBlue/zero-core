# M2 验收标准：项目分析 Agent

> **对应设计**: `design-M2.md` (v2.0)
> **对应计划**: `plan-M2.md`
> **前置**: M1 全部验收通过

---

## 1. 前置条件

- [ ] M1 全部验收标准通过
- [ ] `npm run build:lib` 编译无错误
- [ ] `npm run build` 全量构建通过

---

## 2. 角色系统

### AC-2.1: 角色配置完整性

**验证** `WORKFLOW_ROLES` 包含 5 个角色：
- [ ] analyst, lead, developer, reviewer, qa
- [ ] 每个角色有 `role`, `displayName`, `baseTemplate`, `toolPolicy`, `promptAppend`, `contextPolicy`, `persistent`

### AC-2.2: 基座模板继承

**验证**:
- [ ] analyst.baseTemplate = "Researcher"
- [ ] lead.baseTemplate = "Architect"
- [ ] developer.baseTemplate = "Coder"
- [ ] reviewer.baseTemplate = "Reviewer"
- [ ] qa.baseTemplate = "Coder"

### AC-2.3: Prompt 构建 — 基座 + 追加

**测试**: 调用 `buildWorkflowSystemPrompt('developer', templateStore)`

**预期**:
- [ ] 返回字符串包含 Coder 模板的 systemPrompt 内容（如 "Read before you write"）
- [ ] 返回字符串包含 Developer 的 promptAppend（如 "Only modify files directly related"）
- [ ] 两部分通过 `\n\n` 连接

### AC-2.4: 模板不存在时降级

**测试**: 基座模板名不存在（如 baseTemplate="NonExistent"）

**预期**:
- [ ] 不抛出异常
- [ ] 返回空基座 + promptAppend
- [ ] 结果 = `"\n\n" + promptAppend`

### AC-2.5: 现有模板体系不受影响

**验证**:
- [ ] `template-store.ts` 的 12 个内置模板未被修改
- [ ] `persona.ts` 的 PERSONA_TEMPLATES 未被修改
- [ ] 用户创建 Agent 时仍可选择现有模板
- [ ] 工作流角色不出现在模板选择器中

---

## 3. 三层上下文注入

### AC-3.1: T1 — systemPrompt 固定

**验证**:
- [ ] Analyst AgentRecord 的 systemPrompt 包含 Researcher 基座内容
- [ ] Analyst AgentRecord 的 systemPrompt 包含 "Project Analyst" 追加内容
- [ ] 整个会话期间 systemPrompt 不变

### AC-3.2: T2 — PreLLMCall Hook 注入

**前置**: 注册 `workflow-context-hook.ts`

**验证 Hook 注册**:
- [ ] `registerWorkflowContextHook()` 可正常调用
- [ ] PreLLMCall Hook 在非工作流会话时跳过（agentRole 为空）

**Analyst 上下文注入**:
- [ ] injectProjectInfo=true → 项目名和路径出现在 prependContext
- [ ] injectWikiBaseline=true → Wiki 浅层基线出现在 prependContext
- [ ] injectGitDiff=true + 有 diff → diff 内容出现在 prependContext

**Lead 上下文注入**:
- [ ] injectRequirementDetail=true → 需求标题/描述出现在 prependContext
- [ ] injectStepsProgress=true → 步骤进度出现在 prependContext

**Sub-agent 上下文注入**:
- [ ] Developer/Reviewer/QA → 需求详情出现在 prependContext
- [ ] injectWikiBaseline=false → Wiki 基线不出现

### AC-3.3: T2 — 不存 DB

**验证**:
- [ ] PrependContext 内容不在 session turns 表中出现
- [ ] 下一 turn 时 T2 内容重新计算（如步骤进度变化后更新）

### AC-3.4: T3 — session messages 自然积累

**验证**:
- [ ] 工具调用结果（ExpandNode 返回的 Wiki 内容）出现在 session messages
- [ ] 这些消息存入 DB（turns 表）
- [ ] 上下文窗口裁剪正常工作

### AC-3.5: 不改动现有注入机制

**验证**:
- [ ] `buildContextMessage()` 函数签名不变
- [ ] `agent-loop.ts` 的 `executeStream()` 不变
- [ ] 现有的 memoryContext、ragContext、guidelines 注入正常
- [ ] 工作流 context 通过 `PreLLMCall Hook → memoryContext` 通道注入

---

## 4. ToolExecutionContext 扩展

### AC-4.1: 新增字段

**验证**:
- [ ] `ToolExecutionContext` 包含 `wikiStore?: ProjectWikiStore`
- [ ] `ToolExecutionContext` 包含 `requirementStore?: RequirementStore`
- [ ] `ToolExecutionContext` 包含 `projectId?: string`
- [ ] `ToolExecutionContext` 包含 `agentRole?: string`
- [ ] `SessionConfig` 包含 `agentRole?: string`
- [ ] `SessionConfig` 包含 `projectContext?: { projectId, projectName, projectPath, activeRequirementId? }`

### AC-4.2: TypeScript 编译

**预期**:
- [ ] 新增字段不破坏现有代码
- [ ] `buildToolsSet()` 调用仍能正常类型推断

---

## 5. Wiki 工具

### AC-5.1: ExpandNode — 正常展开

**前置**: 创建项目 P，创建 Wiki 节点（有 detail）

**预期**:
- [ ] 返回节点的 detail 内容

### AC-5.2: ExpandNode — 节点不存在

**预期**:
- [ ] 返回 "Wiki node not found: ..."
- [ ] 不抛出异常

### AC-5.3: UpdateWikiNode — 创建新节点

**前置**: 创建项目 P

**预期**:
- [ ] 返回 "Wiki node created: ..."
- [ ] `projectId` 自动填充
- [ ] `lastUpdatedBy` = agentRole 或 "analyst"

### AC-5.4: UpdateWikiNode — 更新已有节点（Upsert）

**预期**:
- [ ] 返回 "Wiki node updated: ..."
- [ ] 只更新传入的字段
- [ ] 不报路径冲突错误

### AC-5.5: 工具条件注册

**验证**:
- [ ] `CONDITIONAL_TOOLS.ExpandNode` = `(ctx) => !!ctx.wikiStore`
- [ ] 无 wikiStore 时工具不在可用列表

---

## 6. 需求工具

### AC-6.1: CreateRequirement — 正常创建

**预期**:
- [ ] 返回 "Requirement created: {id}"
- [ ] `status` = "found", `source` = "analyst"

### AC-6.2: 工具条件注册

**验证**:
- [ ] `CONDITIONAL_TOOLS.CreateRequirement` = `(ctx) => !!ctx.requirementStore`

---

## 7. Analyst 服务

### AC-7.1: ensureAnalystAgent — 首次创建

**前置**: 项目 P 无 analyst agent

**预期**:
- [ ] 创建新的 AgentRecord
- [ ] name = "Analyst-{projectName}"
- [ ] systemPrompt 包含 Researcher 基座 + analyst append
- [ ] metadata = { role: 'analyst', projectId }
- [ ] 返回 agentId

### AC-7.2: ensureAnalystAgent — 已存在则复用

**前置**: 项目 P 已有 analyst agent

**预期**:
- [ ] 返回已有 agent 的 ID
- [ ] 不创建新的 AgentRecord

### AC-7.3: 冷启动分析

**前置**: 准备真实项目目录，创建项目 P

**预期**:
- [ ] `project_wiki` 表有新节点（至少 src/ 目录节点）
- [ ] Wiki 节点的 `summary` 不为空
- [ ] `project.lastAnalysisAt` 已更新
- [ ] T1: systemPrompt 包含 Researcher 基座
- [ ] T2: prependContext 包含项目信息
- [ ] T3: 工具调用结果存入 session messages

### AC-7.4: 冷启动 — Wiki 骨架结构

**验证**:
- [ ] 存在 src/ 目录节点（nodeType=directory）
- [ ] 存在至少一个文件级节点（nodeType=file）
- [ ] 层级关系正确（parentId 指向正确）

### AC-7.5: 冷启动 — 幂等安全

**步骤**: 连续两次 runFullAnalysis

**预期**:
- [ ] 第二次不报错
- [ ] Wiki 节点 upsert 更新，不重复创建

### AC-7.6: 增量分析

**前置**: 已有冷启动结果，修改一个文件

**预期**:
- [ ] 受影响文件的 Wiki 节点被更新
- [ ] T2 注入了 git diff 和 Wiki baseline
- [ ] 如果发现新问题，有新需求创建

### AC-7.7: 项目创建触发冷启动

**步骤**: `POST /api/projects` 创建项目

**预期**:
- [ ] API 立即返回 201
- [ ] 冷启动异步执行，不阻塞响应
- [ ] 冷启动失败不影响项目创建

### AC-7.8: 手动触发巡检

**步骤**: `POST /api/projects/:id/trigger-analysis`

**已有 lastAnalysisAt**: 返回 202 + type: "incremental"
**无 lastAnalysisAt**: 返回 202 + type: "full"

---

## 8. 工具策略

### AC-8.1: Analyst 工具集

**验证**:
- [ ] 可用: Read, Write, Edit, Grep, Glob, Shell, ExpandNode, UpdateWikiNode, CreateRequirement
- [ ] 禁用: Orchestrate

### AC-8.2: Lead 工具集

**验证**:
- [ ] 可用: Read, Grep, Glob, Shell, ExpandNode, Orchestrate
- [ ] 禁用: Write, Edit

### AC-8.3: Developer 工具集

**验证**:
- [ ] 可用: Read, Write, Edit, Shell, Grep, Glob
- [ ] 禁用: Orchestrate, CreateRequirement, UpdateWikiNode, ExpandNode

### AC-8.4: Reviewer 工具集

**验证**:
- [ ] 可用: Read, Grep, Glob, Shell
- [ ] 禁用: Write, Edit, Orchestrate, CreateRequirement, UpdateWikiNode, ExpandNode

### AC-8.5: QA 工具集

**验证**:
- [ ] 可用: Read, Write, Shell, Grep, Glob
- [ ] 禁用: Edit, Orchestrate, CreateRequirement, UpdateWikiNode, ExpandNode

---

## 9. 持久化策略

### AC-9.1: Analyst — 自动创建 AgentRecord

**验证**:
- [ ] ensureAnalystAgent 创建了 AgentRecord
- [ ] AgentRecord 在 agent 列表中可见
- [ ] AgentRecord 的 metadata.role = "analyst"

### AC-9.2: Sub-agent — 无 AgentRecord

**验证**:
- [ ] Developer/Reviewer/QA 不创建 AgentRecord
- [ ] Orchestrate 创建的临时 AgentLoop 执行完即释放

---

## 10. 错误处理

| 场景 | 预期 |
|------|------|
| 项目路径不存在 | 不执行分析，记录日志 |
| 分析中 Agent 异常 | catch，不阻塞项目创建 |
| 并发分析同一项目 | 检测活跃 session，跳过 |
| 基座模板不存在 | 降级为只有 promptAppend |
| Wiki 工具缺少 projectId | 返回 "Error: Wiki context not available" |

---

## 11. Smoke Test 清单

- [ ] `npm run build:lib` 编译通过
- [ ] `npm run build` 全量构建通过
- [ ] 5 个角色配置都存在且 baseTemplate 指向现有模板
- [ ] `buildWorkflowSystemPrompt()` 返回基座 + 追加内容
- [ ] Workflow Context Hook 注册成功
- [ ] 创建项目 → 冷启动 → Wiki 有数据
- [ ] T1 systemPrompt 包含基座模板内容
- [ ] T2 prependContext 包含项目/Wiki/需求上下文
- [ ] T3 工具调用结果存入 session messages
- [ ] 不改 template-store.ts, persona.ts, context-message.ts, agent-loop.ts
- [ ] ensureAnalystAgent 自动创建 AgentRecord
- [ ] 手动触发巡检 → 增量分析执行
