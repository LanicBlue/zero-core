# plan-F4 — UI 接入(卡片=入口,确认在详情视图)

> 节点 F4(依赖 F3)。目标:用户操作(确认/迁移)走 Flow action 的同一后端。**UI 模型:看板卡片只做入口(基本信息),确认动作在能展开完整上下文的详情视图/modal 里**——卡片太小,不足以作为判断依据。对应 [project-flow.md](project-flow.md) §4/§5/§8。

## UI 模型(定)
- **看板卡片**(RequirementCard)= 基本信息入口(标题/状态/priority/assignee 摘要)。**不放确认按钮**——信息不足以判断。点击 → 打开需求视图(左 chat + 右文档)。
- **需求视图 = 左右分栏**(A):
  - **左:讨论 chat**(消息流,轻量来回;非判断依据)。
  - **右:文档面板**——**复用现成 [DocViewerPanel](../../../src/renderer/components/layout/DocViewerPanel.tsx)**(MarkdownRenderer 渲染)。渲染需求文档(Intent/Summary/Plan/Coverage/Decision Log 段)。
    - 数据源:DB 文档字段(真源)→ 喂 MarkdownRenderer;或投影到 `{workspace}/.zero/requirements/{id}.md` 让 DocViewerPanel 读文件。实现时定(倾向直接喂 DB,免文件滞后)。
    - **实时更新**:文档变 → runtime-push `data:changed` → 重渲染。
    - **edit 关闭/round-trip**:真源在 DB,改走 Flow action(不直接编辑文件)。
    - 活动需求切换 → 切换文档面板内容源。
  - **确认动作放文档面板**:每个门的按钮(startBuild 的 Confirm / verify 的通过-打回)放文档面板顶部或对应段旁——用户读完段就地确认。
  | Flow action | 文档面板展示段 | 确认控件 |
  |---|---|---|
  | `pick` | Intent + 建 Summary | 采纳 + 建文档 |
  | `ready` | Summary(定型) | 定型 |
  | `startBuild` | Plan | Confirm / Reject(+理由) |
  | `verify` | Coverage + Decision Log | 通过 / 打回 |
- **没有 drag-and-drop**(看板不支持拖卡)。
- **通用状态选择器**(RequirementHeader `onTransition`)是兜底入口。

## 范围
- 抽 Flow action 公共后端(transitionStatus + 副作用 + 发 signal),Flow execute 与 REST/UI 共用它。
- 各详情视图/modal 的确认控件改调公共后端(经 REST):
  - CreateRequirementModal → Flow.create。
  - 需求讨论视图(RequirementHeader onTransition + pick/ready 按钮)→ Flow.pick / Flow.ready。
  - pending-plan Confirm/Reject → Flow.startBuild(发 buildStarted)/ 打回。
  - CoverageJudgementModal → Flow.verify(通过发 verified / 打回发 rejected)。
- 暴露面:这些是用户操作的后端,不受 agent 工具暴露面限制(agent 默认看不到 pick/ready/startBuild/verify,但 UI 能调)。

## 实现步骤
1. **抽公共后端**:Flow action 的迁移逻辑(transitionStatus + 写文档段 + emit signal)抽成共享函数/方法,Flow execute + REST 都调它——单源,不分叉。
2. **REST 改接**:[requirement-router.ts](../../../src/server/requirement-router.ts) transition/create 端点改调公共后端(透传 signal)。
3. **需求视图(左右分栏)**:
   - 左:讨论 chat(现 RequirementHeader + messages,沿用)。
   - 右:**复用 [DocViewerPanel](../../../src/renderer/components/layout/DocViewerPanel.tsx)** / [MarkdownRenderer](../../../src/renderer/components/common/MarkdownRenderer.tsx) 渲染需求文档。数据源接 DB 文档字段(或投影文件),实时随 data:changed 重渲染。edit 关闭/round-trip。
   - 活动需求切换 → 切文档面板内容源。
4. **确认控件放文档面板**(各门按钮接 Flow action):pick(采纳+建文档)/ready(定型)/startBuild(Confirm/Reject)/verify(通过/打回)。CreateRequirementModal → create(入口);CoverageJudgementModal 可并入文档面板的 verify 段或保留。
5. **卡片保持入口**:RequirementCard 点击打开需求视图;**不加确认按钮**。

## 关键文件
`requirement-router.ts` · management-service(公共后端)· `flow-tool.ts`(复用)· **`DocViewerPanel.tsx` / `MarkdownRenderer.tsx`(复用渲染需求文档)** · `CreateRequirementModal.tsx` / `CoverageJudgementModal.tsx` / `KanbanBoard.tsx`(pending-plan 入口)· 需求讨论视图(RequirementHeader)

## 不做(留 F5)
- 删旧文件 / 注释清扫 / code-graph。

## 风险
- ChatPanel 830 行 tab/CRLF——只改 transition/pick/ready 调用点,不动内联渲染(conventions)。
- 公共后端抽离别引入分叉:Flow execute 与 REST 必须走同一段迁移+写文档+signal 逻辑。
- DocViewerPanel 复用:它现读文件;若改喂 DB 文档字段要适配其数据源(或保持读投影文件)。preview-only(edit 关)避免用户绕过 Flow action 改文档。
- pick 的"建文档"副作用:现 PmService.createRequirementWithDoc 建文档;UI 的 pick 走公共后端时带上建文档语义(写 DB Summary 段 + 投影)。

