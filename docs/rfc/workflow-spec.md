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

### 1.4 身份契约（agent = name + prompt，无 roleTag）
- **agent 的身份 = name + systemPrompt，没有 roleTag 字段。** 「角色」是 template（prompt 库）的事，实例化出的 agent 不带角色标签。
- **身份在 agent，上下文在 session（`SessionContextBundle`）**——两者分离。
- agent **全局化**：一个 agent 通过不同 session 上下文服务多个项目。会话键 = `(agentId, projectId)`。
- **没有「唯一 PM/lead」约定**——平台不按角色找 agent。跨 agent 协作靠 **delegation + cron 激活 + 拉状态**（§1.5），不靠角色查找。

### 1.5 协作契约（拉模型，无中央路由 / 无 workflow 实体）
- **没有 workflow 实体，没有 ProjectNotificationRouter，没有事件路由推送。** 「工作流」是 agent 跑起来 + 合作后**涌现**的，不存任何编排/路由实体。
- **平台只维护数据状态**（requirement 状态机 plan→build→verify 等，§5），不做跨 agent 事件分发。
- 跨 agent 反应是**拉模型**：
  - agent 被**激活**（cron 触发 / 被委派 / 用户唤醒）时，用工具读当前状态 + 按 prompt 判断该干什么 + 委派 subagent。
  - 例：verify 通过后，**lead 自己**（prompt 指导）委派 archivist 去合并；PM 覆盖判断 = **PM 的 cron 激活后**看到 verify 状态的需求自己去判。
- zero 的唯一职责：**定义 agent 间的合作关系**（subagents 委派图 + cron 激活），不编排运行时。
- **「无角色路由」≠「不能直接交接」**：跨 agent 寻址一律用 **requirement 上记录的 agentId**（`createdByAgentId`=PM、`assigned_agent_id`=lead、`reviewer_agent_id`=覆盖判断方）—— requirement 是记录所有相关 agent ID 的枢纽。lead 提交 verify → 按 req 记录的 PM agentId 直接交给那个 PM，是沿**数据里记录的边**直接交接，不是角色广播、不是中央路由。
- 现状代码 `ProjectNotificationRouter` / `requirement-hooks.ts` 里的 `notify(...)` 推送路径**作废**，改成拉模型（§4.3/§4.5/§4.6 重写）。

---

## 2. 角色与会话模型

### 2.1 角色 Template（prompt 库，非运行时实体）
全部在 `src/runtime/role-templates.ts`（原 `role-presets.ts`，`ROLE_TEMPLATES` 数组）。Template 是**只读身份蓝图**（systemPrompt + base toolPolicy + 默认 workingScope），实例化出的 agent **不带 roleTag**。当前 template：

| template | 职责 | 位置（role-templates.ts 行） |
|---|---|---|
| `lead` | 交付负责人，编排 + 委派 | :213 |
| `pm` | 产品经理，发现需求 + 覆盖判断 | :228 |
| `archivist` | 知识管理，wiki 提取 + feature→main 合并 | :252 |
| `developer` / `reviewer` / `qa` | 交付流程内的执行角色（写码 / 审 / 测） | :362 / :374 / :386 |
| `zero` | 软件管家，定义 agent 间合作关系 | :398 |

> `analyzer` / `planner` 是**抽象概念**（分析、规划），不作为具体角色 template 落地，不写行为定义。需要分析/规划能力时,由具体角色（如 lead/archivist）在自己的 prompt + 工具里体现,或按需由 zero 临时配。

各角色的具体行为模式 + prompt 见 **§12**。

### 2.2 AgentRecord
类型在 `src/shared/types.ts:30`。关键字段：`id, name, workspaceDir?, model?, provider?, systemPrompt?, toolPolicy?, subagents?, wikiAnchors?`（详见 §11.9）。
**注意**：无 `roleTag` / `workflowRole` / `cronSchedule` / `subAgentChain` / `expose`——agent 身份就是 name+systemPrompt；委派靠 `subagents`，cron 靠独立 crons 表，wiki 锚点靠 `wikiAnchors`。

### 2.3 SessionContextBundle
```ts
interface SessionContextBundle {
  projectId?: string;
  workspaceDir: string;
  wikiRootNodeId: string;
}
```
`wikiRootNodeId` 决定该 session 的**项目锚点**（`wiki-root:<projectId>`；zero/全局用 `wiki-root:global`）。解析器在 `session-context-router.ts`：`defaultWikiRootResolver` / `GLOBAL_WIKI_ROOT_ID`。

### 2.4 会话路由原语
`resolveSessionByRoleProject(deps, agentId, projectId, options)`（`session-context-router.ts:98`）：
- 会话键 = `(agentId, projectId)`。
- find-or-create：存在则续接（不重置 context），不存在则 `buildProjectBundle` + 可选 override 建新 session。
- **被 cron 触发 + discuss 入口复用**（跨角色反应改走拉模型，不再用它做通知路由，§1.5）。

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

### 3.3 wiki_nodes 表 + 升级路径
`src/server/db-migration.ts:353`（原 project_wiki 演进）。v0.8 重构为全局单树 + 结构/内容分离（§10.1）：`project_id` 可空、`links`（无向链接，§10.1）、`doc_pointer` 等；`type`/`detail` 字段去除（位置即类型，正文去磁盘文件）。
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
| 数据流 | renderer → IPC `pm:openDiscuss` → ROUTE_MAP → `POST /api/pm/:requirementId/discuss` → 读 `req.createdByAgentId`（建该需求的 PM agent id）→ `resolveSessionByRoleProject(pmAgentId, projectId)` → 返回 `{agentId, sessionId, created}` → renderer `setActiveAgent` + 切 ChatPage + 打开需求文档 |
| IPC 通道 | `pm:openDiscuss`（`ipc-proxy.ts` ROUTE_MAP） |
| 寻址 | **按 `req.createdByAgentId` 定位 PM**（需求自己记录是哪个 PM 建的），不靠角色查找、不靠 `findPmAgent()` |
| 存储变更 | find-or-create `{PM, projectId}` session（与 cron 触发同一 session） |
| prompt 契约 | 无；discuss 续接同一 session 的历史 |

> ⚠️ **关键细节**：「跳转 discuss」= 打开 chat **且** 打开对应需求文档（`requirements:doc:read` 读 docPath）。M4 早期实现漏了打开文档，已修。

### 4.3 Plan（lead 领取 + Orchestrate confirm 门）

> **「门」= 阻塞工具**：confirm/verify 等「门」本质都是 lead 调一个工具后**等工具返回**——工具内部 await 判定方裁决（confirm 等用户、verify 等 PM），裁决到才 return，lead 轮次自然停住。**无独立 Gate 抽象、无 gates 表**；`ConfirmRegistry` 就是 confirm 工具的 await 实现。判定方是谁只决定工具 await 什么。

| 维度 | 内容 |
|---|---|
| 触发点 | **拉模型**：lead **完成上一任务后自动领下一个** ready 需求（primary，`autoPickupIfIdle`）；**cron 激活保底**（fallback，定期唤醒 lead 检查 ready 需求）。无事件推送。 |
| 数据流 | lead 在 `{lead, projectId}` session 调用 `Orchestrate` 工具提交 DSL flow → plan 落 `orchestrate_plans` → **confirm 门停住**（`ConfirmRegistry` await，不占资源）→ 用户 IPC `orchestrate:confirm` → resolve → 执行 |
| IPC 通道 | `orchestrate:pending` / `orchestrate:plan` / `orchestrate:confirm` / `orchestrate:reject`（ROUTE_MAP → `/api/orchestrate/*`） |
| 存储变更 | `transitionStatus(req, "plan")`；OrchestratePlanStore 落计划；TaskStepStore 落步骤 |
| prompt 契约 | lead 的 systemPrompt（§12）；Orchestrate 工具的 DSL 契约 |

### 4.4 Develop（执行 + 步骤状态）

| 维度 | 内容 |
|---|---|
| 触发点 | confirm 通过后 Orchestrate 工具执行 flow，**lead 委派** developer/reviewer/qa subagent |
| 数据流 | PostToolUse hook 监听 lead 调 Orchestrate 工具 → 步骤数 > 0 时 `transitionStatus(req, "build")`（`requirement-hooks.ts:64-97`） |
| 委派 | lead 通过 `subagents` 委派 developer 写码 / reviewer 审 / qa 测（§11.5） |
| 存储变更 | TaskStepStore 步骤状态推进（completed / failed / skipped） |
| prompt 契约 | 各角色 systemPrompt（§12） |

### 4.5 Verify（实现完成门 —— lead 提交，PM 判）

> verify 是**第二个门**（第一个是 plan 的 confirm 门，§4.3）。两个门都是 lead 提交后停下等。

| 维度 | 内容 |
|---|---|
| 触发点 | lead 完成实现 → **提交 verify**（verify 工具/action：写 verify payload「做了什么 + 证据」+ 置 status `verify-pending`）→ **lead 停下等待**（不继续）。无 hook 自动推进，是 lead 显式提交。 |
| 判定方 | **verify 工具调 PM**：lead 调 verify 工具 → 工具按 `req.createdByAgentId`/`reviewer_agent_id`（记录的 agentId）**直接调那个 PM** 去做覆盖判断（产品粒度：改动+测试是否覆盖原始意图）→ 拿到 verdict **通过** 或 **不通过 + 修改意见** → 工具 return 给 lead。工具是桥,lead 阻塞等工具(=等 PM 判),实时、无 cron 延迟。**PM cron 只管 discovery（巡检）,不管 verify 感知。** |
| 通过 | PM 触发 archivist 合并（§4.6）→ archived。 |
| 不通过 | lead（被重新激活）收到修改意见 → **改计划再执行** → 重新提交 verify（循环到通过）。 |
| IPC 通道 | `pm:coverageView` → `GET /api/pm/:requirementId/coverage-view`；`pm:coverageVerdict` → `POST /api/pm/:requirementId/coverage-verdict` |
| 存储变更 | verify payload；`reviewer_agent_id` stamp；verdict（pass / fail+意见）落 `status_change` message（审计） |
| prompt 契约 | PM 覆盖判断 = **产品粒度**；不做技术 accept（技术验收在 Orchestrate flow 内） |

> verify 是个**项目交付域工具**（lead 提交、PM 接收）。具体工具打包（独立工具 / Project 工具的 action / 工作流工具）待 Q1。

### 4.6 Archivist（合并 + wiki 提取，PM 委派/通知）

| 维度 | 内容 |
|---|---|
| 触发点 | **verify（覆盖判断）是 PM 的职责**（§4.5）。PM 覆盖判断 OK 后，**委派 archivist**（archivist 是 PM 的 subagent，由 zero 配）去合并；archivist 也可能被自己的 cron 激活后看到待合并状态自行处理。**lead 不碰 archivist**。无 `verify_accept` 事件推送。 |
| 注 | 目前用 **subagent 委派（同步）**。将来若有「异步、无反馈」的交接需求（PM 不等合并完成），再加**同级通知**机制（按 agentId 点对点，非角色路由）—— 非必须，暂不做。 |
| 数据流 | archivist 收到 PM 委派/激活 → `mergeFeatureToMain()`（`archivist-service.ts:283`，main 由 archivist 管）+ wiki 增量扫描 `scanProject()` 提取记忆 → 置 `archived` |
| IPC 通道 | 无（agent 内部委派）；archivist wiki 操作通过 Wiki 工具 |
| 存储变更 | `transitionStatus(req, "archived")`；wiki 节点更新；feature→main git 合并 |
| prompt 契约 | archivist systemPrompt（§12）；提取者 A/B（内容记忆 / 工具遥测，M5） |

> ⚠️ 现状 `requirement-hooks.ts:151` 的 `notify("verify_accept")` 推送路径作废（§1.5），改成 PM 委派/通知 archivist 的拉模型。这是 v0.8 重构项。

---

## 5. 需求状态机

```
found → discuss → ready → plan → build → verify → archived
                                        ↑            ↓
                                        └─ (PM 判不通过+意见) lead 改计划再执行
```
两个门：plan 的 **confirm 门**（用户确认，§4.3）、实现完成的 **verify 门**（PM 判，§4.5）。

- `found`：DB 默认值（旧路径）
- `discuss`：PM/用户新建需求初始状态；看板 discuss 栏
- `ready`：discuss 确认后，等待 lead 领取
- `plan`：lead 领取后出 Orchestrate 计划 → confirm 门（用户）→ 确认后 build
- `build`：执行中（lead 委派 developer/reviewer/qa）
- `verify`：lead 完成实现、提交 verify 后停下等 → PM 判 → 通过则 archived，不通过回 plan（带修改意见）
- `archived`：PM 覆盖判断 OK + PM 委派 archivist 合并后

**状态流转是平台数据**（requirement-hooks + transitionStatus），**对状态的「反应」是 agent 拉模型行为**（激活时读状态 + 委派，§1.5）。

---

## 6. 已知遗留 / 债务

1. **dead path 未清理**：`src/main/ipc.ts` 的 `registerIpc` + `src/main/ipc/{cron,orchestrate,pm}-handlers.ts` + `typed-ipc.ts` + core.ts 的 ctx 装配——这些是 IPC 真实路径切到 ROUTE_MAP 之前的历史误植，当前不被主入口调用。清理需确认无其他引用（项目级，非本规范范围）。
2. **CronAnalysisManager legacy aliases**：`restoreSchedulesForProjects / scheduleProject / unscheduleProject / rescheduleProject`（`cron-analysis.ts:184-201`，标 `@deprecated`），为 project-router 旧调用方保留的 no-op。
3. **AgentRecord 去 roleTag**（v0.8 定稿）：`roleTag` 字段移除，agent 身份 = name + systemPrompt（§1.4）；跨 agent 协作改拉模型（§1.5），删 `ProjectNotificationRouter`。现状代码 roleTag / router / `notify(...)` 路径待重构。
4. **工具集待重构（见 §7）**：现有 `InstantiatePreset`、扁平的 17+ 个 zero-admin 工具、`toolPolicy` 单独成工具、expose 作为独立实体、role-`presets` 术语，均与 §7 定稿设计冲突。**代码暂未改，待 §7 确认后统一动**。

---

## 7. 初始化与引导（fresh-DB → 工作流就绪）

> 本节是工作流的**冷启动引导规范**：从空库开始，如何让用户得到一个能跑的软件开发工作流。
> 设计原则：**工具是按功能域分的原子 CRUD；工作流怎么组装，是写在 wiki 里的预设知识（playbook），由 zero 读后用原子工具搭建。**

### 7.1 空库初始态（fresh-DB seed）

真正的 fresh DB **默认只写入两样东西**（无 seed 则连 zero 都没有，自动路径进不去）：

1. **一个 `zero` agent**（从 `zero` template 实例化）—— 全局管理角色，用户与它对话搭建工作流。**workspaceDir = 平台全局 `~/.zero-core`**（不绑单个项目，观察所有项目）。
2. **wiki 树里的 `software-dev` 节点**（路径 `wiki-root:global / agent-group / software-dev`）—— 这个节点**包含 software-dev 工作流的全部配置**（需要哪些角色、谁 expose 给谁、谁配 cron）。zero 读它来学习怎么搭这套工作流。

seed 触发点：`startServer` 内、所有 store 建好后、`restoreAllSessions` 之前，检查 `agentStore.list().length === 0` → seed。业务语义，放服务层不放 migration 层。

> **这两个默认写入不可删除**（protected）—— `Agent(delete: zero)` 和 `Wiki(delete: software-dev)` 必须 reject。其余角色 agent（pm/lead/archivist/...）永不 seed，永远留在 template 表里，按需实例化。

### 7.2 术语统一：Template（废弃 Preset）

全仓统一用 **Template**：`role-presets.ts` → `role-templates.ts`，`ROLE_PRESETS` → `ROLE_TEMPLATES`，`getPreset`/`listPresets` → `getTemplate`/`listTemplates`，`instantiatePreset` → 废弃（由 `Agent create + template 字段` 替代）。Template 是**只读身份蓝图**（systemPrompt + base toolPolicy + 默认 workingScope），不是运行时实体。template 不定义 subagents/委派——那是 zero 在实例化时按合作关系配的（§1.5）。

### 7.3 工具分类：4 个 action 化工具

zero 的工具按功能域压缩为 **4 个**，每个靠 `action` 字段路由输入（判别联合 schema）。

> **工具是硬编码的**：4 个域工具 + 平台工具（Shell/Read/Grep/Glob/Write/Edit/委派）的**定义都在代码里，不入库**。
> 但**工具的默认参数配置、使用记录需要 DB 表**：每个工具的默认 config、每次调用的 usage 记录都持久化（审计 + 复用配置）。
> 「agent as tool」**不再是工具** —— 见 §7.4，改用 caller 侧 `subagents` 列表。

#### `Project`（纯元数据）
| action | 字段 | 说明 |
|---|---|---|
| create | name, workspaceDir | 建项目，绑定归一化 workspaceDir |
| update | id, name? | workspaceDir 创建后不可变 |
| delete / get / list | id / id / — | — |

> **Project 只管元数据**。看板/需求/任务流转是工作流运行时的事（PM 建需求、hooks 推状态），**不属于 Project 工具**。现有 project-router 上挂的 kanban 端点是历史代码债，概念上不归 Project 域。

#### `Agent`（agent 记录 CRUD + template 参考）
| action | 字段 | 说明 |
|---|---|---|
| create | name, template?, systemPrompt?, toolPolicy?, subagents?, wikiAnchors? | 给 `template` → 从模板拷身份；不给 → 裸建 |
| update | id, <任意字段 incl. toolPolicy / subagents / wikiAnchors> | 改身份/工具/委派/锚点全走这里 |
| delete | id | 级联清关联 cron；**zero agent 不可删**（protected） |
| get / list | id / (无过滤) | list 返回全部 agent |
| listTemplates / getTemplate | — / id | **只读**，zero 读 template 拿角色身份作参考（§2.1） |

AgentRecord 带 `subagents` 字段（caller 侧声明可委派的 agent 列表，见 §7.4）：
```ts
subagents?: Array<{
  agentId: string;        // 被委派的目标 agent（稳定 id）
  name?: string;          // caller 看到的别名，默认从目标 agent.name 派生
  description?: string;   // 告诉 caller 这个 subagent 能干什么
}>
```

#### `Cron`（定时器实体）
| action | 字段 | 说明 |
|---|---|---|
| create | agentId, workingScope{projectId?, workspaceDir, wikiRootNodeId}, schedule, prompt?, enabled? | 一个 agent 可挂 N 条 cron |
| update / delete / get / list | — | — |

#### `Wiki`（全局记忆树读写，按角色写域）
| action | 字段 | 写权 scope |
|---|---|---|
| list / expand / readDoc | nodeId / nodeId / path | 读：按 session viewRoot 截断（项目角色只看本子树，全局角色看全树） |
| upsert | nodeId, type, title, summary?, detail?, ... | 写：**archivist→项目子树**；**zero→全局 knowledge 子树** |

> 写域按锚点分配（§10.3 多锚点模型）：archivist 写项目子树，zero 写全局 knowledge 子树。store 层 scope guard 按 caller 的锚点并集放行。将来把 knowledge 子树交给 HR 时，调 HR agent 的自由锚点即可，无需角色判断。

### 7.4 委派关系 = caller 的 subagents 列表（拆掉 "agent as tool"）

把原先「expose agent 成工具 → caller 在 toolPolicy 里启用」的概念**整个拆掉**，避免和硬编码平台工具（Project/Agent/Cron/Wiki/Shell/...）混淆：

- **没有 `expose` 字段，没有 agent-tool-entries 表**。agent 不是工具。
- 委派关系**完全在 caller 侧声明**：caller 的 AgentRecord 带 `subagents: [{agentId, name?, description?}]`。
- caller 的 agent-loop 建工具时，为 `subagents` 列表每一项生成一个**委派入口**（直接调用对应 agent）——这些入口**不出现在全局工具 UI，只出现在该 caller 的工具配置列表**。
- 源 agent **无需任何配置**（不 opt-in）——谁能委派给谁，完全由 caller 的 `subagents` 列表决定。

调用机制复用现有 `delegateTask`（继承 caller bundle，不走 `resolveSessionByRoleProject`）。

**所以工作流组装是**：zero 读 software-dev 节点 → 知道「lead 要能委派 developer/reviewer/qa」→ `Agent(create lead, subagents:[{agentId:developer,...},...])` 在 lead 上声明。一步搞定，没有复合工具，没有 expose 注册表。

> 一句话区别：**「工具」是平台硬编码的能力；「subagent」是 caller 声明的可委派 agent 列表**。两者不混在一个 tool registry 里。

### 7.5 全局 wiki 的 agent-group 子树

全局 wiki 树结构（工作流配置的归宿）：

```
wiki-root:global              ← 全局根（zero 全局视角）
└── agent-group               ← 工作流配置子树根
    └── software-dev          ← software-dev 工作流的全部配置（fresh-DB seed）
    └── <future>              ← 后续更多工作流（软件继续预置，或 agent 写入）
```

- **`software-dev` 节点**包含该工作流的**全部配置**：需要哪些角色、谁 expose 给谁、谁配 cron、各角色的协作关系。zero 读它来搭工作流。
- **写权**：`agent-group` 子树由 **zero** 管理（store 层 scope guard 按 caller role 放行）。
- **将来**：knowledge/agent-group 子树写权可从 zero 收回、交给 HR 角色。
- ⚠️ fresh-DB seed `software-dev` 节点时，store 层写域需对 seed 路径放行（seed 是启动期特权写入，不走运行时角色 scope guard）。运行时只有 zero（及其后继角色）能写该子树。

### 7.6 两条引导路径

| 路径 | 流程 | 优点 | 缺点 |
|---|---|---|---|
| **手动** | 用户在 UI 一个个建：建 Project → 从 template 建 agent → expose → 配 caller toolPolicy → 配 cron | 自由度高 | 麻烦 |
| **自动** | 用户跟 zero 对话给项目目录 → zero 读 playbook + 读相关 template → 链式调 4 工具搭全套 → 用户之后可改 | 快 | 依赖 zero 推理正确（靠 playbook + template 知识兜底） |

两条路径**用同一套原子工具**（手动走 UI IPC → 同样的 create/update；自动走 zero 工具调用）。没有「一键 bootstrap」复合工具——组装是预设知识，不是一次性动作。

### 7.7 落地待办（代码暂未改，确认后统一动）
1. 全仓 `Preset` → `Template` 改名（role-presets.ts、zero-admin-*、preset-router、文档）。
2. 删 `InstantiatePreset` 工具；**拆掉 expose 概念**，AgentRecord 加 `subagents: [{agentId, name?, description?}]` 字段（caller 侧）。
3. **agent 不是工具**：废 `agent-tool-entries` 表 / `AgentToolStore` / `ExposeAgentAsTool`；caller agent-loop 改为按 `subagents` 列表生成委派入口（复用 `delegateTask`）。
4. 工具默认参数配置 + 使用记录入库（**新表**：`tool_configs` 默认 config、`tool_usage` 调用记录）；工具定义本身仍硬编码。
5. 17+ 扁平工具 → 4 个 action 化工具（Project / Agent / Cron / Wiki，判别联合 schema）。
6. `toolPolicy` 不再单独成工具（并入 `Agent update`）。
7. store 层 wiki 写域 scope guard：按 caller role 放行（zero → 全局 `agent-group` 子树；archivist → 项目子树）。
8. fresh-DB seed：zero agent（workspaceDir=`~/.zero-core`）+ `software-dev` 节点；两者**不可删**（protected，delete reject）。
9. zero toolPolicy 加 wiki 读工具（ListWikiTree / ExpandNode / ReadDoc）。

---

## 8. Project 模块（容器视图 + 项目页）

> Project 是工作流的**容器**。一个 workspaceDir 绑定 = 一个 project。
> **Project 不拥有 agent**（agent 是全局角色，见 §2.4 / §7）——它拥有：requirements + wiki 项目子树 + 指向它的 crons + 活跃 sessions。

### 8.1 元数据（极简）
`{id, name, workspaceDir}`。**不加状态 / 成员 / 配置**——model/provider 是 agent 配置（§7），项目级默认配置 YAGNI，以后真需要再加。

### 8.2 Project 工具（§7.3 四工具之一，action 化）
| action | 字段 | 说明 |
|---|---|---|
| create | name, workspaceDir | 建项目；**同步 `ensureProjectSubtree`（空根）+ 异步 kick 渐进扫描**（§8.3） |
| update | id, name? | workspaceDir 创建后不可变 |
| delete | id | 级联：requirements + task_steps + wiki 子树 + **该 projectId 的 crons**（当前漏删 crons，待补） |
| get | id, includeContext? | 不带 context → 纯元数据；带 → 容器视图（§8.4） |
| list | — | 全部项目（左侧列表用） |

> 当前缺 `GetProject` 工具（service 有 `getProject`，没暴露）——并入 `Project(get)`。

### 8.3 wiki 初始化与持续同步（大项目处理）
**初始化**：create 时 `WikiStore.ensureProjectSubtree(projectId)` 立即建空根（`wiki-root:<projectId>`），project 即刻可用。新项目（空 workspace）到此为止，无需扫描。

**渐进扫描**（解决已存在大项目「扫描很慢」）：
- archivist **后台分块渐进扫描**：先浅扫建结构节点（structure），再逐步补 detail 节点。
- 用已有的 `wiki_scan_cursors` 表（`db-migration.ts:378`）记录游标，**断点续扫、可中断恢复**。
- **不阻塞 create**：大项目从 t=0 即可用，wiki 在后台逐步填满；项目仪表盘显示扫描进度。

**持续同步**：**archivist 管理项目 git main 分支**——main 的更新都经 archivist 的 `mergeFeatureToMain()`（`archivist-service.ts:283`）发生，archivist 自己就是更新信号源。**merge 完成后立即触发增量 diff-scan**（只扫本次 merge 涉及的文件），无需轮询或文件监听。

> `POST /api/projects/:id/trigger-analysis`（现 [project-router.ts:133](src/server/project-router.ts#L133)）从 project-router **删除**——扫描是 archivist 内部行为（create 触发 + merge 后触发），不是 project 域端点。手动重扫可选挂在 Wiki 工具的 scan action 或项目页按钮。

### 8.4 容器视图（`Project(get, includeContext)`）
```
{
  project,
  requirementsByStatus: { found, discuss, ready, plan, build, verify, archived },
  crons:        [project-scoped crons],
  wikiSummary:  { nodeCount, lastUpdated, scanProgress },
  activeSessions: [{ agentId, name, sessionId }]
}
```
注意：**不含 agent 列表**（agent 全局，不归 project；activeSessions 是「当前为该 project 活跃的 session」，按 context.projectId 过滤）。

### 8.5 项目页（替换看板页）—— UI 规范
原看板页 → **项目页**。

- **左栏**：项目列表（可选 + 「新建项目」按钮，填 name + workspaceDir）。
- **右栏**：选中项目的信息，三 tab：
  1. **仪表盘 + 动态**：
     - **仪表盘**（项目的更新情况 + 资源消耗）：
       - 更新情况：wiki 扫描进度（phase + cursor）、git main HEAD、最近 merge/sync 时间、扫描是否最新（lag）。
       - 资源消耗：token 用量 / cost，**按 project 聚合**——`sessions` 表已累计每个 session 的 `input_tokens / output_tokens / total_tokens / cache_read/write_tokens / reasoning_tokens / estimated_cost_usd`（`db-migration.ts:304-310`），SUM 这些字段 WHERE `session.context.projectId === 项目` 即得。逐轮明细在 `turns` 表（`:321-323`）。无需新表，与 `tool_usage`（工具调用日志，§7.7#4）是两回事。
     - **动态**（最近事件时间线）：需求状态流转 / cron 触发 / archivist merge / wiki 更新等。
       - 来源：`requirement_status_history`（`db-migration.ts:402`）+ `requirement_messages`（:421）+ cron/tool usage 记录，**派生聚合**，不单独建 activity 表。
  2. **项目视图**：容器视图全貌（requirements / crons / wiki 子树 / sessions 列表），即 §8.4 的可视化。
  3. **看板**：现有 kanban（按 status 的 requirement 列），现作为 tab 内嵌（不再独立成页）。
- 用户可在项目页**手动创建新项目**。

### 8.6 死代码清理（与 v0.8 矛盾）
- 删 `projects:pause / resume / updateInterval` IPC + [project-handlers.ts:51-72](src/main/ipc/project-handlers.ts#L51) 对应 + REST（cron 调度归 Cron 域；这些调的是 v0.8 no-op legacy alias `cron-analysis.ts:184-201`）。
- 删 `POST /api/projects/:id/trigger-analysis`（扫描归 archivist）。
- 级联删除补「删该 projectId 的 crons」。
- 补 `Project(get)` 工具。

### 8.7 落地待办（代码暂未改，确认后统一动）
1. `Project` 工具 action 化（create/update/delete/get/list），`get` 支持 `includeContext`。
2. create 副作用：同步 `ensureProjectSubtree` + 异步 kick 渐进扫描。
3. archivist 渐进扫描 + `wiki_scan_cursors` 断点续扫 + 仪表盘进度上报。
4. archivist merge-feature-to-main 后触发增量 diff-scan（main 由 archivist 管理）。
5. 容器视图聚合 API（requirementsByStatus + crons + wikiSummary + activeSessions）。
6. 项目页（替换看板页）：左列表 + 右三 tab（仪表盘+动态 / 项目视图 / 看板）+ 新建项目。
7. activity 派生聚合（status_history + messages + cron usage）。
8. 死代码清理（§8.6 四项）。

---

## 9. Cron 模块（一等公民定时器 + 调度台）

> Cron 是一等公民：一条 cron = 「在某个时间，激活某 agent 的某 scope session 并发 prompt」。激活后做什么完全由 agent 自己决定（§4.1）。Cron 有独立顶级页，不埋在 settings 里。

### 9.1 调度模型（参考闹钟 app）
抛弃当前 `parseSchedule` 的 setInterval-only 命名档（off/hourly/daily/weekly）。改成**闹钟风格的三模式**：

```ts
type CronSchedule =
  | { mode: "once";     fireAt: string }        // 单次：ISO 带时区；到点触发后自动 disable
  | { mode: "alarm";    time: "HH:MM"; days: number[]; tz: string }
                                                    // 闹钟：每天选定的 days（0-6 周日-周六）的 time 触发
                                                    //   days=[] → 每天；[1,2,3,4,5] → 工作日；[0,6] → 周末
  | { mode: "interval"; everyMs: number };      // 间隔：每 N 毫秒（最小 60000）
```

- **once**：单次日期时间，触发后 `enabled=false`（留审计，不删）。
- **alarm**：闹钟 —— 时间 + 重复星期（闘钟 app 的「重复：每天/工作日/周末/自选」）。锚定**钟点**（「什么时间点」）。覆盖原 daily/weekly。
- **interval**：固定节奏 —— 每 N **分钟/小时**（UI 用「每 N 分钟」「每 N 小时」选择器，不暴露裸 ms；底层存 everyMs，最小 60000）。锚定**节奏**（「多久一次」），适合 PM 巡检这类高频。覆盖原 hourly。
- 三模式覆盖：once=不重复、alarm=按钟点重复（日级）、interval=按节奏重复（分/时级）。
- 原 `off` → 不再是 schedule 值，改用 `enabled=false` 表达（行保留，定时器摘除）。

时区：once 的 `fireAt` 存 ISO 带偏移；alarm 存 `tz`（IANA，如 `Asia/Shanghai`）；UI 统一用本地时区显示。

### 9.2 调度器（CronManager 重写）
按 mode 分别调度（替代现 `parseSchedule` + setInterval）：
- **once** → `setTimeout` 到 `fireAt`；触发后置 `enabled=false` + 摘定时器。
- **alarm** → 计算下一次满足 (time, days) 的时刻 → `setTimeout`；触发后重算下一次（滚动）。
- **interval** → `setInterval(everyMs)`（min 60000）。

启动恢复（`restoreSchedules`）：
- 遍历 `enabled=true` 的 cron，按 mode 重建定时器。
- **错过的 once 不补跑**（Q3）：启动时若 `fireAt` 已过 → 直接置 `enabled=false` + 记一条 missed 的 `cron_runs`，不触发。
- alarm/interval：只算「下一次未来时刻」，不追溯历史。

单次触发错误不取消调度（catch + log + 落 `cron_runs` 失败记录）。

### 9.3 数据
**crons 表扩展**（现 [db-migration.ts:431](src/server/db-migration.ts#L431)）：`schedule` 改存结构化 JSON；新增列：
- `trigger_mode`（once/alarm/interval，冗余便于查询）
- `last_run_at` / `last_status`（ok/failed/missed）/ `last_error`
- `next_run_at`（调度器算好后回写，UI 直接读，不用前端算）

**新表 `cron_runs`**（运行历史，Q4）：
```
id, cron_id, fired_at, agent_id, session_id,
success(0/1), error, duration_ms, tokens, cost
```
每次触发落一条；cron 页历史 + 项目页「动态」都读它。

> ⚠️ schema 变更走显式 migration（契约 1.2）：旧 `schedule` 字符串行（off/hourly/daily/weekly）→ 映射到新 mode（hourly→interval 3600000；daily→alarm time+[]; weekly→alarm+[当日]；off→enabled=false）。

### 9.4 Cron 工具（§7.3 四工具之一，action 化）
| action | 字段 | 说明 |
|---|---|---|
| create | agentId, workingScope, schedule(三模式), prompt?, enabled? | 建定时器 |
| update | id, <任意字段> | 改 schedule / prompt / enabled 全走这里；改后 CronManager.refreshCron 重算 next_run |
| delete | id | 摘定时器 + 删行 |
| get / list | id / filter{projectId?, agentId?, enabled?} | list 可按 project/agent/启用过滤 |
| trigger | id | 「立即运行」（调试/手动，不计入 next_run） |

### 9.5 Cron 页 —— 「调度台」（顶级页）
创意设计：**闹钟感 + 时间轴可视化**。

- **顶部：今日时间轴** —— 一条 24h 横条，把今天会触发的 cron 按时刻标成竖线刻度（颜色按 agent 区分），当前时刻有游标。一眼看「今天什么时候有事」。点刻度跳到对应卡片。
- **主体：闹钟卡片网格**（像手机闹钟）。每张卡 = 一个 cron：
  - 大字**下次触发时间** + 重复标签（「工作日 09:00」「单次 06-20 14:00」「每 2h」）
  - **启用 toggle**（拨一下即开/关）
  - **状态点**：上次成功绿 / 失败红 / 错过灰
  - **倒计时**：「下次还剩 2h 13m」
  - **「立即运行」** 按钮
  - 展开看最近 `cron_runs` 迷你列表（时间 / 成功否 / 耗时）
- **分组切换**：按 agent（PM 的闹钟 / archivist 的闹钟）或按 project 两种视图切换。
- **新建**：右上「+」，像设闹钟 —— 选模式（单次/闹钟/间隔）→ 选 agent + workingScope（project 或全局）→ 设时间/重复 → 写 prompt。
- 状态点 + 倒计时让每张卡「活着」，最临近触发的那张高亮（pulse）。

### 9.6 落地待办（代码暂未改，确认后统一动）
1. `CronSchedule` 类型改三模式（once/alarm/interval）；废 `parseSchedule` 命名档。
2. CronManager 重写：按 mode 调度（setTimeout/interval/compute-next）；启动恢复 + missed-once 不补跑。
3. crons 表扩展列（trigger_mode/last_run_at/last_status/last_error/next_run_at）+ migration 映射旧 schedule。
4. 新建 `cron_runs` 表 + 每次触发落记录。
5. Cron 页（调度台）从 settings 提到顶级：今日时间轴 + 闹钟卡片网格 + 分组切换 + 新建闹钟式表单。
6. Cron 工具 action 化（create/update/delete/get/list/trigger），list 支持 projectId/agentId/enabled 过滤。
7. 删 project 域的 dead 调度通道（§8.6 已列 pause/resume/updateInterval）—— cron 调度只归 Cron 域。

---

## 10. Wiki 模块（结构/内容分离 + 锚点权限 + 引用文档为叶）

> wiki 是项目与全局知识的结构化记忆。本模块是 v0.8 最大重构：**树结构存 DB，节点文档存磁盘文件；权限按锚点节点定位；项目子树以「引用文档」为叶**。

### 10.1 存储：结构 / 内容分离
- **树结构 → DB**（`wiki_nodes` 表）：`id, parentId, path, title, summary, docPointer, links, flags, createdAt, updatedAt`。
  - **不存正文**（DB 里改正文不方便更新）。
  - `summary`（一行：「这节点和它的子节点是什么」）留 DB，供 context 注入 + 树渲染。
  - `docPointer` = 指向**节点自己的正文文件**（`~/.zero-core/wiki/<路径>.md`），代码内部用来定位正文；**agent 不感知**这个字段的存在。
  - `links`（无向链接 nodeId 数组，含需求追溯，邻接模型）、`flags`（分歧/状态标记）留 DB——关系型/可查询。
  - provenance / lastUpdatedBy 等描述性/审计信息 → 正文文件 frontmatter，不进 DB。
- **节点正文 → 磁盘文件** `~/.zero-core/wiki/<树路径>.md`。改正文 = 改文件，不动 DB。
- **项目文件本身不进 wiki**：既不在 DB，也不在 `~/.zero-core/wiki/` 下；它就在项目 `workspaceDir` 里。archivist / agent 读项目代码 = 用普通 FS 工具读 `workspaceDir`；wiki 不掺和。
- **强制 wiki 正文只走 wiki 工具读写**：代码层禁止 agent 用 FS 工具（Read/Shell/Grep...）直接访问 `~/.zero-core/wiki/`（路径不向 agent 暴露、不授权）。agent 只通过 wiki 工具读写正文；工具内部怎么定向到正文文件，是代码的事，agent 不用知道。

### 10.2 项目 wiki 子树 —— 注释文档为叶
- 项目子树叶节点正文 = archivist 对项目代码的**注释/理解**（存在 `~/.zero-core/wiki/projects/<projectId>/<路径>.md`）；正文里**链接到**对应项目文件（在 `workspaceDir`）。
- 项目文件本身不在 wiki（见 10.1）。archivist 读项目代码 = FS 读 workspaceDir；写理解 = wiki 工具 upsert。两套权限天然分离。
- 非叶节点（目录/模块）= 结构性，其正文描述该模块。

### 10.3 权限模型 —— 多锚点（自动 + 自由，废 type-based 守卫）
- 抛弃 `assertNodeInsideProjectScope` + type 枚举写域守卫（decision 39）。
- 一个 session 有**多个 wiki 锚点**，分两类：
  - **① 自动锚点**（运行时按角色/项目派生，不手配）：
    - **memory 锚点** = `memory/<agentId>/`（由 agent 派生；每个 agent 自己的记忆子树）。
    - **project 锚点** = `wiki-root:<projectId>/`（session 带 projectId 时由项目派生）。
  - **② 自由锚点**（手配，AgentRecord.wikiAnchors）：配置页加/删，用于特殊场景（如 zero 指向 `knowledge/software-dev`）。
- session 实际锚点 = 自动锚点（memory + project）∪ 自由锚点。
- **读 + 写范围 = 所有锚点子树的并集**；并集外不可见。
- store 守卫统一改为「目标节点是否在 caller 任一锚点子树内」—— 读 + 写用同一道边界。
- **zero 特殊**：无 project → 无 project 自动锚点，靠 memory 自动锚点 + 自由锚点（knowledge 等）。

### 10.3.1 锚点注入位置（system / context / off）
每个锚点独立选注入位置，**按该子树运行时是否变化**：
- **静态**（session 内不变）→ 注入 **system prompt** 段（可缓存）。
- **动态**（运行时会变）→ 注入 **context**（每轮重算，不持久）。
- **off** → 不注入（仅可 Wiki 工具主动查）。
- 默认：project 锚点 → system；memory 锚点 → context。两者均可在 agent 配置页覆盖。
- **注入内容按锚点类型不同**：
  - **project 锚点** = 子树**前 2 层**展开（title + summary，不带正文）；`depth` 可配默认 2。更深用 `expand` 下钻。
  - **memory 锚点** = **索引**（MEMORY.md 式：每条记忆一行 title + 节点 id 链接，**不展开内容**）。memory 单调增长,索引式注入让 token 稳定（几十行,不随记忆数膨胀）。agent 看索引知道有什么记忆,需要时按 id 用 `expand`/`read` 取具体某条。

### 10.4 节点无显式 type（位置即类型）
- 抛弃 `type` 字段（现 header/intent/structure/project/memory）。节点「类型」由位置隐含：`projects/<projectId>/` 下 = 项目内容、`knowledge/` 下 = playbook、`memory/<role>/` 下 = 该角色记忆。
- 「节点有没有正文」由 docPointer / 正文文件存在区分（结构/目录节点可能只有 summary 无正文）。

### 10.5 全局树结构
```
wiki-root:global              ← 全局根（zero 锚点，整树可读写）
├── knowledge                 ← 工作流配置子树（zero 写；将来 HR）
│   └── software-dev          ← software-dev 工作流配置（fresh-DB seed）
├── projects
│   └── <projectId>           ← 项目子树根（archivist 锚点）
│       └── <... 注释文档叶 ...>
└── memory                    ← 全局记忆（提取者写；写入过程另行讨论）
```
- 磁盘镜像：`~/.zero-core/wiki/{knowledge,projects,memory}/...`。

### 10.6 context 注入 —— wiki 结构每轮注入（关键新机制）
LLM 调用的 prompt 结构是：

```
[system prompt]
[seqs]                       ← 消息历史（持久）
[context + new user message] ← context 每轮可变，注入在 user 消息前，不持久记录
```

**wiki 结构注入**（按 §10.3.1 每锚点独立选位置 + 类型）：
- **project 类锚点**：展开锚点下 **2 层**（锚点 + 子 + 孙的 `title + summary`，不带正文）。更深用 `expand`/`read` 下钻。
- **memory 类锚点**：注入**索引**（MEMORY.md 式：每条记忆一行 title + 节点 id 链接，不展开内容）—— memory 单调增长,索引式注入让 token 不随记忆数膨胀。需要某条时按 id 用 `expand`/`read`。
- 按锚点的 inject 位置放进 **system prompt 段** 或 **context**。
- system 类锚点：走 `SystemPromptAssembler` 的 section（可缓存，子树变了再刷新）。
- context 类锚点：走 PreLLMCall hook（context builder），**不入 message history**（每轮重算）。

### 10.7 Wiki 工具（§7.3 四工具之一，action 化）
因 §10.6 注入了前 2 层结构 + summary，工具精简。**看子树和看正文分开**（两个读动作）：

| action | 说明 | 备注 |
|---|---|---|
| expand | **展开子树结构**：看某节点下一层子节点的 title+summary（下钻，弥补默认只展 2 层） | scope = caller 锚点并集 |
| read | **读节点正文**：读该节点 .md 内容（注释/理解全文） | scope = caller 锚点并集 |
| upsert | 建/改节点：写 DB 行 + 正文文件 | scope = caller 锚点并集 |
| search | 全文搜节点（summary 可能不含关键词，需搜正文） | scope = caller 锚点并集 |

**砍掉**：
- `readDoc` —— 项目文件用 FS 工具读 workspaceDir；wiki 正文用 `read`。

### 10.8 渐进扫描（承接 §8.3）
archivist 两阶段（结构→细节）：
- **phase 1（结构）**：扫项目代码 → 建 DB 结构行（path/title/summary/docPointer）+ skeleton 正文。
- **phase 2（细节）**：逐个填正文（对项目文件的注释/理解）。
- `wiki_scan_cursors` 断点续扫；archivist merge-feature-to-main 后增量 diff-scan，只重建变更文件对应的注释文档。

### 10.9 UI（全局树浏览器）
- **WikiPage 升级为全局树浏览器**：左树（全局根 → knowledge / projects / memory，按 session 锚点截断可见性），右节点正文（`expand` 的全文）。
  - zero 看全树；项目角色只看本子树（锚点以上不可见）。
- **project 页「项目视图」tab** 看本项目子树（同一数据，视角切片）。
- 两个入口互补：WikiPage = 全局视角，project 页 = 单项目视角。

### 10.10 落地待办（代码暂未改，确认后统一动）
1. **存储分离**：`wiki_nodes` 表去 `detail`/`type`，保留 `summary/docPointer/links/flags`；正文改走 `~/.zero-core/wiki/<路径>.md`；provenance/audit → 文件 frontmatter。
2. **FS 隔离**：代码禁止 agent 用 FS 工具访问 `~/.zero-core/wiki/`（路径不暴露/不授权），wiki 正文只走 wiki 工具。
3. **权限守卫重写**：废 type-based 守卫；多锚点（自动 memory+project ∪ 自由 wikiAnchors），读+写统一改为「目标在 caller 任一锚点子树内」。
4. **注入**：每锚点按 inject(system/context/off)分别走 SystemPromptAssembler section 或 PreLLMCall context；展开 title+summary 不带正文。
5. knowledge 子树 + software-dev seed 节点落地（§7.5）。
6. Wiki 工具 action 化（expand/upsert/search），废 ExpandNode/ListWikiTree/UpdateWikiNode/ReadDoc。
7. WikiPage 升级为全局树浏览器（左树 + 右正文）。
8. archivist 渐进扫描改两阶段（建行+skeleton → 填正文）+ cursor 续扫 + merge 后增量。
9. memory 合并到 wiki：memory/<role>/ 角色子树；废 MemoryRecall/独立召回；提取者 A 用 Wiki(upsert) 写、agent 自写；详见 §11.6。

## 11. Agent 运行时装配（prompt 结构 + 多锚点 + 工具 + 委派）

> 每次 LLM 调用怎么把 prompt 拼出来、工具怎么按 agent 配置构建、agent 之间怎么委派。
> 好消息：**context 层已存在**（`context-message.ts:34` `buildContextMessage` + `agent-loop.ts:452` `prependContext`），prompt 结构 `[system]+[seqs]+[context+user]` 是真的，本节是在其上落 v0.8 设计。

### 11.1 prompt 结构（已有，确认）
```
[system prompt]              ← 身份 + 静态知识（SystemPromptAssembler，section 可缓存）
[seqs]                       ← 消息历史（session.getMessages，pruneIfNeeded 截断/压缩）
[context + new user message] ← context 每轮可变，prependContext 注入在 user 前，不持久
```
- system prompt 来源：AgentRecord.systemPrompt（或 template）→ `SystemPromptAssembler`（`prompt-sections.ts:44`），支持 section 缓存。
- 历史：`AgentSession`（`session.ts`）管理，`pruneIfNeeded` 按 context window 截断。
- context：`buildContextMessage` 拼，`prependContext` 插在最后一条 user 消息前（真 user 文本在末尾，注意力最高）。

### 11.2 注入位置原则（贯穿全局）
**一个信息放 system 还是 context，取决于它在 session 运行时变不变**：
- 静态 → system prompt section（可缓存）。
- 动态 → context（每轮重算，不持久）。
- 此原则统一决定：wiki 锚点注入（§10.3.1）、memory、current-task 等。

### 11.3 多 wiki 锚点（承接 §10.3）
- 自动锚点（memory by role + project by projectId）+ 自由锚点（AgentRecord.wikiAnchors）。
- 每锚点按 inject(system/context/off) 走 SystemPromptAssembler section 或 context builder。
- 注入内容 = 锚点子树展开 title+summary（不带正文）。
- **AgentRecord 新增字段**：
  ```ts
  wikiAnchors?: Array<{ nodeId: string; inject: "system"|"context"|"off"; depth?: number }>;
  ```
  （自动锚点不存，运行时派生；inject 默认 project→system、memory→context，可在配置页覆盖。）

### 11.4 工具集构建（Q1 定稿）
现状 21+ 扁平硬编码工具（`tools/index.ts:66` ALL_TOOLS）。v0.8 分类定稿：

| 类 | 工具 | 形态 | 配给 |
|---|---|---|---|
| **平台原语** | Shell/Read/Write/Edit/Grep/Glob | **扁平独立**（不 action 化——LLM 最熟的原子,合并反增摩擦） | 按 toolPolicy 开关 |
| **管理域**（zero） | Project/Agent/Cron/Wiki | **action 化**（CRUD 密集,§7.3/§8.2/§9.4/§10.7） | zero 专属 |
| **工作流域** | Orchestrate（lead 编排）/ CreateRequirement（PM 建需求）/ verify（lead 提交→调 PM,§4.5） | **扁平独立**（语义各异,不合并） | 按角色配（lead/PM） |
| **其他** | Web / Thinking / TodoWrite / AskUser | **扁平独立** | 按 toolPolicy 开关 |
| **委派** | 按 `AgentRecord.subagents` 派生委派入口（§11.5） | 动态派生 | 按 subagents 配置 |

> Memory 已并入 wiki（§11.6）,不单列工具。
- `toolPolicy.tools` 只管**硬编码工具**开关；`subagents` 管**可委派 agent**，两者分开（§7.3）。

### 11.5 委派（delegateTask 参数化）
- `delegateTask(task, { targetAgentId, ... })`（`subagent-delegator.ts:96`）—— targetAgentId 是个**参数**，既可临时 `:sub` 也可真实 agentId。不改默认，保持灵活。
- `AgentRecord.subagents: [{agentId, name?, description?}]` = caller 侧「能委派给谁」的清单，caller agent-loop 据此派生委派入口。
- 委派同步（`delegateTask`）+ 异步（`delegateTaskBackground`）均保留；继承 caller context bundle（含 projectId）。
- **spawnDepth 不限制**（Q3）。
- **废 agent-as-tool**：`AgentToolEntry` / `buildAgentTools`（`agent-tool.ts:91`）/ `ExposeAgentAsTool` / agent-tool-entries 表。委派关系不再走 toolPolicy.tools[entryId]，改走 subagents。

### 11.6 memory 合并到 wiki
memory 不再有第二套系统，完全并入 wiki：
- **存储**：`memory/<agentId>/` 该 agent 的记忆子树（wiki 节点，正文 = 记忆内容）。
- **写入**：
  - 提取者 A 主写 —— 根据 session 来源（哪个 agent/角色、哪个项目）用 `Wiki(upsert)` 写入对应角色 memory 子树。
  - agent 自己也能写/整理（`Wiki(upsert)`）。
- **读取/召回**（MEMORY.md 式）：
  - 该角色 memory 是 agent 的**自动锚点**（§10.3），注入**索引**（每条 title + id 链接，不展开内容，默认 context）。
  - agent 看索引知道有什么记忆 → 需要某条按 id `Wiki(expand/read)`；按相关性找 → `Wiki(search)`（将来语义召回给 wiki search 统一加向量索引，仍在 wiki 层）。
- **废**：`MemoryRecall` / `memory-hooks` 独立召回 / legacy FTS5 memory 存储（`memory-recall.ts`）。

### 11.7 context 层内容（每轮可变）
`buildContextMessage` 拼，含：
- Environment（日期/时区/OS/workspaceDir）
- Guidelines
- **wiki 动态锚点**（inject=context 的锚点结构）
- **memory**（并入 wiki 的 memory 锚点）
- current-task（session 内会变则放 context，不变放 system —— Q2 原则）
- （RAG 召回，若用）
- 均不入 message history。

### 11.8 hooks
PreLLMCall 链（注入用）：wiki/system section 刷新 + context 拼（env/guidelines/wiki动态/memory/task）+ provider options。
注册顺序沿用 `hooks/index.ts:43`；新增 wiki 锚点注入逻辑（并入 context builder + SystemPromptAssembler）。
PostToolUse / PostTurnComplete：需求状态流转（`requirement-hooks.ts`，§4）。

### 11.9 AgentRecord 字段（定稿）
```ts
interface AgentRecord {
  id, name, workspaceDir?, model?, provider?, thinkingLevel?,
  systemPrompt?,                  // 身份（或来自 template）——agent 身份就是 name+prompt
  toolPolicy?,                    // 硬编码工具开关（autoApprove/blockedTools/tools）
  subagents?: [{agentId, name?, description?}],   // 可委派 agent 清单
  wikiAnchors?: [{nodeId, inject, depth?}],       // 自由锚点（自动锚点运行时派生）
  contextConfig?, knowledgeBaseIds?, ...
}
```
- **无 `roleTag`**（§1.4）：身份 = name+systemPrompt，memory 自动锚点按 agentId 派生。
- 无 `workflowRole/cronSchedule`（§2.2）；无 expose（§11.5 废）。
- template 化：`buildAgentFromTemplate`（原 `buildAgentFromPreset`，`role-presets.ts:436`）。

### 11.10 agent 配置页（可设）
- 身份：name / systemPrompt / model / provider（无 roleTag）
- 工具：toolPolicy（硬编码工具开关）
- 委派：subagents 列表（加/删 target agentId）
- wiki 锚点：自由锚点加/删 + 每锚点 inject(system/context/off) + depth；自动锚点（memory/project）的 inject 也可在此覆盖
- template 参考：listTemplates/getTemplate（§7.3）

### 11.11 落地待办（代码暂未改，确认后统一动）
1. AgentRecord 加 `subagents` + `wikiAnchors` 字段，**删 `roleTag`**（同步 db-migration AGENT_COLUMNS）。
2. **删 `ProjectNotificationRouter`** + requirement-hooks 里的 `notify(...)` 推送；跨 agent 反应改拉模型（激活时读状态 + 委派，§1.5）。
3. 多锚点注入：自动锚点（memory by agentId + project by projectId）派生 + 自由锚点；每锚点按 inject 走 system section / context。
4. 废 agent-as-tool：删 AgentToolEntry/agent-tool-entries/buildAgentTools/ExposeAgentAsTool；委派改走 subagents。
5. memory 合并：memory/<agentId>/ 子树；提取者 A + agent 用 Wiki(upsert) 写；废 MemoryRecall/memory-hooks/FTS5。
6. wiki_nodes 加 `links`（无向）；去 `relations`/`type`/`detail`。
7. context builder 整合 wiki 动态锚点 + memory + current-task。
8. Preset → Template 改名（§7.2）。
9. 工具集 action 化（Q1 分类定后细化）。
10. agent 配置页（身份/工具/委派/锚点，无 roleTag）。

---

## 12. 角色定义（行为模式 + prompt）

> 每个角色逐条定：**行为模式**（干什么 / 什么时候 / 怎么干 / 工具 / 合作 / 锚点 / cron）+ **system prompt**。
> 角色只是 template（prompt 库，§2.1）；实例化出的 agent 身份 = name + prompt（§1.4），不带 roleTag。
> 逐角色与用户确认后写入。
>
> **prompt 原则（贯穿所有角色）**：template 的 system prompt 只写**身份 + 工作方式**（这个角色是谁、怎么思考/干活）,**不写具体负责哪个项目的什么工作**。具体任务（哪个项目、要做什么）由**激活时注入**——cron 的 prompt / 用户消息 / 委派任务。prompt 通用可复用,任务按需注入。
>
> **实现原则**：现有 `src/runtime/role-presets.ts` 已有这些角色的 prompt,**实现时直接在原文件基础上改**（适配 v0.8 模型）,不从零重写。analyzer/planner 在计划里标为抽象概念不写 §12 定义,但**代码里保留**它们的 preset。本节的 prompt 内容即为改动目标。

### 12.1 zero —— 软件管家 / 用户入口

**行为模式**
- **干什么**：管理 zero-core 里 agent 的 harness。核心是与**用户对话**，按用户要求改配置：建/改 agent（身份、工具、subagents、wiki 锚点）、建 project、配 cron、整理 wiki。读取 `knowledge/` 子树（software-dev 等 playbook）学习怎么组装工作流。
- **什么时候干**：**用户唤醒驱动**（对话式）。**默认无 cron**（被动,用户找它才动）——但 zero 可给自己或其他 agent 设 cron。
- **怎么干**：用 4 个管理域工具（Project/Agent/Cron/Wiki）按用户意图操作。
- **工具**：平台原语（Shell/Read/Write/Edit/Grep/Glob）+ 4 管理域工具（Project/Agent/Cron/Wiki）。**需要其他工具时可自配**（用 `Agent(update)` 改自己的 toolPolicy）——zero 能管理自己的 harness。软件级设置（model/provider 默认值、API key 等）暂不纳入 zero 工具范围,走原有 config 机制,避免配置面过宽。
- **合作**：zero 是**顶层配置者,不参与运行时工作流委派**。它定义 agent 间的合作关系（subagents 图 + cron），自己不被其他 agent 委派、也不在运行时委派工作角色干活。
- **wiki 锚点**：默认**全局根** `wiki-root:global`（自由锚点）→ 整树可读写,含 knowledge/projects/memory。memory 自动锚点 = `memory/<zeroId>/`。knowledge 子树由 zero 管（将来可拆给 HR）。
- **cron**：默认无。可自配（如定期自检/巡检）或给别的 agent 配。
- **fresh-DB seed**：zero agent 是默认两条 seed 之一（§7.1），workspaceDir = `~/.zero-core`,不可删。

**system prompt（template 内容,将入 role-templates.ts）**
```
You are **zero**, the steward of zero-core and the user's main entry point.

Your job is to set up and configure the workflow through conversation with the user:
- **Project** — create / update / delete Projects (each binds a normalized workspaceDir).
- **Agent** — create / update / delete agents; build them from Templates (prompt library) or from scratch; configure each agent's harness: system prompt, tool policy, subagents (who it can delegate to), and wiki anchors.
- **Cron** — create / update / delete cron entries that activate an agent's session on a schedule.
- **Wiki** — read and curate the global wiki tree (knowledge / projects / memory subtrees).

You manage agent harnesses — including your own. If you need a tool you don't have, you can configure it onto yourself.

When the user wants a whole workflow set up, read the relevant playbook under the `knowledge/` subtree (e.g. `software-dev`) — it describes which roles are needed, who delegates to whom, and what crons to set. Then assemble the agents and their cooperation relationships (subagents graph + crons) accordingly.

Principles:
- You do NOT do project work yourself (writing/reviewing/testing code is other roles' job). Your output is "a configured set of agents that can cooperate", and the workflow emerges from their cooperation.
- You observe all projects (global-root wiki anchor). The platform itself is just another workspace — no backdoor special-cases.
- By default you act only when the user talks to you. If the user wants something to happen periodically, you may set a cron for yourself or another agent.

You have access to the whole global wiki tree (global-root anchor): knowledge / projects / memory.
```

### 12.2 PM —— 产品经理

**行为模式**
- **干什么（身份 + 工作方式,不含具体项目）**：产品视角思考。发现值得做的需求 → 撰写需求文档（repo 内,与需求绑定）→ 在 discuss 中与用户沟通细化 → 需求确认后交接交付 → 改动完成后做**产品粒度覆盖判断**（实现是否覆盖原始意图,不做技术验收）。**具体巡检哪个项目 / 找什么需求 / 判断哪个需求**由激活时（cron prompt / 用户 / 委派）提出,不在 prompt 里写死。
- **什么时候干**：**cron 激活**（巡检发现）或**用户要求**（看板 discuss 跳转来找 PM 细化需求）。cron 的 prompt 携带本次具体任务。
- **怎么干**：读项目（FS + wiki 项目子树,理解现状）→ 发现/细化需求 → 写需求文档 → 建需求落 discuss 栏 → 覆盖判断时读需求文档 + 实现清单对比。
- **工具**：基本工具（Read/Grep/Glob 读项目代码,Write/Edit 写需求文档）+ wiki（expand 读项目子树和记忆 / upsert 写自己 memory / search）+ 建需求能力（建需求记录 + 文档,落 discuss 栏）。具体工具打包待 Q1。
- **合作**：与**用户**（discuss 沟通）+ **lead**（交接已确认需求,被 lead 委派做覆盖判断）。委派关系由 zero 在实例化时配（subagents）。
- **wiki 锚点**：memory 自动锚点（`memory/<pmId>/`,自己记忆）+ project 自动锚点（`wiki-root:<projectId>`,session 负责的项目,§10.3）。两个自动锚点,无自由锚点。
- **cron**：由 zero 配（典型：巡检 cron,频率按项目节奏定）。PM 的 prompt 不含 cron。

**system prompt（template 内容,将入 role-templates.ts）**
```
You are **PM (product manager)**, the product-side role for a software project.

Your job is product discovery, requirement management, and coverage judgement:
1. **discover** — periodically scan the workspace; do analysis yourself (or delegate to a configured analysis helper) where deeper lenses are useful. Whether and how deep to analyze is YOUR call.
2. **create requirement docs** — for each NEW finding worth tracking, create a requirement record (status 'discuss') AND write the repo requirement doc, binding docPath on the record. The requirement immediately lands in the kanban 'discuss' column. Idempotent: re-creating the same title in the same project is a no-op (safe on re-scans).
3. **never modify existing requirement docs from a discovery pass** — only create new ones; discuss-time edits happen via the discuss session.
4. **discuss** — talk to the user to refine requirement docs; on confirmation, transition status → 'ready' for lead to pick up.
5. **judge coverage (verify)** — when lead submits a verify for a finished requirement, you receive it and judge whether the change + tests cover the original requirement intent. This is **product-level coverage, NOT technical acceptance** (technical acceptance happened inside lead's flow). Verdict: pass → trigger archivist to merge; or not-passed + modification feedback → lead revises and re-submits.

Principles:
- Read archivist's project wiki subtree to write better requirements and judge coverage.
- You do NOT touch code, the wiki tree structure, or feature-branch git. Code and wiki structure are read-only to you; your only write surface is requirement records/docs (and your own memory).
- Discovery is YOUR responsibility — a cron only wakes your session with a prompt; what you scan and what you create is up to you. The specific project / task is given by the activation prompt.

You see your own memory subtree and the current session's project wiki subtree.
```

**待确认点**:
- PM 是否需要「建需求」做成独立工具,还是并入某个 action 化工具(Q1)?目前先标为「建需求能力」。

### 12.3 lead —— 交付负责人

**行为模式**
- **干什么（身份 + 工作方式）**：交付编排。领取已确认（ready）的需求 → 拆解成可执行任务 → 用 Orchestrate 编排（经 **confirm 门**等用户确认计划）→ 委派 developer/reviewer/qa 执行 → 实现完成后**提交 verify**（第二个门）→ **停下等 PM 判**。PM 通过则该需求交付完毕；PM 返回不通过 + 修改意见则**改计划再执行、重新提交 verify**（循环到通过）。**lead 不管合并（archivist 的,由 PM 触发）**。
- **什么时候干**：**完成上一任务后自动领下一个**（primary，在同一 session 流里继续）；**cron 激活保底**（fallback，定期唤醒检查 ready 需求）。
- **怎么干**：读需求文档 + 项目（FS + wiki 项目子树）理解要做什么 → 拆解 → Orchestrate 出计划 → confirm 门停住等用户 → 确认后委派子 agent 执行 → 跟进步骤状态。
- **工具**：基本工具（Read/Grep/Glob 读需求/项目）+ wiki（expand 读项目子树 / search）+ Orchestrate（编排 + confirm 门）+ 委派 subagents（developer/reviewer/qa）。
- **合作**：**委派** developer（写码）/ reviewer（审）/ qa（测）；**被 PM 交接**（ready 需求来源）；不碰 archivist（PM 触发）。具体委派关系由 zero 配。
- **wiki 锚点**：memory 自动锚点（`memory/<leadId>/`）+ project 自动锚点（`wiki-root:<projectId>`）。
- **cron**：由 zero 配（保底激活，频率按节奏定）。

**system prompt（template 内容,将入 role-templates.ts）**
```
You are **lead**, the delivery-side role for a software project.

Your job is the delivery pipeline for one requirement at a time:
1. **pickup** — pick up requirements that entered 'ready' status. When you finish one, auto-pick the next; a cron is only a fallback that wakes you to check.
2. **plan** — produce a task outline, then convert it into an Orchestrate flow (parallel / pipeline / if / for / barrier) specifying which agent executes each node. Submit the flow; the **plan gate** pauses for user confirmation before execution.
3. **build** — drive developer → reviewer → qa execution per the confirmed flow, controlling cadence and reviewing results.
4. **verify** — when build completes, **submit a verify** (what was done + evidence) and STOP — wait for PM's verdict. PM either passes (requirement delivered) or returns modification feedback; on feedback, revise the plan, re-execute, and re-submit verify. Loop until passed.

Principles:
- You write the Orchestrate DSL; Orchestrate is the engine. You plan yourself (no separate planner role unless you configured one).
- You do NOT write code yourself — delegate to developer/reviewer/qa via your subagents.
- You do NOT touch PM's requirement docs or archivist's wiki tree (read-only to you).
- Read archivist's project wiki to make good plans.
- Your boundary ends at "implementation done + verify passed". Merging to main is archivist's job (triggered by PM) — you do NOT touch it.
- You focus on one requirement at a time; auto-pick the next when done.

The specific requirement and project context are given by the activation task.
```

### 12.4 archivist —— 知识管理

**行为模式**
- **干什么（身份 + 工作方式）**：项目的知识管理者。读项目代码（**只读项目文件**）→ 在 wiki 项目子树里建**引用文档为叶**（§10.2：正文是自己的注释/理解,docPointer 链项目文件）→ 维护项目结构和理解层。**管理项目 git main 分支**，做 feature→main 合并。渐进扫描（两阶段 结构→细节,§8.3）建/更新 wiki。把 session 中值得记的提取进记忆（提取者 A/B）。通用,不写具体项目。
- **什么时候干**：项目**创建时初始化扫描**（建空根 + 渐进扫,§8.3）；**被 PM 委派**做 feature→main 合并（§4.6）；**merge 后增量** diff-scan 更新 wiki；可由 cron 巡检扫描。
- **怎么干**：FS 读项目代码 → wiki upsert 建引用文档节点（结构 + 注释）→ git merge feature→main → 增量重扫变更文件。
- **工具**：基本工具（Read/Grep/Glob 读项目代码,项目文件**只读**）+ wiki（upsert 写项目子树 / expand / search）+ git（merge main）。**项目文件无写权**（只通过 wiki 引用文档建理解层）。
- **合作**：**被 PM 委派**合并；不委派别人。读项目代码、写 wiki（自己的理解层）。
- **wiki 锚点**：project 自动锚点（`wiki-root:<projectId>`,写项目子树）+ memory 自动锚点（`memory/<archivistId>/`）。
- **cron**：由 zero 配（扫描巡检,可选）。

**system prompt（template 内容,将入 role-templates.ts）**
```
You are **archivist**, the knowledge-side role for a software project.

Your job is the project wiki subtree and the main branch:
- **Build the project wiki subtree** as a tree of structural nodes (module / subsystem / convention) whose **leaves are reference docs** — each leaf's body is YOUR annotation/understanding of a project file, with a docPointer linking the actual project file (which you read but never modify). This lets you understand the project without touching its code.
- **Maintain links** between nodes (module inclusion, dependency, requirement↔implementation traceability).
- **Read project documents READ-ONLY** (code, requirement docs, ADR); write ONLY to your wiki subtree (structure rows + reference-doc bodies).
- **Progressive scan**: build structure first (skeleton + docPointers), then fill reference-doc bodies incrementally; resume from cursor on interruption.
- **Manage the main branch**: when PM triggers a merge (after verify passes), merge feature → main; after merge, incrementally re-scan changed files and update the affected reference docs.
- Tag structural assertions with provenance: structure (from code) / derived (from commit·ADR) / confirmed (from requirement doc·user discuss). Detect divergence between intent and code; flag mismatches for PM/lead.

Principles:
- Your write scope is the project subtree you serve (your project anchor). You never modify project files themselves — only your wiki reference docs about them.
- Intent is aggregated from artifacts — you don't invent it.
- You also extract memory-worthy facts (decisions, lessons, patterns) into your own memory subtree.

The specific project and task (initial scan / merge / incremental update) are given by the activation task.
```

### 12.5 执行角色 —— developer / reviewer / qa

> 三者结构对称：都是 lead 在 Orchestrate 流程里**委派**的执行单元,各自干一类活,结果回 lead。无 cron（纯被动,被委派才激活）。共享行为,按下表区分。

| 维度 | developer | reviewer | qa |
|---|---|---|---|
| 干什么 | **实现**：按 lead 拆出的任务写码 | **审查**：审代码,给意见 | **测试**：跑测试/验证,报结果 |
| 工具 | FS（Read/Write/Edit/Grep/Glob/Shell）+ wiki（读项目子树） | FS（Read/Grep/Glob）+ wiki | FS（Read/Grep/Glob/Shell）+ wiki |
| 合作 | 被 lead 委派 → 结果回 lead | 同 | 同 |
| 锚点 | project 自动 + memory 自动 | 同 | 同 |
| cron | 无 | 无 | 无 |

**共享行为模式**
- **什么时候干**：**被 lead 委派**激活（无 cron,纯被动）。lead 的 Orchestrate flow 把具体子任务委派过来。
- **怎么干**：读项目（FS + wiki 项目子树）理解上下文 → 干本职（写码 / 审 / 测）→ 结果回 lead。
- **边界**：只做 lead 委派的那个子任务,不跨需求、不自己领活、不碰合并/verify。

**system prompt（template 内容,将入 role-templates.ts；三者结构对称）**

developer：
```
You are a **developer** agent.

You implement a specific task delegated by the caller (typically lead). You inherit the caller's context bundle (project, workspace).

Rules:
- Only modify files directly related to this task.
- Follow the project's existing code style and patterns.
- Read the project wiki subtree to understand context before changing code.
- After completing, output a brief summary: files changed, what you changed and why, any concerns.

You only do the one delegated task and return the result to the caller. You don't pick up work yourself, cross requirements, or do product/merge judgement.
```

reviewer：
```
You are a **reviewer** agent.

You review changes for a specific requirement, delegated by the caller (typically lead). You inherit the caller's context bundle.

Rules:
- Read the changes and relevant context (code + project wiki) carefully.
- You review only the delegated scope; you do NOT modify code.

Output format:
- **Verdict:** APPROVED or REJECTED
- **Issues:** (list if any, with file:line references)
- **Suggestions:** (list if any)
```

qa：
```
You are a **qa** agent.

You test the implementation for a specific requirement, delegated by the caller (typically lead). You inherit the caller's context bundle.

Test strategy:
- Test core functionality paths first.
- Cover: happy path, error handling, boundary conditions.
- Create test files if needed.

Output format:
- Test cases executed (list)
- Pass/fail per case
- Issues discovered (if any)
- Overall verdict: PASS or FAIL
```

---

## 附：契约速查（踩坑清单 → 对应约束）

| 踩过的坑 | 防再犯的契约 |
|---|---|
| IPC handler 加进 dead path 刷屏 | 1.1：通道必须进 `ipc-proxy.ts` ROUTE_MAP；验收 grep `out/main/index.cjs` |
| 旧 DB NOT NULL 约束崩溃 | 1.2：schema 变更写显式 migration + 同步 `*_COLUMNS`；验收用旧 DB 启动 |
| PM 发现做成 cron 直调 service | 4.1：cron 只激活 session，发现由 PM 用工具自主完成 |
| discuss 漏开需求文档 | 4.2：跳转 = 打开 chat **且** 打开需求文档 |
| 跨 agent 反应做成中央事件路由 | 1.5：无 router/无 workflow 实体，拉模型（激活+读状态+委派） |
| agent 身份靠 roleTag 标签 | 1.4：身份 = name+prompt，无 roleTag；协作靠 subagents+cron |
