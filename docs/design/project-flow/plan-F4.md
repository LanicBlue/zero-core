# plan-F4 — UI 接入(用户操作 = 未暴露给 agent 的 Flow action)

> 节点 F4(依赖 F3)。目标:看板拖卡 / 建需求 modal / REST 全走 Flow action 的同一后端;用户操作即"未暴露给 agent 的 Flow action"(原则 2)。对应 [project-flow.md](project-flow.md) §4.4/§5/§8。

## 范围
- [requirement-router.ts](../../../src/server/requirement-router.ts) 的 REST(transition / create / 等)改调 Flow action 后端(同一 transitionStatus + 副作用 + 发信号)。
- 看板拖卡(ChatPanel / KanbanBoard 的 transitionStatus 调用)→ 走同一后端。
- 建/选中需求 modal(CreateRequirementModal)→ Flow.create / Flow.pick。
- 暴露面明确:pick/ready/startBuild/verify 走 UI(用户);create/plan/finishBuild 也允许 UI(用户能手动),agent 走工具。

## 实现步骤
1. **抽公共后端**:把 Flow action 的 transitionStatus + 副作用 + 发信号逻辑抽成可复用函数(Flow execute 内部调它,REST 也调它)——避免两条路径分叉。放 management-service 或 flow-tool 的纯函数层。
2. **REST 改接**:[requirement-router.ts](../../../src/server/requirement-router.ts) 的 transition/create 端点改调公共后端(带 signal emit)。
3. **renderer 改接**:[ChatPanel.tsx](../../../src/renderer/components/layout/ChatPanel.tsx) / [KanbanBoard.tsx](../../../src/renderer/components/requirements/KanbanBoard.tsx) 的 transitionStatus 调用走更新后的 REST(透传 signal);[CreateRequirementModal](../../../src/renderer/components/requirements/CreateRequirementModal.tsx) 建/选 → create/pick。
4. **门控/暴露面**:确认 CONDITIONAL_TOOLS + toolPolicy 表达"哪些 Flow action 给 agent"——pick/ready/startBuild/verify 默认不给 agent(用户专用),create/plan/finishBuild 给 agent。用户经 UI 调用的是后端,不受 agent 暴露面限制。

## 关键文件
`requirement-router.ts` · `ChatPanel.tsx` / `KanbanBoard.tsx` / `CreateRequirementModal.tsx` · management-service(公共后端)· flow-tool.ts(复用)

## 不做(留 F5)
- 删旧文件 / 注释清扫 / code-graph。

## 风险
- ChatPanel 830 行 tab/CRLF,Edit 易踩——只改 transitionStatus 调用点,不动内联渲染(参照 conventions)。
- 拖卡语义:用户拖到某列 = 触发对应迁移;映射 列→action(如"讨论列"=ready,"计划列"=plan)。核实看板列定义与状态的对应。
- 公共后端抽离别引入逻辑分叉(Flow 与 REST 必须走同一段迁移逻辑)。
