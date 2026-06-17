# 工作流完整流程规范（v0.8 落地版）

> **文档定位**：这是 `agent-driven-workflow.md`（设计 RFC）的**执行规范**，补落地细节。
> 设计 RFC 回答「为什么这么设计」；本文档回答「真实代码里流程怎么走、每一步的触发点 / 数据流 / IPC 通道 / 存储变更 / prompt 契约是什么」。
> 全部落在已实现代码上（标注 `文件:行号`）。M0–M5 的里程碑级 plan/acceptance 已归档至 `docs/rfc/archive/`。

---

## 0. 为什么需要这份规范

M0–M5 实现期间踩了一类共性问题：**计划层只写了「要支持 X」，没写「X 的触发路径 / 存储变更 / 通道入口」**，导致实现时在这些点上反复猜错（典型：IPC handler 加进 dead path、DB schema 变更没处理已存在表、verify→archivist 触发点一度漏接）。

本规范的写法是：**每条流程都写死触发点→数据流→IPC 通道→存储变更→prompt 契约**，并在开头沉淀一组**全局架构契约**——这些契约是踩坑后的硬约束，违反即产生运行时 bug。

---

## 1. 全局架构契约（硬约束）

### 1.1 IPC 通道契约
- **真实路径**：renderer → preload `ipcRenderer.invoke(channel)` → main 进程 `src/main/ipc-proxy.ts` 的 `ROUTE_MAP` 代理 → 后端 Express REST。
- `registerProxyHandlers()` 遍历 `ROUTE_MAP` 注册 `ipcMain.handle`。
- **`src/main/ipc.ts` 的 `registerIpc` 是 dead path**——主入口 `src/main/index.ts` 从不调用它。里面的 `cron-handlers.ts / orchestrate-handlers.ts / pm-handlers.ts` 是历史误植（M1/M3/M4 早期 sub1 错把 handler 加进了它，导致刷屏 `No handler registered for crons:list`）。
- **硬约束**：新增任何 IPC 通道，必须加到 `src/main/ipc-proxy.ts` 的 `ROUTE_MAP`，格式 `"channel:name": { method, path, buildReq }`，`buildReq` 参数顺序必须对齐 preload 的 invoke 参数。**不要加到 ipc.ts**。
- **验收手段**：通道写完后，在 `out/main/index.cjs`（编译产物）里 grep 该 channel 名确认被注册；启动 dev 后日志不出现 `No handler registered for <channel>`。

### 1.2 DB schema 变更契约
- **`CREATE TABLE IF NOT EXISTS` 不迁移已存在表**——只对全新库生效。dev 库（`~/.zero-core/sessions.db`）已有旧 schema 时，DDL 改动**不会**生效，会触发运行时约束错误（典型：M2 把 `project_wiki.project_id` 改成可空，但旧库仍是 NOT NULL，`ensureGlobalRoot` 插入 NULL 直接崩）。
- **硬约束**：任何表结构变更（加列 / 改约束 / 改类型）必须：
  1. 在 `src/server/db-migration.ts` 写显式 migration 函数（参考 `migrateWikiTableSchema()`）；
  2. migration 要分支处理「空表（DROP+rebuild，无损）」与「非空表（ALTER 或告警留待人工）」；
  3. 在 `src/server/db-migration.ts` 顶部对应 store 的 `*_COLUMNS` 数组同步增删列（尤其 `AGENT_COLUMNS`），否则新装 fresh DB 会缺列。
- **验收手段**：拿一份**旧版本**的 sessions.db 启动，确认 migration 跑通且数据不丢；再拿空库启动确认新 schema 正确。

### 1.3 AgentLoop 契约
- **功能代码不内联进 AgentLoop**。所有「轮次前后」行为（身份注入、上下文 bundle、状态流转、记忆提取、通知）一律通过 hook 注册，放在 `src/runtime/hooks/` 下。
- hook 注册入口 `src/runtime/hooks/index.ts`，按固定顺序：turn → notification → memory → rag → providerOptions → compression → extraction。
- 状态流转 hook 在 `src/server/requirement-hooks.ts`（PostToolUse / PostTurnComplete）。**hook 逻辑必须幂等、异常不阻塞主流程**。

### 1.4 角色身份契约
- **身份在 agent（`roleTag`），上下文在 session（`SessionContextBundle`）**——两者分离。
- `AgentRecord` 当前**没有** `workflowRole / cronSchedule / subAgentChain` 字段；角色用 `roleTag`（`lead / pm / archivist / analyzer-* / planner-* / developer / reviewer / qa / zero`）区分。一条 cron 的归属由独立 `crons` 表（`agentId + workingScope`）表达，不在 AgentRecord 上。
- 角色**全局化**：一个全局 PM / lead / archivist agent，通过不同 session 上下文服务多个项目。路由键 = `(agentId, projectId)`。
- 唯一性约定：`roleTag="pm"` 的 agent 若有多个，取 `createdAt` 最早者（`PmService.findPmAgent()`）。

### 1.5 触发器契约（通知为主 + cron 兜底）
- 跨角色流转走 `ProjectNotificationRouter.notify(type, requirementId, projectId, payload?)`，类型包括 `ready`（→lead 领取）、`verify`（→PM 覆盖判断）、`verify_accept`（→archivist 合并）、`verify_reject`（→lead 补）。
- 通知是 **best-effort + 不抛出**；丢失由 cron 兜底重试。
- **硬约束**：`verify_accept` 通知必须在 `archiveRequirement()` **之前** fire——否则 archivist 看到的是已 archive 的需求，合并无对象（见 `requirement-hooks.ts:151-157` 顺序）。

---

## 2. 角色与会话模型

### 2.1 角色预设
全部在 `src/runtime/role-presets.ts`（`ROLE_PRESETS` 数组）。当前角色：

| roleTag | 职责 | 位置（role-presets.ts roleTag 行） |
|---|---|---|
| `lead` | 交付负责人，编排 Orchestrate 流程 | :213 |
| `pm` | 产品经理，发现需求 + 覆盖判断 | :228 |
| `archivist` | 知识管理，wiki 提取 + feature→main 合并 | :252 |
| `analyzer` ×4（ui/security/performance/architecture） | 分析工具角色 | :266 / :278 / :290 / :302 |
| `planner` ×4（feature/bugfix/refactor/research） | 规划工具角色 | :314 / :326 / :338 / :350 |
| `developer` / `reviewer` / `qa` | Orchestrate 流程内的执行角色 | :362 / :374 / :386 |
| `zero` | 全局管理（用户本体，负责实例化各角色） | :398 |

每个预设带 systemPrompt + toolPolicy（允许的工具 allowlist）+ 默认 workingScope。

### 2.2 AgentRecord
类型在 `src/shared/types.ts:30`。关键字段：`id, name, workspaceDir?, model?, provider?, systemPrompt?, toolPolicy?, roleTag?`。
**注意**：v0.8 设计 RFC 提到的 `workflowRole / cronSchedule / subAgentChain` 三个字段**当前未落到类型上**——`roleTag` 承担角色语义，cron 由独立表表达，子 agent 委托由 `subagent-delegation.ts` 的 `delegateTask`（继承 caller bundle）处理，不需要 AgentRecord 字段。

### 2.3 SessionContextBundle
```ts
interface SessionContextBundle {
  projectId?: string;
  workspaceDir: string;
  wikiRootNodeId: string;
}
```
`wikiRootNodeId` 决定该 session 在全局 wiki 树里的可见上界（`wiki-root:<projectId>` 项目子树根；`wiki-root:global` 全局根）。解析器在 `session-context-router.ts`：`defaultWikiRootResolver` / `GLOBAL_WIKI_ROOT_ID`。

### 2.4 会话路由原语
`resolveSessionByRoleProject(deps, agentId, projectId, options)`（`session-context-router.ts:98`）：
- 路由键 = `(agentId, projectId)`。
- find-or-create：存在则续接（不重置 context），不存在则 `buildProjectBundle` + 可选 override 建新 session。
- **被三处复用**：cron 触发（M1）、discuss 入口（M4）、跨角色通知（M3）。

---

## 3. 数据存储

### 3.1 Store 清单
| Store | 文件 | 表 |
|---|---|---|
| AgentStore | `src/server/agent-store.ts` | agents |
| SessionDB | `src/server/session-db.ts` | sessions / messages |
| CronStore | `src/server/cron-store.ts` | crons |
| WikiStore | `src/server/wiki-node-store.ts` | project_wiki（全局树） |
| RequirementStore | `src/server/requirement-store.ts` | requirements |
| TaskStepStore | `src/server/task-step-store.ts` | task_steps |
| OrchestratePlanStore / ManifestStore | `src/server/orchestrate-store.ts` | orchestrate_* |
| RequirementDocStore | `src/server/requirement-doc-store.ts` | （仓库内文件，非 DB 表） |

### 3.2 requirements 表（流程核心）
`src/server/db-migration.ts:390`。关键字段：
- `status` —— 状态机值（见 §5）
- `project_id` —— 项目归属
- `doc_path` —— 仓库内需求文档路径（M4）
- `created_by_agent_id` —— 创建该需求的 PM
- `assigned_agent_id` / `assigned_lead_session_id` —— 接手的 lead
- `reviewer_agent_id` —— **覆盖判断方**，默认 = 创建它的 PM（决策 34）；不是技术 accept

### 3.3 project_wiki 表 + 升级路径
`src/server/db-migration.ts:353`。M2 重构为全局单树：`project_id` 可空（全局根 / 全局 memory 节点）、`type`（header/intent/structure/project/memory）、`provenance`、`requirement_ids`、`relations`、`doc_pointer` 等。
**升级路径**由 `migrateWikiTableSchema(db)` 处理（`db-migration.ts`）：检测旧 schema 的 NOT NULL `project_id`，空表则 DROP+rebuild，非空表告警留待人工。

### 3.4 crons 表
字段：`id, agentId, enabled, schedule（off/hourly/daily/weekly 或毫秒）, prompt?, workingScope{projectId?, workspaceDir, wikiRootNodeId}`。一个 agent 可有多条 cron（各带不同 scope）。

---

## 4. 端到端流程

> 每个环节统一写：**触发点 → 数据流 → IPC 通道 → 存储变更 → prompt 契约**。

### 4.1 PM 发现（cron → 需求落库）

| 维度 | 内容 |
|---|---|
| 触发点 | `CronAnalysisManager` 的 `setInterval` 到点 → `triggerCron(cronId)`（`cron-analysis.ts:215`） |
| 数据流 | `triggerCron` → `resolveSessionForCron`（`cron-analysis.ts:245`）：带 projectId 走 `resolveSessionByRoleProject`，不带则走 agent 主 session → `agentService.sendPrompt(prompt, pmAgent, sessionId)` |
| IPC 通道 | 无（后端内部） |
| 存储变更 | 仅创建/复用 session；**需求落库由 PM agent 自主调用工具完成，不是 cron 直调** |
| prompt 契约 | cron 的 `prompt` 字段（或 `defaultPromptFor` 兜底）；**平台只负责 seed PM 的 systemPrompt + toolPolicy + cron prompt，调不调 analyzer、写什么文档由 PM 自己决定** |

**需求落库路径**：PM agent 在 session 内决定建需求 → 调用 `CreateRequirementWithDoc` 工具 → 路由到 `PmService.createRequirementWithDoc()`（`pm-service.ts:168`）：
1. 校验 project 存在；
2. **幂等**：同 project 同 title 已存在则 no-op 返回（重扫安全）；
3. `requirementStore.create({...status:"discuss", createdByAgentId, reviewerAgentId=createdByAgentId})`；
4. `requirementDocStore.buildNewRequirementDoc(projectId, req.id, body)` 写仓库内文档；
5. `requirementStore.update(req.id, {docPath})` 回填路径。
6. wiki 的 intent 节点由 archivist 兜底建（PM 不写 wiki 结构）。

> ⚠️ **M4 关键澄清**：发现完全 agent-driven，**没有** service 级 `discoverAndCreateRequirement`。早期 sub1 误写成 cron 代码直调 service，正确做法是「cron 只激活 session + 给工具」。

### 4.2 Discuss（看板 → chat）

| 维度 | 内容 |
|---|---|
| 触发点 | 用户在看板 discuss 栏点「跳转讨论」 |
| 数据流 | renderer → IPC `pm:openDiscuss` → ROUTE_MAP → `POST /api/pm/:projectId/discuss` → `PmService.openDiscussSession(projectId)` → `resolveSessionByRoleProject(pmAgent.id, projectId)` → 返回 `{agentId, sessionId, created}` → renderer `setActiveAgent` + 切 ChatPage + 打开需求文档 |
| IPC 通道 | `pm:openDiscuss`（`ipc-proxy.ts` ROUTE_MAP → `/api/pm/:projectId/discuss`） |
| 存储变更 | find-or-create `{PM, projectId}` session（与 cron 触发同一 session，决策 13/14） |
| prompt 契约 | 无；discuss 续接同一 session 的历史 |

**REST 端点**：`src/server/index.ts` 的 `pmRouter.post("/:projectId/discuss")`（返回 409 若无 PM agent）。

> ⚠️ **关键细节**：「跳转 discuss」= 打开 chat **且** 打开对应需求文档（`requirements:doc:read` 读 docPath）。M4 早期实现漏了打开文档，已修。

### 4.3 Plan（lead 领取 + Orchestrate confirm 门）

| 维度 | 内容 |
|---|---|
| 触发点 | 需求 `ready` → `ProjectNotificationRouter.notify("ready", ...)` → `LeadService.pickupRequirement()`（`lead-service.ts:120`）；lead 空闲时 `autoPickupIfIdle()`（`lead-service.ts:213`）自动领下一个 |
| 数据流 | lead 在 `{lead, projectId}` session 调用 `Orchestrate` 工具提交 DSL flow → plan 落 `orchestrate_plans` → **confirm 门停住**（`ConfirmRegistry` await，不占资源）→ 用户 IPC `orchestrate:confirm` → resolve → 执行 |
| IPC 通道 | `orchestrate:pending` / `orchestrate:plan` / `orchestrate:confirm` / `orchestrate:reject`（ROUTE_MAP → `/api/orchestrate/*`） |
| 存储变更 | `transitionStatus(req, "plan")`；OrchestratePlanStore 落计划；TaskStepStore 落步骤 |
| prompt 契约 | lead 的 systemPrompt（role-presets）；Orchestrate 工具的 DSL 契约 |

### 4.4 Develop（执行 + 步骤状态）

| 维度 | 内容 |
|---|---|
| 触发点 | confirm 通过后 Orchestrate 工具执行 flow，派发 developer/reviewer/qa 子 agent |
| 数据流 | PostToolUse hook 监听 lead 调 Orchestrate 工具 → 步骤数 > 0 时 `transitionStatus(req, "build")`（`requirement-hooks.ts:64-97`）+ `notifyPlanReviewRequired` |
| IPC 通道 | 各子 agent 的 agent-tool 通道（developer 写码 / reviewer 审 / qa 测） |
| 存储变更 | TaskStepStore 步骤状态推进（completed / failed / skipped） |
| prompt 契约 | 各子角色 systemPrompt |

### 4.5 Verify（build→verify + PM 覆盖判断）

| 维度 | 内容 |
|---|---|
| 触发点 | PostTurnComplete hook（`requirement-hooks.ts:100`）：lead session 一轮结束且所有步骤 completed → `transitionStatus(req, "verify")` |
| 数据流 | `notify("verify", req.id, projectId)` → PM session 做覆盖判断 → `buildCoverageView`（需求文档 + Orchestrate manifest）→ PM 调 `pm:coverageVerdict` → `submitCoverageVerdict`（`pm-service.ts:308`） |
| IPC 通道 | `pm:coverageView` → `GET /api/pm/:requirementId/coverage-view`；`pm:coverageVerdict` → `POST /api/pm/:requirementId/coverage-verdict` |
| 存储变更 | `reviewerAgentId` stamp；verdict 落 `status_change` message（审计） |
| prompt 契约 | PM 覆盖判断 = **产品粒度**（改动+测试是否覆盖原始意图）；**不做技术 accept**（技术验收在 Orchestrate flow 内） |

**自动路径（reviewer=analyst）**：若需求 `reviewer === "analyst"`，`requirement-hooks.ts:137` 直接 `analystService.verifyRequirement()`，PASSED 走 §4.6，FAILED 走 `notifyVerificationFailure`。

### 4.6 Archivist（verify_accept → 合并 + wiki 提取）

| 维度 | 内容 |
|---|---|
| 触发点 | `verify_accept`（PM 覆盖 OK，或 reviewer=analyst 自动 PASSED）→ `ProjectNotificationRouter` → archivist session |
| 数据流 | `requirement-hooks.ts:151` **先** `notify("verify_accept", ...)` → **再** `analystService.archiveRequirement(req.id)`（顺序见契约 1.5）；archivist 收到后 `mergeFeatureToMain()`（`archivist-service.ts:283`）+ wiki 增量扫描 `scanProject()` 提取记忆 |
| IPC 通道 | 无（后端内部通知）；archivist wiki 操作通过 archivist 工具 |
| 存储变更 | `transitionStatus(req, "archived")`；wiki 节点更新（last_updated_by='archivist'）；feature→main git 合并 |
| prompt 契约 | archivist systemPrompt；提取者 A/B（内容记忆 / 工具遥测，M5） |

> ⚠️ **M3 关键点**：verify→archivist 触发**已实现且顺序正确**（notify 在 archive 之前）。早期怀疑漏接是误判。

---

## 5. 需求状态机

```
found → discuss → ready → plan → build → verify → archived
                                        ↓
                                  (verify_reject / coverage-reject) → 回 build，lead 补
```

- `found`：DB 默认值（旧 analyst 发现路径）
- `discuss`：PM/用户新建需求初始状态（`createRequirementWithDoc` 设此值）；看板 discuss 栏
- `ready`：discuss 确认后，等待 lead 领取
- `plan`：lead 领取后，正在出 Orchestrate 计划
- `build`：PostToolUse hook 检测到步骤开始执行时转入
- `verify`：PostTurnComplete hook 检测到全部步骤 completed 时转入
- `archived`：verify_accept + archivist 合并后

流转实现集中在 `requirement-hooks.ts`（plan→build 在 PostToolUse，build→verify 在 PostTurnComplete）+ `requirement-store.transitionStatus()`。

---

## 6. 已知遗留 / 债务

1. **dead path 未清理**：`src/main/ipc.ts` 的 `registerIpc` + `src/main/ipc/{cron,orchestrate,pm}-handlers.ts` + `typed-ipc.ts` + core.ts 的 ctx 装配——这些是 IPC 真实路径切到 ROUTE_MAP 之前的历史误植，当前不被主入口调用。清理需确认无其他引用（项目级，非本规范范围）。
2. **CronAnalysisManager legacy aliases**：`restoreSchedulesForProjects / scheduleProject / unscheduleProject / rescheduleProject`（`cron-analysis.ts:184-201`，标 `@deprecated`），为 project-router 旧调用方保留的 no-op。
3. **AgentRecord 与设计 RFC 的字段差**：`workflowRole / cronSchedule / subAgentChain` 未落到类型——当前用 `roleTag` + 独立 cron 表 + `delegateTask` 覆盖了等价语义，但与 RFC 文字描述不一致，需在后续决定是否补字段或修 RFC 措辞。

---

## 附：契约速查（踩坑清单 → 对应约束）

| 踩过的坑 | 防再犯的契约 |
|---|---|
| IPC handler 加进 dead path 刷屏 | 1.1：通道必须进 `ipc-proxy.ts` ROUTE_MAP；验收 grep `out/main/index.cjs` |
| 旧 DB NOT NULL 约束崩溃 | 1.2：schema 变更写显式 migration + 同步 `*_COLUMNS`；验收用旧 DB 启动 |
| PM 发现做成 cron 直调 service | 4.1：cron 只激活 session，发现由 PM 用工具自主完成 |
| discuss 漏开需求文档 | 4.2：跳转 = 打开 chat **且** 打开需求文档 |
| 怀疑 verify→archivist 漏接 | 4.6 + 1.5：已实现，`verify_accept` 必须在 `archiveRequirement` 之前 |
