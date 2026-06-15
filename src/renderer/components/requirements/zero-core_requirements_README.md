# requirements 目录说明书

## 核心功能

需求驱动工作流的 UI 组件：KanbanPage 看板主页面按状态分列展示；RequirementCard 看板卡片；CreateRequirementModal 新建需求弹窗；ExecutionDetailPanel 执行步骤/日志详情面板；RequirementHeader 聊天内嵌的需求上下文头（含状态流转按钮）。

## 输入

- `../../store/requirement-store`（需求列表、按状态分组、步骤、消息）
- `../../store/project-store`、`../../store/page-store`
- `../../../shared/types`（RequirementRecord / TaskStepRecord / RequirementMessage / RequirementStatus / RequirementPriority）

## 输出

- 看板页面、卡片、新建弹窗、执行详情面板、需求头 DOM

## 定位

渲染进程功能模块，被 AppLayout（KanbanPage）与 ChatPanel（RequirementHeader）消费。

## 依赖

- react
- `../../store/requirement-store`、`../../store/project-store`、`../../store/page-store`
- `../../../shared/types`

## 维护规则

- 需求状态机（found→discuss→ready→plan→build→verify→closed）变化时同步 KanbanPage 列定义与 RequirementHeader 按钮。
- 新增需求字段（优先级/来源/标签）需要扩展 RequirementCard 展示。
