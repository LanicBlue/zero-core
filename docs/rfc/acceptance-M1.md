# M1 验收标准：数据基础

> **对应设计**: `design-M1.md`
> **对应计划**: `plan-M1.md`

---

## 1. 前置条件

- [ ] 项目可正常 `npm run build:lib`，TypeScript 编译无错误
- [ ] 项目可正常 `npm run build`（含 Electron 打包）
- [ ] 启动 App 后 SQLite 文件自动创建

---

## 2. 数据库迁移

### AC-1.1: 新表自动创建

**步骤**:
1. 删除现有 SQLite 数据库文件
2. 启动 App
3. 用 SQLite 工具打开数据库文件

**预期**:
- [ ] `projects` 表存在，列定义与设计文档一致
- [ ] `project_wiki` 表存在，含 `UNIQUE(project_id, path)` 约束
- [ ] `requirements` 表存在，含 `DEFAULT 'found'` 状态默认值
- [ ] `requirement_status_history` 表存在
- [ ] `task_steps` 表存在，含 `DEFAULT 0` 的 retry_count
- [ ] `requirement_messages` 表存在

### AC-1.2: 索引创建

**预期**:
- [ ] `idx_projects_status` 索引存在
- [ ] `idx_wiki_project` 索引存在
- [ ] `idx_wiki_parent` 索引存在
- [ ] `idx_req_project` 索引存在
- [ ] `idx_req_status` 索引存在
- [ ] `idx_rsh_req` 索引存在
- [ ] `idx_steps_req` 索引存在
- [ ] `idx_msg_req` 索引存在

### AC-1.3: 幂等安全

**步骤**:
1. 启动 App → 停止 → 再次启动

**预期**:
- [ ] 重复启动不报错
- [ ] `CREATE TABLE IF NOT EXISTS` 和 `safeAddIndex` 幂等执行
- [ ] 已有数据不丢失

### AC-1.4: 列名映射

**验证**:
- [ ] `PROJECT_COLUMNS` 使用 snake_case，与 SQLite 列名一一对应
- [ ] `SqliteStore<T>` 自动完成 camelCase ↔ snake_case 转换
- [ ] Store CRUD 操作后读取的数据字段为 camelCase

---

## 3. 项目 CRUD

### AC-2.1: 创建项目

**请求**: `POST /api/projects`
```json
{ "name": "test-project", "path": "/tmp/test-project", "analysisInterval": "daily" }
```

**预期**:
- [ ] 返回 201，body 含 `id`、`status: "active"`、`createdAt`、`updatedAt`
- [ ] `path` 在数据库中存储为 `/tmp/test-project`
- [ ] 未传的字段使用默认值

### AC-2.2: 路径唯一约束

**步骤**:
1. 创建项目 A，path="/tmp/proj"
2. 再创建项目 B，path="/tmp/proj"

**预期**:
- [ ] 第二次返回 409 Conflict
- [ ] 错误信息包含 "already exists"

### AC-2.3: 列出项目

**请求**: `GET /api/projects`

**预期**:
- [ ] 返回 200，body 为数组
- [ ] 包含之前创建的项目

**筛选**:
- [ ] `GET /api/projects?status=active` 只返回 active 状态
- [ ] 无匹配时返回空数组 `[]`

### AC-2.4: 获取单个项目

**请求**: `GET /api/projects/:id`

**预期**:
- [ ] 存在时返回 200 + 完整 ProjectRecord
- [ ] 不存在时返回 404

### AC-2.5: 更新项目

**请求**: `PUT /api/projects/:id`
```json
{ "name": "renamed", "status": "paused" }
```

**预期**:
- [ ] 返回 200，`name` 和 `status` 已更新
- [ ] `updatedAt` 大于 `createdAt`

### AC-2.6: 删除项目（级联）

**步骤**:
1. 创建项目 P
2. 创建 Wiki 节点（属于 P）
3. 创建需求 R（属于 P）
4. 创建 task_step（属于 R）
5. 创建 status_history（属于 R）
6. 创建 message（属于 R）
7. `DELETE /api/projects/P`

**预期**:
- [ ] 返回 204
- [ ] Wiki 节点已删除
- [ ] 需求 R 已删除
- [ ] task_step 已删除
- [ ] status_history 已删除
- [ ] message 已删除
- [ ] 项目 P 已删除

---

## 4. 需求 CRUD

### AC-3.1: 创建需求

**请求**: `POST /api/requirements`
```json
{
  "projectId": "proj_xxx",
  "title": "支付集成",
  "description": "集成微信支付",
  "priority": "high",
  "source": "user"
}
```

**预期**:
- [ ] 返回 201
- [ ] `status` 默认为 `"found"`
- [ ] 自动生成 `id`、`createdAt`、`updatedAt`
- [ ] 自动创建一条 status_history（from=NULL, to='found', triggeredBy=source）

### AC-3.2: 列出需求（筛选）

**步骤**:
1. 创建需求 R1（projectA, status=found, priority=high）
2. 创建需求 R2（projectA, status=ready, priority=normal）
3. 创建需求 R3（projectB, status=found, priority=low）

**预期**:
- [ ] `GET /api/requirements?projectId=projectA` → [R1, R2]
- [ ] `GET /api/requirements?status=found` → [R1, R3]
- [ ] `GET /api/requirements?priority=high` → [R1]
- [ ] `GET /api/requirements?projectId=projectA&status=ready` → [R2]

### AC-3.3: 状态流转（正常）

**请求**: `PUT /api/requirements/:id/status`
```json
{ "toStatus": "discuss", "triggeredBy": "user", "comment": "开始讨论" }
```

**预期**:
- [ ] 返回 200，含更新后的 requirement 和 historyEntry
- [ ] requirement.status 变为 "discuss"
- [ ] historyEntry: { fromStatus: "found", toStatus: "discuss", triggeredBy: "user" }
- [ ] 新增一条 requirement_messages（type='status_change'）

### AC-3.4: 状态流转（非法）

**请求**: `PUT /api/requirements/:id/status`（当前状态=found）
```json
{ "toStatus": "build", "triggeredBy": "user" }
```

**预期**:
- [ ] 返回 400
- [ ] 错误信息包含 "Invalid transition"
- [ ] 错误信息包含合法目标列表（validTargets）
- [ ] 需求状态不变

### AC-3.5: 取消需求（特殊流转）

**步骤**:
1. 创建需求（status=found）
2. 依次流转到 discuss → ready → plan → build
3. 从 build 状态发起 cancel

**请求**: `PUT /api/requirements/:id/status`
```json
{ "toStatus": "cancelled", "triggeredBy": "user" }
```

**预期**:
- [ ] 返回 200
- [ ] 任意状态都可由 user 转到 cancelled

### AC-3.6: 需求消息

**创建**: `POST /api/requirements/:id/messages`
```json
{ "sender": "user", "content": "需要考虑退款场景", "messageType": "text" }
```

**预期**:
- [ ] 返回 201
- [ ] `createdAt` 自动填充

**查询**: `GET /api/requirements/:id/messages`
- [ ] 返回消息列表，按 `created_at ASC` 排序
- [ ] 包含之前创建的消息

### AC-3.7: 执行步骤

**创建**: 创建 task_step
**查询**: `GET /api/requirements/:id/steps`
- [ ] 返回步骤列表，按 `step_order ASC` 排序

---

## 5. Wiki CRUD

### AC-4.1: 创建 Wiki 节点

**请求**: `POST /api/project-wiki/:projectId/nodes`
```json
{
  "nodeType": "directory",
  "path": "src/",
  "title": "src",
  "summary": "源代码根目录"
}
```

**预期**:
- [ ] 返回 201
- [ ] `projectId` 自动填充
- [ ] `lastUpdatedBy` 默认为 `"analyst"`

### AC-4.2: Wiki 路径唯一约束

**步骤**:
1. 创建节点 path="src/runtime/"
2. 在同一项目再创建 path="src/runtime/"

**预期**:
- [ ] 第二次返回 409

### AC-4.3: 节点层级

**步骤**:
1. 创建根节点：path="src/"
2. 创建子节点：path="src/runtime/"，parentId=根节点ID

**查询**: `GET /api/project-wiki/:projectId/nodes`
- [ ] 返回所有节点

**查询子节点**: `GET /api/project-wiki/:projectId/nodes?parentId=根节点ID`
- [ ] 只返回子节点

**查询顶层节点**: 使用 `getTopLevelNodes` 或 parentId 为空
- [ ] 只返回 parentId 为 NULL 的节点

### AC-4.4: 删除节点（级联）

**步骤**:
1. 创建父节点 P
2. 创建子节点 C1（parentId=P）
3. 创建孙节点 G1（parentId=C1）
4. `DELETE /api/project-wiki/node/P`

**预期**:
- [ ] P、C1、G1 全部删除

### AC-4.5: 按路径查询

**步骤**:
1. 创建节点 path="src/runtime/agent-loop.ts"
2. `GET` 按路径查询

**预期**:
- [ ] `getByPath(projectId, "src/runtime/agent-loop.ts")` 返回正确节点
- [ ] 路径不存在时返回 undefined

---

## 6. IPC 通道

### AC-5.1: IPC 全链路

**步骤**:
1. 从渲染进程调用 `api().projectsList()`
2. 调用 `api().projectsCreate({ name: "test", path: "/tmp/test" })`
3. 调用 `api().projectsGet(id)`
4. 调用 `api().projectsUpdate(id, { status: "paused" })`
5. 调用 `api().projectsDelete(id)`

**预期**:
- [ ] 每个调用返回正确结果
- [ ] IPC 通道名与 `IpcChannelDefs` 定义一致
- [ ] Preload 层正确暴露所有方法

### AC-5.2: IPC 类型安全

**预期**:
- [ ] `IpcChannelDefs` 中新增的通道有完整的类型签名
- [ ] `typedHandle` 在 handler 侧进行类型校验
- [ ] TypeScript 编译无类型错误

---

## 7. 集成验证

### AC-6.1: 完整数据流

**端到端流程**:
1. 创建项目 P
2. 为 P 创建 3 个 Wiki 节点（目录→文件→函数）
3. 创建需求 R1（属于 P）
4. R1 状态流转：found → discuss → ready
5. 为 R1 创建 2 个 task_step
6. 为 R1 添加 3 条消息
7. 查询 R1 的历史记录（应有 3 条）
8. 删除项目 P

**预期**:
- [ ] 每步操作返回正确状态码和数据
- [ ] 步骤 8 后所有关联数据清除

### AC-6.2: 并发安全

**步骤**:
1. 同时发起两个创建请求，使用相同 path

**预期**:
- [ ] 一个成功，一个返回 409
- [ ] 无数据损坏

---

## 8. 边界条件

| 场景 | 预期 |
|------|------|
| 创建需求时 projectId 不存在 | 返回 400 或 SQLite FK 错误 |
| 更新不存在的资源 | 返回 404 |
| 状态流转时 toStatus 与当前相同 | 返回 400（无意义流转） |
| task_step 的 step_order 重复 | 允许（由调用方保证顺序） |
| Wiki 节点的 parentId 引用自身 | SQLite FK 约束不阻止，需应用层校验 |
| 删除 Wiki 中间节点 | 级联删除所有子孙节点 |
| 需求 description/context 含特殊字符 | 正确存储和返回（JSON 序列化安全） |
| 空数据库查询 | 返回空数组 `[]`，不返回 null |

---

## 9. Smoke Test 清单

M1 完成的最低验证标准：

- [ ] `npm run build:lib` 编译通过
- [ ] `npm run build` 全量构建通过
- [ ] 启动 App 无报错
- [ ] SQLite 包含 6 张新表 + 8 个索引
- [ ] `POST /api/projects` → 201
- [ ] `POST /api/requirements` → 201
- [ ] `PUT /api/requirements/:id/status` → 状态流转成功
- [ ] `PUT /api/requirements/:id/status` (非法) → 400
- [ ] `POST /api/project-wiki/:pid/nodes` → 201
- [ ] `DELETE /api/projects/:id` → 级联删除成功
- [ ] 从渲染进程调用 `api().projectsList()` → 返回数组
