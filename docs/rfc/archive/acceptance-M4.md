# M4 验收标准：看板 UI + 对话集成

> **对应设计**: `design-M4.md`
> **对应计划**: `plan-M4.md`
> **前置**: M1, M2 全部验收通过

---

## 1. 前置条件

- [ ] M1, M2 全部验收标准通过
- [ ] `npm run build:lib` 编译无错误
- [ ] `npm run build` 全量构建通过（含 renderer）
- [ ] App 可正常启动并显示主界面

---

## 2. 页面路由

### AC-2.1: 新页面类型

**验证**:
- [ ] `page-store.ts` 的 `activePage` 支持 `"requirements"` 和 `"wiki"`
- [ ] `activeRequirementId` 字段存在，初始值 `null`
- [ ] `activeWikiProjectId` 字段存在，初始值 `null`

### AC-2.2: 页面切换

**测试**:
1. 点击侧边栏"需求"图标
2. 点击侧边栏"Wiki"图标
3. 点击侧边栏"Chat"图标

**预期**:
- [ ] 步骤 1：显示看板页面
- [ ] 步骤 2：显示 Wiki 页面
- [ ] 步骤 3：显示聊天页面
- [ ] 页面切换无闪烁或报错

---

## 3. Zustand Store

### AC-3.1: ProjectStore

**验证**:
- [ ] `fetchProjects()` 调用 IPC `projects:list` 并填充 `projects`
- [ ] `createProject()` 调用 IPC `projects:create`
- [ ] `updateProject()` 调用 IPC `projects:update`
- [ ] `removeProject()` 调用 IPC `projects:delete`
- [ ] `loading` 状态在请求期间为 `true`

### AC-3.2: RequirementStore

**验证**:
- [ ] `fetchRequirements()` 调用 IPC `requirements:list`
- [ ] `createRequirement()` 调用 IPC `requirements:create`
- [ ] `transitionStatus()` 调用 IPC `requirements:transition`
- [ ] `fetchSteps()` 调用 IPC `requirements:steps` 并填充 `stepsByReq`
- [ ] `fetchMessages()` 调用 IPC `requirements:messages` 并填充 `messagesByReq`
- [ ] `sendMessage()` 调用 IPC `requirements:addMessage`

**计算属性**:
- [ ] `getFilteredRequirements()` 按 filter 返回过滤后的数组
- [ ] `getGroupedByStatus()` 返回 `Record<RequirementStatus, RequirementRecord[]>`

### AC-3.3: WikiStore

**验证**:
- [ ] `fetchWikiTree()` 调用 IPC `wiki:listByProject` 并填充 `nodesByProject`
- [ ] `selectNode()` 更新 `selectedNodeId`
- [ ] `expandNode()` 调用 IPC `wiki:getNode` 获取 detail 并更新 `expandedDetail`
- [ ] `updateNode()` 调用 IPC `wiki:updateNode`

---

## 4. 看板页面

### AC-4.1: 页面渲染

**前置**: 创建项目 P，需求 R1(found), R2(discuss), R3(ready)

**预期**:
- [ ] 页面顶部工具栏可见：项目筛选下拉 + 新建按钮 + 分析触发按钮
- [ ] 看板按状态分列显示
- [ ] 每列显示状态名 + 图标 + 计数
- [ ] R1 出现在"发现"列
- [ ] R2 出现在"讨论"列
- [ ] R3 出现在"就绪"列
- [ ] "规划"/"执行"/"验证"列为空

### AC-4.2: 项目筛选

**前置**: 创建项目 P1(有需求) 和 P2(有需求)

**测试**: 在项目筛选下拉选择 P1

**预期**:
- [ ] 只显示 P1 的需求
- [ ] P2 的需求隐藏

### AC-4.3: 需求卡片渲染

**验证需求卡片内容**:
- [ ] 显示需求标题
- [ ] 优先级色标正确（high=橙色）
- [ ] 来源图标正确（analyst=🤖, user=👤）
- [ ] 时间显示（如 "2h ago"）

### AC-4.4: 空状态

**前置**: 无需求

**预期**:
- [ ] 看板列显示空
- [ ] 有引导提示（"触发分析"或"新建需求"）

---

## 5. 新建需求弹窗

### AC-5.1: 弹窗打开

**测试**: 点击看板顶部 "+ 新建" 按钮

**预期**:
- [ ] 弹窗打开
- [ ] 表单包含：标题、描述、优先级选择、项目选择

### AC-5.2: 提交

**步骤**:
1. 填写标题："测试需求"
2. 填写描述："测试描述"
3. 选择优先级：high
4. 选择项目：P
5. 点击提交

**预期**:
- [ ] 弹窗关闭
- [ ] 看板"发现"列出现新卡片
- [ ] 卡片标题为 "测试需求"
- [ ] 卡片优先级色标为橙色（high）

### AC-5.3: 校验

**测试**: 不填标题，直接提交

**预期**:
- [ ] 标题字段显示必填错误
- [ ] 不提交
- [ ] 弹窗不关闭

---

## 6. 需求卡片点击行为

### AC-6.1: found 状态 — 跳转聊天

**前置**: 需求 R1（status=found, title="支付集成"）

**测试**: 点击 R1 卡片

**预期**:
- [ ] 页面切换到聊天
- [ ] 聊天顶部显示 `<RequirementHeader />`
- [ ] Header 显示 "支付集成" + 💡发现 + 状态 badge
- [ ] 自动发送消息 "我想讨论需求：支付集成..."
- [ ] `activeRequirementId` 已设置

### AC-6.2: discuss 状态 — 继续讨论

**前置**: 需求 R2（status=discuss）

**测试**: 点击 R2 卡片

**预期**:
- [ ] 页面切换到聊天
- [ ] Header 显示 "确认就绪" 按钮
- [ ] 显示之前的讨论消息

### AC-6.3: build 状态 — 执行详情

**前置**: 需求 R5（status=build），有 task_steps

**测试**: 点击 R5 卡片

**预期**:
- [ ] 展开执行详情面板
- [ ] 显示步骤列表（developer → reviewer → qa）
- [ ] 当前执行步骤高亮
- [ ] 已完成步骤显示 ✅

---

## 7. 聊天窗口集成

### AC-7.1: RequirementHeader 显示

**前置**: 从看板跳转到需求讨论

**预期**:
- [ ] Header 在聊天消息列表上方
- [ ] 显示需求标题 + 当前状态 badge + 优先级
- [ ] 有"返回看板"按钮

### AC-7.2: 确认就绪

**前置**: 需求在 discuss 状态

**测试**: 点击 Header 中"确认就绪"按钮

**预期**:
- [ ] 需求状态变为 ready
- [ ] Header 按钮更新
- [ ] 看板中卡片移到"就绪"列

### AC-7.3: 退出需求讨论

**测试**: 点击 Header 中"返回看板"按钮

**预期**:
- [ ] 页面切换到看板
- [ ] `activeRequirementId` 清除
- [ ] Header 不再显示

---

## 8. 执行详情面板

### AC-8.1: 步骤列表

**前置**: 需求在 build 状态，有 4 个 task_steps（2 completed, 1 running, 1 pending）

**预期**:
- [ ] 显示 4 个步骤
- [ ] 已完成步骤显示 ✅ + 完成时间
- [ ] 执行中步骤显示 🔄
- [ ] 等待步骤显示 ○
- [ ] 步骤按 step_order 排列

### AC-8.2: 日志显示

**预期**:
- [ ] 日志区域显示步骤消息
- [ ] 日志按时间倒序排列
- [ ] 包含角色和时间信息

### AC-8.3: 实时刷新

**前置**: 需求在 build 状态

**预期**:
- [ ] 步骤状态每 5s 刷新一次
- [ ] 步骤完成后状态图标自动更新

---

## 9. Wiki 浏览器

### AC-9.1: 页面渲染

**前置**: 项目 P 有 Wiki 节点（冷启动后）

**预期**:
- [ ] 左侧显示 Wiki 树（250px 宽）
- [ ] 右侧显示详情区
- [ ] 顶部有项目选择下拉

### AC-9.2: Wiki 树导航

**测试**: 点击树中的节点

**预期**:
- [ ] 节点高亮选中
- [ ] 右侧显示该节点的 summary
- [ ] 目录节点显示展开/收起图标
- [ ] 子节点在父节点展开时显示

### AC-9.3: 节点详情

**前置**: 选中节点有 detail

**预期**:
- [ ] 显示完整 detail 内容
- [ ] 如果 detail 为空，显示 [展开完整内容] 按钮

### AC-9.4: 展开节点

**前置**: 选中节点 summary 有值但 detail 为空

**测试**: 点击 [展开完整内容]

**预期**:
- [ ] 调用 IPC 获取 detail
- [ ] detail 区域加载并显示
- [ ] 按钮变为 [收起]

### AC-9.5: 空状态

**前置**: 项目没有 Wiki 节点

**预期**:
- [ ] 左侧树为空
- [ ] 显示 "先进行项目分析" 提示

### AC-9.6: 项目切换

**测试**: 在顶部下拉切换到另一个项目

**预期**:
- [ ] Wiki 树更新为新项目的节点
- [ ] 详情区清空

---

## 10. 侧边栏导航

### AC-10.1: 新增图标

**预期**:
- [ ] 侧边栏有"需求"图标按钮
- [ ] 侧边栏有"Wiki"图标按钮

### AC-10.2: 导航功能

**测试**:
1. 点击"需求"图标
2. 点击"Wiki"图标

**预期**:
- [ ] 步骤 1：切换到看板页面
- [ ] 步骤 2：切换到 Wiki 页面
- [ ] 当前活跃页面图标高亮

---

## 11. Preload API

### AC-11.1: 全部 IPC 方法暴露

**验证**: 在渲染进程中调用以下方法

- [ ] `api().projectsList()` → 返回数组
- [ ] `api().projectsCreate({ name, path })` → 返回 ProjectRecord
- [ ] `api().requirementsList()` → 返回数组
- [ ] `api().requirementsCreate({ projectId, title, description })` → 返回 RequirementRecord
- [ ] `api().requirementsTransition(id, 'discuss', 'user')` → 成功
- [ ] `api().requirementsHistory(id)` → 返回数组
- [ ] `api().requirementsMessages(id)` → 返回数组
- [ ] `api().requirementsSteps(id)` → 返回数组
- [ ] `api().wikiListByProject(projectId)` → 返回数组
- [ ] `api().wikiGetNode(nodeId)` → 返回 WikiNode
- [ ] `api().leadPickup(requirementId)` → 返回 { sessionId }
- [ ] `api().leadProgress(requirementId)` → 返回进度对象

---

## 12. 样式与交互

### AC-12.1: 优先级色标

**验证**:
- [ ] critical 需求卡片有红色标记
- [ ] high 需求卡片有橙色标记
- [ ] normal 需求卡片有蓝色标记
- [ ] low 需求卡片有灰色标记

### AC-12.2: 状态 Badge

**验证**:
- [ ] 每个 RequirementHeader 正确显示当前状态 Badge
- [ ] 状态 Badge 颜色与设计规范一致

### AC-12.3: 响应式布局

**测试**: 调整窗口宽度

**预期**:
- [ ] 看板列数自适应（窗口窄时列变窄，但不丢失内容）
- [ ] Wiki 页面左栏保持 250px，右栏自适应
- [ ] 无水平滚动条溢出

---

## 13. 错误处理

| 场景 | 预期 |
|------|------|
| IPC 调用失败 | Toast 显示错误信息，UI 不崩溃 |
| 需求创建失败 | 弹窗保持打开，显示错误信息 |
| 状态流转失败 | 按钮恢复可点击，显示错误提示 |
| Wiki 节点加载失败 | 详情区显示错误提示 |
| 页面切换时 Store 为空 | 显示空状态，不报错 |

---

## 14. Smoke Test 清单

M4 完成的最低验证标准：

- [ ] `npm run build` 全量构建通过
- [ ] App 启动无报错
- [ ] 侧边栏有"需求"和"Wiki"图标
- [ ] 点击"需求" → 看板页面渲染
- [ ] 看板显示按状态分列的需求卡片
- [ ] 点击 found 卡片 → 跳转聊天 + RequirementHeader
- [ ] 确认就绪 → 卡片移到"就绪"列
- [ ] 新建需求弹窗可创建需求
- [ ] 点击"Wiki" → Wiki 页面渲染
- [ ] Wiki 树显示节点 + 点击展开详情
- [ ] 项目筛选功能正常
- [ ] Preload 全部 API 方法可用
