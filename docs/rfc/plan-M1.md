# M1 子计划：数据基础

> **状态**: 待实施
> **依赖**: 无
> **目标**: 所有数据表、Store、状态机和 API 就位，可通过 REST/IPC 测试完整数据流

---

## 实施步骤（按顺序）

### Step 1: 类型定义 — `src/shared/types.ts`

在文件末尾追加以下接口：

```typescript
// ── Multi-Agent Workflow Types ─────────────────────────────────

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  analystCronId?: string;
  analystSessionId?: string;
  lastAnalysisAt?: string;
  analysisInterval: string;       // 'daily' | 'hourly' | custom cron
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
}

export type RequirementStatus =
  | "found" | "discuss" | "ready" | "plan"
  | "build" | "verify" | "closed" | "cancelled";
export type RequirementPriority = "low" | "normal" | "high" | "critical";
export type RequirementSource = "analyst" | "user";

export interface RequirementRecord {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: RequirementStatus;
  source: RequirementSource;
  priority: RequirementPriority;
  impactScope?: string;
  context?: string;               // JSON
  assignedLeadSessionId?: string;
  discussionSessionId?: string;
  reviewer: "analyst" | "user";
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementStatusHistory {
  id: string;
  requirementId: string;
  fromStatus?: RequirementStatus;
  toStatus: RequirementStatus;
  triggeredBy: "analyst" | "user" | "lead" | "system";
  comment?: string;
  createdAt: string;
}

export type TaskStepRole = "developer" | "reviewer" | "qa";
export type TaskStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface TaskStepRecord {
  id: string;
  requirementId: string;
  stepOrder: number;
  role: TaskStepRole;
  title: string;
  description?: string;
  agentConfig?: string;           // JSON
  status: TaskStepStatus;
  input?: string;                 // JSON
  output?: string;                // JSON
  reviewResult?: "approved" | "rejected";
  reviewComment?: string;
  retryCount: number;
  maxRetries: number;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type WikiNodeType = "directory" | "file" | "function" | "class" | "section";

export interface ProjectWikiNode {
  id: string;
  projectId: string;
  parentId?: string;
  nodeType: WikiNodeType;
  path: string;
  title: string;
  summary?: string;
  detail?: string;
  lastUpdatedBy: "analyst" | "user";
  sourceReqId?: string;
  createdAt: string;
  updatedAt: string;
}

export type RequirementMessageSender =
  | "user" | "analyst" | "lead" | "developer" | "reviewer" | "qa";
export type RequirementMessageType =
  | "text" | "status_change" | "approval_request" | "notification";

export interface RequirementMessage {
  id: string;
  requirementId: string;
  sender: RequirementMessageSender;
  content: string;
  messageType: RequirementMessageType;
  metadata?: string;              // JSON
  createdAt: string;
}
```

---

### Step 2: 数据库迁移 — `src/server/db-migration.ts`

在 `AGENT_TOOL_COLUMNS` 后面追加 6 组列定义常量，在 `runMigrations()` 中追加 CREATE TABLE + 索引。

**新增 COLUMNS 常量**（在 L76 后）：

- `PROJECT_COLUMNS`
- `PROJECT_WIKI_COLUMNS`
- `REQUIREMENT_COLUMNS`
- `REQUIREMENT_STATUS_HISTORY_COLUMNS`
- `TASK_STEPS_COLUMNS`
- `REQUIREMENT_MESSAGES_COLUMNS`

**在 `runMigrations()` 的 column migrations 段末尾**追加：

```typescript
// ─── Multi-Agent Workflow tables ───────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
  analyst_cron_id TEXT, analyst_session_id TEXT, last_analysis_at TEXT,
  analysis_interval TEXT DEFAULT 'daily', status TEXT DEFAULT 'active',
  created_at TEXT, updated_at TEXT
)`);
safeAddIndex(db, "projects", "idx_projects_status", "status");

db.exec(`CREATE TABLE IF NOT EXISTS project_wiki (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  parent_id TEXT REFERENCES project_wiki(id),
  node_type TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL,
  summary TEXT, detail TEXT, last_updated_by TEXT DEFAULT 'analyst',
  source_req_id TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(project_id, path)
)`);
safeAddIndex(db, "project_wiki", "idx_wiki_project", "project_id");
safeAddIndex(db, "project_wiki", "idx_wiki_parent", "parent_id");

db.exec(`CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'found',
  source TEXT DEFAULT 'analyst', priority TEXT DEFAULT 'normal',
  impact_scope TEXT, context TEXT,
  assigned_lead_session_id TEXT, discussion_session_id TEXT,
  reviewer TEXT DEFAULT 'analyst',
  closed_at TEXT, created_at TEXT, updated_at TEXT
)`);
safeAddIndex(db, "requirements", "idx_req_project", "project_id");
safeAddIndex(db, "requirements", "idx_req_status", "status");

db.exec(`CREATE TABLE IF NOT EXISTS requirement_status_history (
  id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES requirements(id),
  from_status TEXT, to_status TEXT NOT NULL, triggered_by TEXT NOT NULL,
  comment TEXT, created_at TEXT
)`);
safeAddIndex(db, "requirement_status_history", "idx_rsh_req", "requirement_id");

db.exec(`CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES requirements(id),
  step_order INTEGER NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT, agent_config TEXT,
  status TEXT DEFAULT 'pending', input TEXT, output TEXT,
  review_result TEXT, review_comment TEXT,
  retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  session_id TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT, updated_at TEXT
)`);
safeAddIndex(db, "task_steps", "idx_steps_req", "requirement_id");

db.exec(`CREATE TABLE IF NOT EXISTS requirement_messages (
  id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES requirements(id),
  sender TEXT NOT NULL, content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text', metadata TEXT, created_at TEXT
)`);
safeAddIndex(db, "requirement_messages", "idx_msg_req", "requirement_id");
```

---

### Step 3: Store 类 — 4 个新文件

每个 Store 遵循 `agent-store.ts` 模式：构造函数接收 `SessionDB`，内部创建 `SqliteStore<T>`，暴露 CRUD + 领域查询方法。

#### 3.1 `src/server/project-store.ts`

```
COLUMNS: name, path, analyst_cron_id, analyst_session_id, last_analysis_at, analysis_interval, status, created_at, updated_at
CRUD: list, get, create, update, delete
领域: getByPath, listActive
```

#### 3.2 `src/server/project-wiki-store.ts`

```
COLUMNS: project_id, parent_id, node_type, path, title, summary, detail, last_updated_by, source_req_id, created_at, updated_at
CRUD: list, get, create, update, delete
领域: listByProject, getByPath, getChildren, getTopLevelNodes, getNodesByPaths, deleteByProject
```

#### 3.3 `src/server/requirement-store.ts`

```
内部包含 3 个 SqliteStore: requirements, requirement_status_history, requirement_messages
COLUMNS (requirements): project_id, title, description, status, source, priority, impact_scope, context(json), assigned_lead_session_id, discussion_session_id, reviewer, closed_at, created_at, updated_at
CRUD: list, get, create, update, delete
领域: listByProject, listByStatus, findReady
状态机: transitionStatus → 校验 + 更新 status + 写 history
消息: addMessage, getMessages
```

#### 3.4 `src/server/task-step-store.ts`

```
COLUMNS: requirement_id, step_order, role, title, description, agent_config(json), status, input(json), output(json), review_result, review_comment, retry_count, max_retries, session_id, started_at, completed_at, error, created_at, updated_at
CRUD: list, get, create, update, delete
领域: listByRequirement(ordered), getCurrentStep, getCompletedCount, deleteByRequirement
```

---

### Step 4: 需求状态机 — `src/server/requirement-state-machine.ts`

纯函数模块，无类：

- `VALID_TRANSITIONS` 常量数组定义所有合法流转
- `isValidTransition(from, to, triggeredBy)` → boolean
- `getNextStatuses(current, triggeredBy)` → RequirementStatus[]
- `anyStatusToCancelled` → 特殊规则：任意状态都可由 user 转到 cancelled

---

### Step 5: Router — 3 个新文件

#### 5.1 `src/server/project-router.ts`

遵循 `agent-router.ts` 的 `createXxxRouter(deps) → Router` 模式。

路由：
- `GET /` → list
- `POST /` → create
- `GET /:id` → get
- `PUT /:id` → update
- `DELETE /:id` → delete（级联删 wiki + requirements）
- `POST /:id/trigger-analysis` → 占位，M2 实现

#### 5.2 `src/server/requirement-router.ts`

路由：
- `GET /` → list（支持 `?projectId=&status=` 查询参数）
- `POST /` → create
- `GET /:id` → get
- `PUT /:id` → update
- `PUT /:id/status` → transitionStatus（校验状态机）
- `GET /:id/history` → getStatusHistory
- `GET /:id/messages` → getMessages
- `POST /:id/messages` → addMessage
- `GET /:id/steps` → listByRequirement

#### 5.3 `src/server/project-wiki-router.ts`

路由：
- `GET /:projectId/nodes` → listByProject
- `GET /node/:id` → get
- `POST /:projectId/nodes` → create
- `PUT /node/:id` → update
- `DELETE /node/:id` → delete

---

### Step 6: IPC 通道 — `src/shared/ipc-api.ts`

在 `IpcChannelDefs` 中追加：

```
"projects:list" / "projects:get" / "projects:create" / "projects:update" / "projects:delete"
"requirements:list" / "requirements:get" / "requirements:create" / "requirements:update"
"requirements:transition" / "requirements:history" / "requirements:messages" / "requirements:addMessage"
"requirements:steps"
"wiki:listByProject" / "wiki:getNode" / "wiki:createNode" / "wiki:updateNode" / "wiki:deleteNode"
```

---

### Step 7: IPC Handler — 3 个新文件

#### 7.1 `src/main/ipc/project-handlers.ts`

使用 `registerCrud` 模式（同 `agent-handlers.ts`）。

#### 7.2 `src/main/ipc/requirement-handlers.ts`

混合 `registerCrud` + `typedHandle`（状态流转、消息）。

#### 7.3 `src/main/ipc/wiki-handlers.ts`

`typedHandle` 自定义 handlers。

---

### Step 8: 集成接线

#### 8.1 `src/main/ipc/types.ts`

在 `IpcContext` 中追加字段：
```typescript
projectStore: ProjectStore;
requirementStore: RequirementStore;
wikiStore: ProjectWikiStore;
taskStepStore: TaskStepStore;
```

#### 8.2 `src/main/ipc/core.ts`（或 `ipc.ts`）

- 初始化 4 个新 Store
- 注册 3 个新 handler 模块

#### 8.3 `src/server/index.ts`

在 `runMigrations(sessionDB)` 后实例化新 Store，在 Mount API routers 段追加：
```typescript
app.use("/api/projects", createProjectRouter({ projectStore, requirementStore, wikiStore }));
app.use("/api/requirements", createRequirementRouter({ requirementStore, taskStepStore }));
app.use("/api/project-wiki", createWikiRouter({ wikiStore }));
```

#### 8.4 `src/preload/index.ts`

暴露新 IPC 方法给渲染进程。

---

## 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **修改** | `src/shared/types.ts` | 追加 7 个接口 |
| **修改** | `src/server/db-migration.ts` | 追加 6 组 COLUMNS + CREATE TABLE + 索引 |
| **新建** | `src/server/project-store.ts` | ProjectStore |
| **新建** | `src/server/project-wiki-store.ts` | ProjectWikiStore |
| **新建** | `src/server/requirement-store.ts` | RequirementStore (含状态机 + 消息) |
| **新建** | `src/server/task-step-store.ts` | TaskStepStore |
| **新建** | `src/server/requirement-state-machine.ts` | 状态校验模块 |
| **新建** | `src/server/project-router.ts` | 项目 API |
| **新建** | `src/server/requirement-router.ts` | 需求 API |
| **新建** | `src/server/project-wiki-router.ts` | Wiki API |
| **修改** | `src/shared/ipc-api.ts` | 新增 IPC 通道 |
| **新建** | `src/main/ipc/project-handlers.ts` | 项目 IPC |
| **新建** | `src/main/ipc/requirement-handlers.ts` | 需求 IPC |
| **新建** | `src/main/ipc/wiki-handlers.ts` | Wiki IPC |
| **修改** | `src/main/ipc/types.ts` | IpcContext 扩展 |
| **修改** | `src/main/ipc/core.ts`（或 `ipc.ts`） | 注册新模块 |
| **修改** | `src/server/index.ts` | 实例化 Store + 挂载 Router |
| **修改** | `src/preload/index.ts` | 暴露新 IPC |

---

## 验证

1. `npm run build:lib` — TypeScript 编译通过
2. 启动 App，SQLite 文件中应包含 6 张新表
3. curl 测试 CRUD：
   - `POST /api/projects` → 创建项目
   - `POST /api/requirements` → 创建需求
   - `PUT /api/requirements/:id/status` → 状态流转（found → discuss → ready）
   - `GET /api/requirements?status=ready` → 按状态筛选
   - `POST /api/project-wiki/:projectId/nodes` → 创建 Wiki 节点
4. IPC 测试：从 renderer 调用 `api().projectsList()` 等方法
