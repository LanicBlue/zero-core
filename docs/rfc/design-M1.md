# M1 设计文档：数据基础

> **版本**: 1.0
> **对应计划**: `plan-M1.md`
> **依赖**: 无
> **目标**: 定义完整的数据模型、API 契约、状态机和 Store 架构

---

## 1. 数据模型

### 1.1 ER 关系图

```
projects (1) ──┬── (N) project_wiki
               ├── (N) requirements (1) ──┬── (N) requirement_status_history
               │                          ├── (N) task_steps
               │                          └── (N) requirement_messages
               └── (1) analyst_session
```

### 1.2 表结构详细定义

#### projects

| 列名 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PK | nanoid() | 项目唯一标识 |
| name | TEXT | NOT NULL | — | 项目名称 |
| path | TEXT | NOT NULL, UNIQUE | — | 项目文件系统路径 |
| analyst_cron_id | TEXT | NULL | NULL | 关联的定时任务 ID（M5 使用） |
| analyst_session_id | TEXT | NULL | NULL | 当前的 Analyst Agent 会话 ID |
| last_analysis_at | TEXT | NULL | NULL | 上次分析完成时间（ISO 8601） |
| analysis_interval | TEXT | — | 'daily' | 巡检间隔：daily / hourly / cron 表达式 |
| status | TEXT | — | 'active' | 项目状态：active / paused |
| created_at | TEXT | — | now() | 创建时间 |
| updated_at | TEXT | — | now() | 最后更新时间 |

**业务约束**:
- `path` 必须唯一，同一目录不能注册两个项目
- `status` 只允许 `'active' | 'paused'`
- `analysis_interval` 允许值：`'daily' | 'hourly'` 或 5 段 cron 表达式

#### project_wiki

| 列名 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PK | nanoid() | 节点唯一标识 |
| project_id | TEXT | FK→projects(id), NOT NULL | — | 所属项目 |
| parent_id | TEXT | FK→project_wiki(id) | NULL | 父节点 ID，根节点为 NULL |
| node_type | TEXT | NOT NULL | — | 节点类型 |
| path | TEXT | NOT NULL | — | 路径标识（如 `src/runtime/agent-loop.ts`） |
| title | TEXT | NOT NULL | — | 节点显示标题 |
| summary | TEXT | NULL | NULL | 浅层摘要（默认加载） |
| detail | TEXT | NULL | NULL | 详细内容（按需展开） |
| last_updated_by | TEXT | — | 'analyst' | 最后更新者 |
| source_req_id | TEXT | NULL | NULL | 关联的需求 ID（变更触发更新时） |
| created_at | TEXT | — | now() | 创建时间 |
| updated_at | TEXT | — | now() | 最后更新时间 |

**业务约束**:
- `UNIQUE(project_id, path)` — 同一项目内路径唯一
- `node_type` 允许值：`directory | file | function | class | section`
- 根节点：`parent_id IS NULL` 且 `path = '/'`
- `summary` 为 NULL 表示尚未分析

#### requirements

| 列名 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PK | nanoid() | 需求唯一标识 |
| project_id | TEXT | FK→projects(id), NOT NULL | — | 所属项目 |
| title | TEXT | NOT NULL | — | 需求标题 |
| description | TEXT | NULL | NULL | 详细描述 |
| status | TEXT | — | 'found' | 需求状态 |
| source | TEXT | — | 'analyst' | 来源 |
| priority | TEXT | — | 'normal' | 优先级 |
| impact_scope | TEXT | NULL | NULL | 影响范围描述 |
| context | TEXT | NULL | NULL | JSON：附加上下文 |
| assigned_lead_session_id | TEXT | NULL | NULL | 分配的 Lead 会话 ID |
| discussion_session_id | TEXT | NULL | NULL | 讨论会话 ID |
| reviewer | TEXT | — | 'analyst' | 最终验证者 |
| closed_at | TEXT | NULL | NULL | 关闭时间 |
| created_at | TEXT | — | now() | 创建时间 |
| updated_at | TEXT | — | now() | 最后更新时间 |

**context JSON 结构**:
```json
{
  "relatedFiles": ["src/runtime/agent-loop.ts"],
  "wikiPaths": ["src/runtime/"],
  "tags": ["performance", "architecture"],
  "estimatedEffort": "medium"
}
```

#### requirement_status_history

| 列名 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PK | nanoid() | 记录唯一标识 |
| requirement_id | TEXT | FK→requirements(id), NOT NULL | — | 关联需求 |
| from_status | TEXT | NULL | NULL | 源状态（首次创建时为 NULL） |
| to_status | TEXT | NOT NULL | — | 目标状态 |
| triggered_by | TEXT | NOT NULL | — | 触发者角色 |
| comment | TEXT | NULL | NULL | 状态变更说明 |
| created_at | TEXT | — | now() | 创建时间 |

#### task_steps

| 列名 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PK | nanoid() | 步骤唯一标识 |
| requirement_id | TEXT | FK→requirements(id), NOT NULL | — | 关联需求 |
| step_order | INTEGER | NOT NULL | — | 执行顺序 |
| role | TEXT | NOT NULL | — | 执行角色 |
| title | TEXT | NOT NULL | — | 步骤标题 |
| description | TEXT | NULL | NULL | 详细描述 |
| agent_config | TEXT | NULL | NULL | JSON：Agent 配置覆盖 |
| status | TEXT | — | 'pending' | 步骤状态 |
| input | TEXT | NULL | NULL | JSON：步骤输入参数 |
| output | TEXT | NULL | NULL | JSON：步骤执行结果 |
| review_result | TEXT | NULL | NULL | 审查结果 |
| review_comment | TEXT | NULL | NULL | 审查意见 |
| retry_count | INTEGER | — | 0 | 当前重试次数 |
| max_retries | INTEGER | — | 3 | 最大重试次数 |
| session_id | TEXT | NULL | NULL | 执行该步骤的 Agent 会话 ID |
| started_at | TEXT | NULL | NULL | 开始执行时间 |
| completed_at | TEXT | NULL | NULL | 完成时间 |
| error | TEXT | NULL | NULL | 错误信息 |
| created_at | TEXT | — | now() | 创建时间 |
| updated_at | TEXT | — | now() | 最后更新时间 |

**agent_config JSON 结构**:
```json
{
  "modelOverride": "claude-sonnet-4-6",
  "toolPolicy": { "allow": ["Read", "Write", "Edit", "Shell"], "deny": [] },
  "systemPromptAppend": "特别注意错误处理..."
}
```

**output JSON 结构**:
```json
{
  "summary": "实现了微信支付集成...",
  "changedFiles": ["src/payment/wechat.ts", "src/payment/index.ts"],
  "issues": [],
  "linesAdded": 145,
  "linesRemoved": 23
}
```

#### requirement_messages

| 列名 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PK | nanoid() | 消息唯一标识 |
| requirement_id | TEXT | FK→requirements(id), NOT NULL | — | 关联需求 |
| sender | TEXT | NOT NULL | — | 发送者角色 |
| content | TEXT | NOT NULL | — | 消息内容 |
| message_type | TEXT | — | 'text' | 消息类型 |
| metadata | TEXT | NULL | NULL | JSON：附加元数据 |
| created_at | TEXT | — | now() | 创建时间 |

**metadata JSON 结构** (按 message_type):
```json
// status_change
{ "fromStatus": "discuss", "toStatus": "ready" }

// approval_request
{ "requestedBy": "lead", "action": "confirm_plan" }

// notification
{ "priority": "high", "actionUrl": "/requirements/{id}" }
```

---

## 2. 需求状态机

### 2.1 状态流转图

```
                  analyst                user/lead
   ┌──────┐    ──────────►  ┌─────────┐  ──────────►  ┌───────┐
   │found │                 │ discuss  │               │ ready │
   └──────┘                 └─────────┘               └───────┘
       ▲                                                    │
       │ user                                              │ lead
       │ (re-analyze)                                      ▼
   ┌──────┐                                          ┌───────┐
   │closed│  ◄── analyst/user ──── verify ────────  │ plan  │
   └──────┘                                    ▲     └───────┘
       ▲                                       │          │
       │                                       │          │ lead
       │  ◄──── any role ──── cancelled         │          ▼
       │                                       │     ┌───────┐
       └───────────────────────────────────────┘     │ build │
                                                       └───────┘
```

### 2.2 合法流转表

| from | to | triggeredBy | 条件 |
|------|----|-------------|------|
| — | found | analyst | 首次创建 |
| — | found | user | 手动创建 |
| found | discuss | user | 用户点击讨论 |
| found | discuss | analyst | Analyst 启动讨论 |
| discuss | ready | user | 用户确认就绪 |
| discuss | found | user | 用户退回 |
| ready | plan | lead | Lead 领取 |
| plan | build | lead | Lead 完成规划，有 task_steps |
| plan | ready | lead | 规划失败退回 |
| build | verify | system | 所有 steps completed |
| build | build | lead | 继续下一步骤 |
| verify | closed | analyst | Analyst 验证通过 |
| verify | closed | user | 用户手动确认 |
| verify | build | lead | 验证失败，重新执行 |
| any | cancelled | user | 用户随时取消 |

### 2.3 状态机 API

```typescript
interface StateMachineResult {
  valid: boolean;
  error?: string;
}

isValidTransition(from: RequirementStatus | undefined, to: RequirementStatus, triggeredBy: string): StateMachineResult
getNextStatuses(current: RequirementStatus, triggeredBy: string): RequirementStatus[]
getAllowedTriggers(current: RequirementStatus): Array<{ to: RequirementStatus; triggeredBy: string[] }>
```

---

## 3. API 契约

### 3.1 项目 API — `/api/projects`

#### POST /
创建项目。

**Request**:
```json
{
  "name": "zero-core",
  "path": "/home/user/projects/zero-core",
  "analysisInterval": "daily"
}
```

**Response 201**:
```json
{
  "id": "proj_abc123",
  "name": "zero-core",
  "path": "/home/user/projects/zero-core",
  "analystCronId": null,
  "analystSessionId": null,
  "lastAnalysisAt": null,
  "analysisInterval": "daily",
  "status": "active",
  "createdAt": "2026-06-12T10:00:00.000Z",
  "updatedAt": "2026-06-12T10:00:00.000Z"
}
```

**Error 409** (路径重复):
```json
{ "error": "Project with this path already exists" }
```

#### GET /
列出所有项目。

**Query Params**: `?status=active`（可选）

**Response 200**:
```json
[
  { "id": "proj_abc123", ... },
  { "id": "proj_def456", ... }
]
```

#### GET /:id
获取单个项目。

**Error 404**:
```json
{ "error": "Project not found" }
```

#### PUT /:id
更新项目。

**Request**:
```json
{
  "name": "zero-core-v2",
  "analysisInterval": "hourly",
  "status": "paused"
}
```

**Response 200**: 更新后的完整 ProjectRecord

#### DELETE /:id
删除项目（级联）。

**行为**:
1. 删除 `project_wiki` 中该项目的所有节点
2. 删除 `requirements` 中该项目的所有需求
3. 级联删除 `requirement_status_history`、`task_steps`、`requirement_messages`
4. 删除项目本身

**Response 204**: 无内容

#### POST /:id/trigger-analysis
触发分析（M2 实现）。

**Response 202**:
```json
{ "ok": true, "message": "Analysis triggered", "type": "full" }
```

---

### 3.2 需求 API — `/api/requirements`

#### POST /
创建需求。

**Request**:
```json
{
  "projectId": "proj_abc123",
  "title": "支付集成功能",
  "description": "需要集成微信支付和支付宝支付...",
  "priority": "high",
  "source": "user",
  "impactScope": "支付模块",
  "context": "{\"relatedFiles\":[\"src/payment/\"]}"
}
```

**Response 201**: 完整 RequirementRecord（status='found'）

**自动行为**:
- `status` 默认 `'found'`
- 自动创建一条 `requirement_status_history`（from_status=NULL, to_status='found'）
- 自动创建一条 `requirement_messages`（type='status_change'）

#### GET /
列出需求。

**Query Params**:
- `projectId` — 按项目筛选
- `status` — 按状态筛选
- `priority` — 按优先级筛选

**Response 200**: RequirementRecord[]

#### GET /:id
获取单个需求。

#### PUT /:id
更新需求基础字段（title, description, priority, impactScope, context, reviewer）。

**注意**: 状态变更必须走 `PUT /:id/status`。

#### PUT /:id/status
状态流转。

**Request**:
```json
{
  "toStatus": "ready",
  "triggeredBy": "user",
  "comment": "需求明确，可以开始"
}
```

**Response 200**:
```json
{
  "requirement": { ...updated RequirementRecord },
  "historyEntry": { ...new RequirementStatusHistory }
}
```

**Error 400** (非法流转):
```json
{
  "error": "Invalid transition: found -> build (triggeredBy: user)",
  "validTargets": ["discuss", "cancelled"]
}
```

#### GET /:id/history
获取状态变更历史。

**Response 200**: RequirementStatusHistory[]（按 created_at DESC）

#### GET /:id/messages
获取需求消息列表。

**Response 200**: RequirementMessage[]（按 created_at ASC）

#### POST /:id/messages
添加消息。

**Request**:
```json
{
  "sender": "user",
  "content": "这个需求需要考虑退款场景",
  "messageType": "text"
}
```

**Response 201**: RequirementMessage

#### GET /:id/steps
获取任务的执行步骤。

**Response 200**: TaskStepRecord[]（按 step_order ASC）

---

### 3.3 Wiki API — `/api/project-wiki`

#### GET /:projectId/nodes
获取项目 Wiki 节点列表。

**Query Params**:
- `parentId` — 筛选子节点（不传则返回全部）
- `nodeType` — 按类型筛选

**Response 200**: ProjectWikiNode[]

#### GET /node/:id
获取单个 Wiki 节点。

**Response 200**: ProjectWikiNode（含 detail 字段）

#### POST /:projectId/nodes
创建 Wiki 节点。

**Request**:
```json
{
  "parentId": "wiki_parent123",
  "nodeType": "file",
  "path": "src/runtime/agent-loop.ts",
  "title": "agent-loop.ts",
  "summary": "AgentLoop 是核心执行引擎...",
  "detail": "## 概述\nAgentLoop 接收 SessionConfig..."
}
```

**Response 201**: ProjectWikiNode

**Error 409** (路径重复):
```json
{ "error": "Wiki node with path 'src/runtime/agent-loop.ts' already exists in this project" }
```

#### PUT /node/:id
更新 Wiki 节点。

**Request**:
```json
{
  "summary": "更新后的摘要...",
  "detail": "更新后的详情...",
  "lastUpdatedBy": "analyst"
}
```

**Response 200**: 更新后的 ProjectWikiNode

#### DELETE /node/:id
删除 Wiki 节点。

**行为**: 级联删除子节点（递归）。

**Response 204**

---

## 4. Store 架构

### 4.1 层次结构

```
SqliteStore<T> (基类)
├── ProjectStore
├── ProjectWikiStore
├── RequirementStore
│   ├── 内部 SqliteStore<RequirementRecord> (requirements)
│   ├── 内部 SqliteStore<RequirementStatusHistory> (status_history)
│   └── 内部 SqliteStore<RequirementMessage> (messages)
└── TaskStepStore
```

### 4.2 Store 方法签名

#### ProjectStore

```typescript
class ProjectStore {
  constructor(sessionDB: Database)

  list(filter?: { status?: string }): ProjectRecord[]
  get(id: string): ProjectRecord | undefined
  getByPath(path: string): ProjectRecord | undefined
  listActive(): ProjectRecord[]

  create(input: Omit<ProjectRecord, 'id' | 'createdAt' | 'updatedAt'>): ProjectRecord
  update(id: string, input: Partial<ProjectRecord>): ProjectRecord
  delete(id: string): void
}
```

#### ProjectWikiStore

```typescript
class ProjectWikiStore {
  constructor(sessionDB: Database)

  list(filter?: { projectId?: string; parentId?: string; nodeType?: string }): ProjectWikiNode[]
  get(id: string): ProjectWikiNode | undefined
  getByPath(projectId: string, path: string): ProjectWikiNode | undefined
  listByProject(projectId: string): ProjectWikiNode[]
  getChildren(parentId: string): ProjectWikiNode[]
  getTopLevelNodes(projectId: string): ProjectWikiNode[]
  getNodesByPaths(projectId: string, paths: string[]): ProjectWikiNode[]

  create(input: Omit<ProjectWikiNode, 'id' | 'createdAt' | 'updatedAt'>): ProjectWikiNode
  update(id: string, input: Partial<ProjectWikiNode>): ProjectWikiNode
  delete(id: string): void  // 递归删除子节点
  deleteByProject(projectId: string): void
}
```

#### RequirementStore

```typescript
class RequirementStore {
  constructor(sessionDB: Database)

  // — 基础 CRUD —
  list(filter?: { projectId?: string; status?: string; priority?: string }): RequirementRecord[]
  get(id: string): RequirementRecord | undefined
  create(input: Omit<RequirementRecord, 'id' | 'createdAt' | 'updatedAt'>): RequirementRecord
  update(id: string, input: Partial<RequirementRecord>): RequirementRecord
  delete(id: string): void  // 级联删除 history + steps + messages

  // — 领域查询 —
  listByProject(projectId: string): RequirementRecord[]
  listByStatus(status: RequirementStatus): RequirementRecord[]
  findReady(): RequirementRecord[]  // status='ready' 且无 assignedLeadSessionId

  // — 状态机 —
  transitionStatus(id: string, toStatus: RequirementStatus, triggeredBy: string, comment?: string): {
    requirement: RequirementRecord;
    historyEntry: RequirementStatusHistory;
  }
  // 内部调用 isValidTransition() 校验
  // 自动写入 status_history
  // 自动更新 requirement.updatedAt

  // — 消息 —
  addMessage(requirementId: string, sender: RequirementMessageSender, content: string, messageType?: RequirementMessageType): RequirementMessage
  getMessages(requirementId: string): RequirementMessage[]

  // — 状态历史 —
  getStatusHistory(requirementId: string): RequirementStatusHistory[]
}
```

#### TaskStepStore

```typescript
class TaskStepStore {
  constructor(sessionDB: Database)

  list(filter?: { requirementId?: string; status?: string }): TaskStepRecord[]
  get(id: string): TaskStepRecord | undefined

  create(input: Omit<TaskStepRecord, 'id' | 'createdAt' | 'updatedAt'>): TaskStepRecord
  update(id: string, input: Partial<TaskStepRecord>): TaskStepRecord
  delete(id: string): void

  // — 领域查询 —
  listByRequirement(requirementId: string): TaskStepRecord[]  // ORDER BY step_order ASC
  getCurrentStep(requirementId: string): TaskStepRecord | undefined  // status='running'
  getCompletedCount(requirementId: string): number
  deleteByRequirement(requirementId: string): void
}
```

### 4.3 列名映射规则

遵循现有 `SqliteStore<T>` 的 camelCase ↔ snake_case 自动映射：

```
TypeScript (camelCase)     →  SQLite (snake_case)
projectId                  →  project_id
analysisInterval           →  analysis_interval
assignedLeadSessionId      →  assigned_lead_session_id
nodeType                   →  node_type
lastUpdatedBy              →  last_updated_by
stepOrder                  →  step_order
retryCount                 →  retry_count
maxRetries                 →  max_retries
```

COLUMNS 常量使用 snake_case，与 SQLite 列名一一对应。

---

## 5. IPC 通道定义

### 5.1 新增通道

```typescript
// projects
"projects:list"       — (filter?: { status?: string }) → ProjectRecord[]
"projects:get"        — (id: string) → ProjectRecord
"projects:create"     — (input: {...}) → ProjectRecord
"projects:update"     — (id: string, input: {...}) → ProjectRecord
"projects:delete"     — (id: string) → void

// requirements
"requirements:list"       — (filter?: {...}) → RequirementRecord[]
"requirements:get"        — (id: string) → RequirementRecord
"requirements:create"     — (input: {...}) → RequirementRecord
"requirements:update"     — (id: string, input: {...}) → RequirementRecord
"requirements:transition" — (id: string, toStatus: string, triggeredBy: string, comment?: string) → {...}
"requirements:history"    — (id: string) → RequirementStatusHistory[]
"requirements:messages"   — (id: string) → RequirementMessage[]
"requirements:addMessage" — (id: string, sender: string, content: string, messageType?: string) → RequirementMessage
"requirements:steps"      — (id: string) → TaskStepRecord[]

// wiki
"wiki:listByProject" — (projectId: string) → ProjectWikiNode[]
"wiki:getNode"       — (id: string) → ProjectWikiNode
"wiki:createNode"    — (projectId: string, input: {...}) → ProjectWikiNode
"wiki:updateNode"    — (id: string, input: {...}) → ProjectWikiNode
"wiki:deleteNode"    — (id: string) → void
```

---

## 6. 错误处理

### 6.1 错误码体系

| HTTP 状态码 | 场景 | 错误格式 |
|-------------|------|----------|
| 400 | 参数校验失败、非法状态流转 | `{ "error": "描述", "validTargets": [...] }` |
| 404 | 资源不存在 | `{ "error": "Xxx not found" }` |
| 409 | 唯一约束冲突 | `{ "error": "Xxx with this Y already exists" }` |
| 500 | 内部错误 | `{ "error": "Internal server error" }` |

### 6.2 Store 层错误处理

- **create**: 捕获 UNIQUE 约束错误，转为 409
- **get**: 找不到返回 `undefined`（Router 层转 404）
- **transitionStatus**: 校验失败抛出 `InvalidTransitionError`
- **delete**: 级联删除在事务内执行，失败全部回滚

### 6.3 级联删除策略

```
DELETE project
  → DELETE project_wiki WHERE project_id = ?
  → DELETE task_steps WHERE requirement_id IN (SELECT id FROM requirements WHERE project_id = ?)
  → DELETE requirement_status_history WHERE requirement_id IN (...)
  → DELETE requirement_messages WHERE requirement_id IN (...)
  → DELETE requirements WHERE project_id = ?
  → DELETE projects WHERE id = ?
```

所有操作在同一事务中完成。

---

## 7. 配置

### 7.1 默认配置值

```typescript
const DEFAULTS = {
  analysisInterval: 'daily',
  requirementStatus: 'found',
  requirementSource: 'analyst',
  requirementPriority: 'normal',
  requirementReviewer: 'analyst',
  wikiLastUpdatedBy: 'analyst',
  taskStepStatus: 'pending',
  taskStepMaxRetries: 3,
  taskStepRetryCount: 0,
  messageMessageType: 'text',
};
```
