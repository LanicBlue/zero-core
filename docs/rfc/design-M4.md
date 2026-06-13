# M4 设计文档：看板 UI + 对话集成

> **版本**: 1.0
> **对应计划**: `plan-M4.md`
> **依赖**: M1（数据基础）, M2（角色系统）
> **可并行**: 与 M3 并行开发
> **目标**: 看板页面、Wiki 浏览器、聊天窗口需求讨论、执行详情面板

---

## 1. 组件架构

### 1.1 组件层次

```
AppLayout
├── IconSidebar                    // 修改：新增 📋需求 📖Wiki 按钮
├── ChatPanel                      // 修改：需求讨论模式
│   └── RequirementHeader          // 新增：聊天内需求上下文头
├── KanbanPage                     // 新增：看板主页面
│   ├── KanbanToolbar              // 筛选 + 新建 + 分析触发
│   │   └── CreateRequirementModal // 新增：新建需求弹窗
│   └── KanbanColumn[]             // 按状态分列
│       └── RequirementCard[]      // 需求卡片
│           └── ExecutionDetailPanel // 新增：执行详情展开
├── WikiPage                       // 新增：Wiki 浏览页
│   ├── WikiTree                   // 新增：左侧树
│   └── WikiDetail                 // 新增：右侧详情
└── (其他现有页面)
```

### 1.2 状态管理层次

```
page-store (Zustand)              // 修改：新增 requirements/wiki 页面
├── activePage
├── activeRequirementId           // 新增
└── activeWikiProjectId           // 新增

project-store (Zustand)           // 新增
├── projects: ProjectRecord[]
├── loading: boolean
├── fetchProjects()
├── createProject()
├── updateProject()
└── removeProject()

requirement-store (Zustand)       // 新增
├── requirements: RequirementRecord[]
├── stepsByReq: Record<string, TaskStepRecord[]>
├── messagesByReq: Record<string, RequirementMessage[]>
├── filter: { projectId?, status? }
├── loading: boolean
├── fetchRequirements()
├── createRequirement()
├── transitionStatus()
├── fetchSteps()
├── fetchMessages()
├── sendMessage()
├── getFilteredRequirements()
└── getGroupedByStatus()

wiki-store (Zustand)              // 新增
├── nodesByProject: Record<string, ProjectWikiNode[]>
├── selectedNodeId: string | null
├── expandedDetail: string | null
├── loading: boolean
├── fetchWikiTree()
├── selectNode()
├── expandNode()
└── updateNode()
```

---

## 2. 页面路由

### 2.1 PageState 扩展

```typescript
// src/renderer/store/page-store.ts

interface PageState {
  activePage:
    | "dashboard" | "chat" | "agents" | "settings" | "mcp"
    | "skills" | "knowledge" | "tools"
    | "requirements" | "wiki";          // ← 新增

  // 需求讨论模式状态
  activeRequirementId: string | null;   // ← 新增
  setActiveRequirementId: (id: string | null) => void;

  // Wiki 页面状态
  activeWikiProjectId: string | null;   // ← 新增
  setActiveWikiProjectId: (id: string | null) => void;

  setActivePage: (page: string) => void;
}
```

---

## 3. 看板页面

### 3.1 KanbanPage 布局

```
┌─────────────────────────────────────────────────────────────────┐
│ ◀ 返回  │  需求看板                  [项目筛选 ▼] [+ 新建] [🔄] │
├─────────┼──────────┼─────────┼─────────┼─────────┼──────────────┤
│ 💡 发现 │ 💬 讨论  │ ✅ 就绪  │ 📋 规划 │ 🔨 执行 │ 🔍 验证     │
│ (3)     │ (1)      │ (2)     │ (0)     │ (1)     │ (0)         │
├─────────┼──────────┼─────────┼─────────┼─────────┼──────────────┤
│ ┌─────┐ │ ┌─────┐ │ ┌─────┐ │         │ ┌─────┐ │              │
│ │ R1  │ │ │ R4  │ │ │ R2  │ │         │ │ R5  │ │              │
│ │high │ │ │norm │ │ │crit │ │         │ │ 🔄  │ │              │
│ │🤖   │ │ │👤  │ │ │🤖   │ │         │ │Step2│ │              │
│ │2h   │ │ │1d   │ │ │30m  │ │         │ │run  │ │              │
│ └─────┘ │ └─────┘ │ └─────┘ │         │ └─────┘ │              │
│ ┌─────┐ │         │ ┌─────┐ │         │         │              │
│ │ R3  │ │         │ │ R6  │ │         │         │              │
│ └─────┘ │         │ └─────┘ │         │         │              │
└─────────┴──────────┴─────────┴─────────┴─────────┴──────────────┘
```

### 3.2 列定义

```typescript
const KANBAN_COLUMNS: { status: RequirementStatus; icon: string; label: string; color: string }[] = [
  { status: 'found',      icon: '💡', label: '发现',   color: '#8B8B8B' },
  { status: 'discuss',    icon: '💬', label: '讨论',   color: '#2196F3' },
  { status: 'ready',      icon: '✅', label: '就绪',   color: '#4CAF50' },
  { status: 'plan',       icon: '📋', label: '规划',   color: '#9C27B0' },
  { status: 'build',      icon: '🔨', label: '执行',   color: '#FF9800' },
  { status: 'verify',     icon: '🔍', label: '验证',   color: '#00BCD4' },
  // closed 和 cancelled 不显示在看板中
];
```

### 3.3 RequirementCard 设计

```typescript
interface RequirementCardProps {
  requirement: RequirementRecord;
  currentStep?: TaskStepRecord;     // build 状态时的当前步骤
  onClick: (req: RequirementRecord) => void;
}
```

**卡片渲染**:
```
┌─────────────────────────┐
│ ● 支付集成功能           │  ← 标题（● 优先级色标）
│ priority: high          │  ← 色条
│ 🤖 analyst  |  2h ago   │  ← 来源 + 时间
│ 🔨 Step 2/4: Reviewer   │  ← 执行状态（build 时显示）
└─────────────────────────┘
```

**优先级色标**:
- `critical`: 红色 (#F44336)
- `high`: 橙色 (#FF9800)
- `normal`: 蓝色 (#2196F3)
- `low`: 灰色 (#9E9E9E)

**点击行为**:

| 状态 | 行为 |
|------|------|
| found | 跳转聊天，注入 "我想讨论需求：{title}\n{description}" |
| discuss | 跳转聊天，打开该需求的讨论 |
| ready | 显示需求详情（优先级、描述等）。Lead 空闲时自动按优先级领取执行 |
| plan | 展开执行详情面板，显示 Lead 正在规划 |
| build | 展开执行详情面板，显示实时步骤 |
| verify | 展开执行详情面板，显示验证报告 |

**Lead 自动领取机制**：
- ready 列的需求无需用户手动触发 Lead 领取
- Lead 空闲（无 `assignedLeadSessionId`）时，按 `priority` 降序（critical → low）自动领取
- 领取后需求自动从 ready → plan → build 流转
- 看板 UI 只展示状态变化，用户无需干预执行过程
- **未来扩展**：依赖关系图 + 执行日历，控制需求间的执行顺序和节奏

### 3.4 CreateRequirementModal

**表单字段**:

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| title | input | 是 | — | 需求标题 |
| description | textarea | 否 | — | 详细描述 |
| priority | select | 否 | normal | 优先级选择 |
| projectId | select | 是 | — | 从 projectStore 获取项目列表 |

**提交**:
- 调用 `requirementStore.createRequirement({ ...input, source: 'user' })`
- 关闭弹窗
- 刷新看板

---

## 4. 聊天窗口集成

### 4.1 RequirementHeader

嵌入聊天窗口顶部的信息条：

```
┌──────────────────────────────────────────────────────────────────┐
│ 📋 支付集成功能  │  💬讨论  │  🔴high  │  [✅ 确认就绪]  [← 返回] │
└──────────────────────────────────────────────────────────────────┘
```

```typescript
interface RequirementHeaderProps {
  requirement: RequirementRecord;
  onTransition: (toStatus: RequirementStatus) => void;
  onClose: () => void;
}
```

**状态相关按钮**:

| 当前状态 | 可用按钮 |
|----------|----------|
| found | "开始讨论" (→ discuss) |
| discuss | "确认就绪" (→ ready), "退回" (→ found) |
| ready | "返回看板" |
| plan/build | "查看执行详情" |
| verify | "验证通过" (→ closed), "返回执行" (→ build) |

### 4.2 ChatPanel 集成

```typescript
// ChatPanel 新增状态
const [activeReqId, setActiveReqId] = usePageStore(s => [s.activeRequirementId, s.setActiveRequirementId]);

// 条件渲染 RequirementHeader
{activeReqId && requirement && (
  <RequirementHeader
    requirement={requirement}
    onTransition={handleTransition}
    onClose={() => {
      setActiveReqId(null);
      setActivePage("requirements");
    }}
  />
)}
```

### 4.3 讨论消息注入

当用户从看板跳转到聊天讨论需求时：

```typescript
// RequirementCard onClick (found/discuss 状态)
const handleDiscussRequirement = (req: RequirementRecord) => {
  setActivePage("chat");
  setActiveRequirementId(req.id);

  // 激活 Analyst Agent 的 session
  const analystSessionId = /* 获取或创建 */;

  // 自动发送讨论消息
  const message = `我想讨论需求：${req.title}\n\n${req.description || ''}`;
  chatStore.sendMessage(message);

  // 记录到需求消息
  requirementStore.sendMessage(req.id, 'user', message);
};
```

---

## 5. 执行详情面板

### 5.1 ExecutionDetailPanel

```
┌──────────────────────────────────────────────────┐
│ 📋 执行步骤                                       │
├──────────────────────────────────────────────────┤
│ ① Dev — 实现微信支付接口         ✅ 完成  14:15  │
│ ② Dev — 回调幂等处理             ✅ 完成  14:22  │
│ ③ Reviewer — 代码审查            🔄 执行中       │
│ ④ QA — 功能测试                  ○ 等待          │
├──────────────────────────────────────────────────┤
│ 📊 实时日志                                       │
│   14:28 Reviewer 开始审查代码...                  │
│   14:22 Dev 完成回调幂等处理                      │
│   14:15 Dev 完成微信支付接口实现                   │
└──────────────────────────────────────────────────┘
```

```typescript
interface ExecutionDetailPanelProps {
  requirement: RequirementRecord;
  steps: TaskStepRecord[];
  messages: RequirementMessage[];
}
```

**步骤状态图标**:
- `pending`: ○（灰色）
- `running`: 🔄（蓝色动画）
- `completed`: ✅（绿色）
- `failed`: ❌（红色）
- `skipped`: ⊘（灰色）

**数据刷新**: build 状态时每 5s 轮询 `fetchSteps`（或 WebSocket 推送）

---

## 6. Wiki 浏览器

### 6.1 WikiPage 布局

```
┌──────────────────────────────────────────────────────────────┐
│ 📖 项目 Wiki       [项目选择 ▼]  [🔄 刷新]                    │
├────────────────────┬─────────────────────────────────────────┤
│ WikiTree (250px)   │ WikiDetail                               │
│                    │                                         │
│ 📁 src/            │ 📄 agent-loop.ts                        │
│   📁 runtime/      │ ─────────────────                       │
│     📄 agent-loop  │ AgentLoop 是核心执行引擎...              │
│     📄 subagent    │                                         │
│   📁 server/       │ ▸ 关键函数                               │
│     📄 agent-svc   │   ├ run() — 主循环入口                   │
│   📁 shared/       │   ├ handleToolCall() — 工具调度          │
│     📄 types       │   └ compress() — 上下文压缩             │
│                    │                                         │
│                    │ ▸ 依赖                                   │
│                    │   ├ → core/config                       │
│                    │   └ → runtime/tools                     │
│                    │                                         │
│                    │ [展开完整内容]  [📝 编辑]                  │
└────────────────────┴─────────────────────────────────────────┘
```

### 6.2 WikiTree

```typescript
interface WikiTreeProps {
  nodes: ProjectWikiNode[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}

// 递归渲染节点
// 每个节点显示：
//   - 图标（按 nodeType）
//   - 标题（node.title）
//   - 展开/收起子节点按钮
//   - 选中高亮
```

**节点图标映射**:
```typescript
const NODE_ICONS: Record<WikiNodeType, string> = {
  directory: '📁',
  file: '📄',
  function: '⚙️',
  class: '📦',
  section: '📝',
};
```

### 6.3 WikiDetail

```typescript
interface WikiDetailProps {
  node: ProjectWikiNode | null;
  onExpand: (nodeId: string) => void;
  onEdit: (nodeId: string, data: Partial<ProjectWikiNode>) => void;
}
```

**展示内容**:
- 路径（作为标题）
- summary（摘要区）
- 如果有 detail：显示 detail
- 如果 detail 为空：显示 [展开完整内容] 按钮，点击调用 `wikiStore.expandNode()`
- [编辑] 按钮打开编辑模式

---

## 7. Preload API

### 7.1 新增暴露方法

```typescript
// src/preload/index.ts

// Projects
projectsList: (filter?) => api("projects:list", filter),
projectsCreate: (input) => api("projects:create", input),
projectsUpdate: (id, input) => api("projects:update", [id, input]),
projectsDelete: (id) => api("projects:delete", [id]),

// Requirements
requirementsList: (filter?) => api("requirements:list", filter),
requirementsCreate: (input) => api("requirements:create", input),
requirementsUpdate: (id, input) => api("requirements:update", [id, input]),
requirementsTransition: (id, to, triggeredBy, comment?) => api("requirements:transition", [id, to, triggeredBy, comment]),
requirementsHistory: (id) => api("requirements:history", [id]),
requirementsMessages: (id) => api("requirements:messages", [id]),
requirementsAddMessage: (id, sender, content, type?) => api("requirements:addMessage", [id, sender, content, type]),
requirementsSteps: (id) => api("requirements:steps", [id]),

// Wiki
wikiListByProject: (projectId) => api("wiki:listByProject", [projectId]),
wikiGetNode: (id) => api("wiki:getNode", [id]),
wikiCreateNode: (projectId, input) => api("wiki:createNode", [projectId, input]),
wikiUpdateNode: (id, input) => api("wiki:updateNode", [id, input]),
wikiDeleteNode: (id) => api("wiki:deleteNode", [id]),

// Lead（查询进度用，领取由后端自动完成）
leadProgress: (reqId) => api("lead:progress", [reqId]),
```

**注意**：`lead:pickup` 不暴露给 UI。Lead 领取由后端自动完成：
后端在需求状态变为 `ready` 后检测 Lead 空闲，按优先级自动调用 `leadService.pickupRequirement()`。

---

## 8. 侧边栏导航

### 8.1 新增导航项

```
现有: Dashboard | Chat | Agents | Settings | ...
新增: 📋 需求 | 📖 Wiki
```

```typescript
// IconSidebar 新增两个按钮
<button onClick={() => setActivePage("requirements")}>
  <Icon name="kanban" /> {/* 或 📋 */}
  <span>需求</span>
</button>

<button onClick={() => setActivePage("wiki")}>
  <Icon name="book" /> {/* 或 📖 */}
  <span>Wiki</span>
</button>
```

---

## 9. App 布局集成

### 9.1 AppLayout 修改

```typescript
// src/renderer/components/layout/AppLayout.tsx

const { activePage } = usePageStore();

return (
  <div>
    <IconSidebar />
    <main>
      {/* 现有页面 */}
      {activePage === "chat" && <ChatPanel />}
      {activePage === "agents" && <AgentsPage />}
      {/* ... */}

      {/* 新增页面 */}
      {activePage === "requirements" && <KanbanPage />}
      {activePage === "wiki" && <WikiPage />}
    </main>
  </div>
);
```

---

## 10. 样式规范

### 10.1 颜色体系

```typescript
const COLORS = {
  priority: {
    critical: '#F44336',   // 红色
    high: '#FF9800',       // 橙色
    normal: '#2196F3',     // 蓝色
    low: '#9E9E9E',        // 灰色
  },
  status: {
    found: '#8B8B8B',      // 灰色
    discuss: '#2196F3',    // 蓝色
    ready: '#4CAF50',      // 绿色
    plan: '#9C27B0',       // 紫色
    build: '#FF9800',      // 橙色
    verify: '#00BCD4',     // 青色
    closed: '#4CAF50',     // 绿色
    cancelled: '#F44336',  // 红色
  },
  stepStatus: {
    pending: '#BDBDBD',    // 浅灰
    running: '#2196F3',    // 蓝色
    completed: '#4CAF50',  // 绿色
    failed: '#F44336',     // 红色
    skipped: '#9E9E9E',    // 灰色
  },
};
```

### 10.2 响应式

- 看板页面：列数根据窗口宽度自适应（最小 4 列，最大 7 列）
- Wiki 页面：左栏固定 250px，右栏自适应
- 卡片宽度：列内 100%，最小 150px

---

## 11. 错误处理

| 场景 | 处理 |
|------|------|
| 项目列表为空 | 看板显示空状态 + "创建项目"引导 |
| 需求列表为空 | 看板显示空列 + "触发分析"或"新建需求"引导 |
| Wiki 树为空 | Wiki 页面显示空状态 + "先进行项目分析"提示 |
| IPC 调用失败 | Toast 错误通知，不阻断 UI |
| 网络断开 | 离线状态提示，使用缓存数据 |
| 状态流转失败 | 显示错误信息，不自动重试 |
