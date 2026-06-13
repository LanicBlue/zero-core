# M4 子计划：看板 UI + 对话集成

> **状态**: 待实施
> **依赖**: M1, M2
> **目标**: 用户通过看板管理需求、浏览 Wiki、在主聊天窗口讨论需求
> **可并行**: 与 M3 并行开发

---

## 实施步骤

### Step 1: 页面路由扩展 — `src/renderer/store/page-store.ts`

扩展 `activePage` 类型和 `setActivePage` 参数：

```typescript
interface PageState {
  activePage: "dashboard" | "chat" | "agents" | "settings" | "mcp"
            | "skills" | "knowledge" | "tools"
            | "requirements" | "wiki";  // ← 新增
  setActivePage: (page: ...) => void;
}
```

---

### Step 2: 渲染进程 Store — 3 个新文件

#### 2.1 `src/renderer/store/project-store.ts`

遵循 `agent-store.ts` 模式的 Zustand store：

```typescript
interface ProjectState {
  projects: ProjectRecord[];
  loading: boolean;
  fetchProjects: () => Promise<void>;
  createProject: (input) => Promise<ProjectRecord>;
  updateProject: (id, input) => Promise<void>;
  removeProject: (id) => Promise<void>;
}
```

#### 2.2 `src/renderer/store/requirement-store.ts`

```typescript
interface RequirementState {
  requirements: RequirementRecord[];
  stepsByReq: Record<string, TaskStepRecord[]>;
  messagesByReq: Record<string, RequirementMessage[]>;
  filter: { projectId?: string; status?: string };
  loading: boolean;

  fetchRequirements: (filter?) => Promise<void>;
  createRequirement: (input) => Promise<RequirementRecord>;
  transitionStatus: (id, toStatus, comment?) => Promise<void>;
  fetchSteps: (reqId) => Promise<void>;
  fetchMessages: (reqId) => Promise<void>;
  sendMessage: (reqId, content) => Promise<void>;

  // 过滤后的需求列表
  getFilteredRequirements: () => RequirementRecord[];
  // 按状态分组（看板列）
  getGroupedByStatus: () => Record<RequirementStatus, RequirementRecord[]>;
}
```

#### 2.3 `src/renderer/store/wiki-store.ts`

```typescript
interface WikiState {
  nodesByProject: Record<string, ProjectWikiNode[]>;
  selectedNodeId: string | null;
  expandedDetail: string | null;  // 展开的节点详细内容
  loading: boolean;

  fetchWikiTree: (projectId) => Promise<void>;
  selectNode: (nodeId) => void;
  expandNode: (nodeId) => Promise<void>;  // 获取 detail
  updateNode: (nodeId, data) => Promise<void>;
}
```

---

### Step 3: Preload 暴露 — `src/preload/index.ts`

在 `contextBridge.exposeInMainWorld` 中追加新的 API 方法：

```typescript
projectsList: () => api("projects:list"),
projectsCreate: (input) => api("projects:create", input),
projectsUpdate: (id, input) => api("projects:update", [id, input]),
projectsDelete: (id) => api("projects:delete", [id]),

requirementsList: (filter?) => api("requirements:list", filter),
requirementsCreate: (input) => api("requirements:create", input),
requirementsUpdate: (id, input) => api("requirements:update", [id, input]),
requirementsTransition: (id, to, comment?) => api("requirements:transition", [id, to, comment]),
requirementsHistory: (id) => api("requirements:history", [id]),
requirementsMessages: (id) => api("requirements:messages", [id]),
requirementsAddMessage: (id, msg) => api("requirements:addMessage", [id, msg]),
requirementsSteps: (id) => api("requirements:steps", [id]),

wikiListByProject: (projectId) => api("wiki:listByProject", [projectId]),
wikiGetNode: (id) => api("wiki:getNode", [id]),
wikiCreateNode: (projectId, input) => api("wiki:createNode", [projectId, input]),
wikiUpdateNode: (id, input) => api("wiki:updateNode", [id, input]),
wikiDeleteNode: (id) => api("wiki:deleteNode", [id]),

leadPickup: (reqId) => api("lead:pickup", [reqId]),
leadProgress: (reqId) => api("lead:progress", [reqId]),
```

---

### Step 4: 看板页面 — `src/renderer/components/requirements/KanbanPage.tsx`

主需求管理页面。

**布局**:
```
┌──────────────────────────────────────────────┐
│ 需求池   [项目筛选▼] [+ 新建需求] [🔄 分析]   │
├──────────────────────────────────────────────┤
│ 💡发现  │ 💬讨论 │ ✅就绪 │ 📋规划 │ 🔨执行 │ ...
│ [卡片1] │ [卡片] │ [卡片] │ [卡片] │ [卡片] │
│ [卡片2] │       │ [卡片] │       │        │
│ [卡片3] │       │       │       │        │
└──────────────────────────────────────────────┘
```

**实现要点**:
- 从 `useRequirementStore` 获取 `getGroupedByStatus()`
- 每列是一个 `RequirementStatus`
- 列头部显示状态名 + 计数
- 列内卡片列表
- 顶部工具栏：项目筛选下拉、新建需求按钮、触发分析按钮

---

### Step 5: 需求卡片 — `src/renderer/components/requirements/RequirementCard.tsx`

每张卡片显示：
- 标题
- 优先级标记（颜色：low=灰, normal=蓝, high=橙, critical=红）
- 来源图标（analyst=🤖, user=👤）
- 时间（"2h ago" 格式）
- 执行状态摘要（Build 状态时显示当前步骤）

**点击行为**:
- `found` 状态 → 跳转主聊天，注入讨论消息
- `discuss` 状态 → 跳转主聊天，打开该需求的对话
- `build` / `verify` 状态 → 展开执行详情面板
- 其他状态 → 打开详情弹窗

---

### Step 6: 新建需求弹窗 — `src/renderer/components/requirements/CreateRequirementModal.tsx`

表单字段：
- 标题（必填）
- 描述（文本域）
- 优先级（下拉选择）
- 归属项目（下拉选择，从 projectStore 获取）

提交后调用 `requirementStore.createRequirement()`，刷新看板。

---

### Step 7: 需求上下文头 — `src/renderer/components/requirements/RequirementHeader.tsx`

嵌入主聊天窗口顶部的需求信息条：

```
📋 支付集成功能  💬讨论  优先级: high  [✅ 确认就绪]  [← 返回看板]
```

显示：需求标题、当前状态 badge、优先级标记。
操作按钮：确认就绪（discuss→ready）、返回看板。

---

### Step 8: 聊天窗口集成 — `src/renderer/components/layout/ChatPanel.tsx`

修改以支持需求讨论模式：

1. 新增状态：`activeRequirementId: string | null`
2. 当从看板跳转来时：
   ```typescript
   // 看板卡片点击时
   setActivePage("chat");
   setActiveRequirementId(requirementId);
   // 激活 Analyst Agent 的 session
   activateAgentSession(analystAgentId, discussionSessionId);
   // 自动发送讨论消息
   chatSend(`我想讨论需求：${requirement.title}\n${requirement.description}`);
   ```
3. 聊天顶部条件渲染 `<RequirementHeader />`
4. 退出需求讨论时清除 `activeRequirementId`

---

### Step 9: 执行详情面板 — `src/renderer/components/requirements/ExecutionDetailPanel.tsx`

展示需求处于 Build/Verify 状态时的执行详情：

```
📋 执行步骤
  Step 1: Dev — 实现微信支付       ✅ 完成
  Step 2: Dev — 回调幂等处理       ✅ 完成
  Step 3: Reviewer — 代码审查       ⣻ 执行中
  Step 4: QA — 测试                 ○ 等待

📊 日志
  14:28 Reviewer 开始审查...
  14:15 Dev 完成回调幂等
```

可以嵌入看板卡片展开区域，或作为独立面板。

---

### Step 10: Wiki 浏览器 — 3 个新文件

#### 10.1 `src/renderer/components/wiki/WikiPage.tsx`

左右分栏布局：
- 左：WikiTree（目录树 + 固定节点）
- 右：WikiDetail（选中节点的详情）

顶部：项目选择下拉、刷新按钮。

#### 10.2 `src/renderer/components/wiki/WikiTree.tsx`

递归树组件，渲染 Wiki 节点层级。

每个节点显示：
- 图标（目录📁 / 文件📄 / 函数⚙ / 类📦 / 章节📝）
- 标题（summary 摘要）
- 展开/收起子节点
- 点击选中

#### 10.3 `src/renderer/components/wiki/WikiDetail.tsx`

右侧详情面板：

```
src/runtime/agent-loop.ts
─────────────────────────
AgentLoop 是核心执行引擎...

▸ 关键函数
  ├ run() — 主循环入口
  ├ handleToolCall() — 工具调度
  └ compress() — 上下文压缩

▸ 依赖
  ├ → core/config
  └ → runtime/tools

[展开完整内容]  [📝 编辑]
```

---

### Step 11: 侧边栏导航 — `src/renderer/components/layout/IconSidebar.tsx`

新增两个导航按钮：
- "需求" (📋 图标) → `setActivePage("requirements")`
- "Wiki" (📖 图标) → `setActivePage("wiki")`

---

### Step 12: App 布局集成 — `src/renderer/components/layout/AppLayout.tsx`

在 page overlay 区域追加：

```tsx
{activePage === "requirements" && <KanbanPage />}
{activePage === "wiki" && <WikiPage />}
```

---

## 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **修改** | `src/renderer/store/page-store.ts` | 新增 requirements/wiki 页面 |
| **新建** | `src/renderer/store/project-store.ts` | 项目 Zustand Store |
| **新建** | `src/renderer/store/requirement-store.ts` | 需求 Zustand Store |
| **新建** | `src/renderer/store/wiki-store.ts` | Wiki Zustand Store |
| **修改** | `src/preload/index.ts` | 暴露新 API |
| **新建** | `src/renderer/components/requirements/KanbanPage.tsx` | 看板主页 |
| **新建** | `src/renderer/components/requirements/RequirementCard.tsx` | 需求卡片 |
| **新建** | `src/renderer/components/requirements/CreateRequirementModal.tsx` | 新建需求弹窗 |
| **新建** | `src/renderer/components/requirements/RequirementHeader.tsx` | 聊天需求上下文头 |
| **新建** | `src/renderer/components/requirements/ExecutionDetailPanel.tsx` | 执行详情 |
| **新建** | `src/renderer/components/wiki/WikiPage.tsx` | Wiki 浏览页 |
| **新建** | `src/renderer/components/wiki/WikiTree.tsx` | Wiki 树组件 |
| **新建** | `src/renderer/components/wiki/WikiDetail.tsx` | Wiki 详情组件 |
| **修改** | `src/renderer/components/layout/ChatPanel.tsx` | 需求讨论模式 |
| **修改** | `src/renderer/components/layout/IconSidebar.tsx` | 新增导航按钮 |
| **修改** | `src/renderer/components/layout/AppLayout.tsx` | 新页面渲染 |

---

## 验证

1. `npm run build` — 编译通过（含 renderer）
2. 启动 App
3. 侧边栏可见"需求"和"Wiki"图标
4. 点击"需求" → 看板页面，可见按状态分列的需求卡片
5. 点击 Found 状态的需求卡片 → 跳转聊天 → 自动注入讨论消息
6. 在聊天中确认需求就绪 → 回到看板 → 卡片移到"就绪"列
7. 点击"Wiki" → Wiki 浏览器 → 左侧树 + 右侧详情
8. 项目筛选功能正常
9. 新建需求弹窗可创建需求
