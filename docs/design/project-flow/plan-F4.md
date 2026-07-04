# plan-F4 — UI 接入(卡片=入口,确认在详情视图)

> 节点 F4(依赖 F3)。目标:用户操作(确认/迁移)走 Flow action 的同一后端。**UI 模型:看板卡片只做入口(基本信息),确认动作在能展开完整上下文的详情视图/modal 里**——卡片太小,不足以作为判断依据。对应 [project-flow.md](project-flow.md) §4/§5/§8。

## UI 模型(定)
- **看板卡片**(RequirementCard)= 基本信息入口(标题/状态/priority/assignee 摘要)。**不放确认按钮**——信息不足以判断。点击 → 打开对应门的详情视图。
- **详情视图/modal** = 完整上下文 + 确认动作。每个门的详情视图不同(展示该门判断所需的上下文):
  | Flow action | 详情视图 | 展示的判断上下文 | 确认控件 |
  |---|---|---|---|
  | `pick`(Found→Discuss) | 需求详情/讨论 | 建议全文(描述) | "采纳 + 建文档" |
  | `ready`(Discuss→Ready) | 需求讨论视图 | 讨论消息流 | "定型" |
  | `startBuild`(Plan→Build) | 计划详情(现 pending-plan 列表) | Orchestrate flow/计划 | Confirm / Reject(+理由) |
  | `verify`(Verify→Closed/返工) | CoverageJudgementModal | 覆盖证据(manifest + 变更) | 通过 / 打回 |
- **没有 drag-and-drop**(看板不支持拖卡,确认不靠拖)。
- **通用状态选择器**(RequirementHeader `onTransition`)是 pick/ready 等的兜底入口(讨论视图里的状态选择)。

## 范围
- 抽 Flow action 公共后端(transitionStatus + 副作用 + 发 signal),Flow execute 与 REST/UI 共用它。
- 各详情视图/modal 的确认控件改调公共后端(经 REST):
  - CreateRequirementModal → Flow.create。
  - 需求讨论视图(RequirementHeader onTransition + pick/ready 按钮)→ Flow.pick / Flow.ready。
  - pending-plan Confirm/Reject → Flow.startBuild(发 buildStarted)/ 打回。
  - CoverageJudgementModal → Flow.verify(通过发 verified / 打回发 rejected)。
- 暴露面:这些是用户操作的后端,不受 agent 工具暴露面限制(agent 默认看不到 pick/ready/startBuild/verify,但 UI 能调)。

## 实现步骤
1. **抽公共后端**:Flow action 的迁移逻辑(transitionStatus + 副作用 + emit signal)抽成 management-service 上的方法(或纯函数),Flow execute + REST 都调它——单源,不分叉。
2. **REST 改接**:[requirement-router.ts](../../../src/server/requirement-router.ts) transition/create 端点改调公共后端(透传 signal)。
3. **详情视图确认控件改接**:
   - [CreateRequirementModal](../../../src/renderer/components/requirements/CreateRequirementModal.tsx) → create。
   - 需求讨论视图 pick/ready(RequirementHeader + 讨论消息)→ pick/ready;建文档副作用接 pick。
   - [KanbanBoard](../../../src/renderer/components/requirements/KanbanBoard.tsx) pending-plan Confirm/Reject → startBuild / 打回。
   - [CoverageJudgementModal](../../../src/renderer/components/requirements/CoverageJudgementModal.tsx) → verify(通过/打回)。
4. **卡片保持入口**:RequirementCard 点击打开对应详情(已有 handleCardClick);**不加确认按钮**。

## 关键文件
`requirement-router.ts` · management-service(公共后端)· `flow-tool.ts`(复用)· `CreateRequirementModal.tsx` / `CoverageJudgementModal.tsx` / `KanbanBoard.tsx`(pending-plan)· 需求讨论视图(RequirementHeader onTransition)

## 不做(留 F5)
- 删旧文件 / 注释清扫 / code-graph。

## 风险
- ChatPanel 830 行 tab/CRLF——只改 transition/pick/ready 调用点,不动内联渲染(conventions)。
- 公共后端抽离别引入分叉:Flow execute 与 REST 必须走同一段迁移+副作用+signal 逻辑。
- pending-plan 列表(CoverageJudgementModal)的现状交互需保留,只换后端到 Flow.startBuild/verify,别动 UI 结构。
- pick 的"建文档"副作用:现 PmService.createRequirementWithDoc 建文档;UI 的 pick 走公共后端时要带上建文档语义。
