# Acceptance 07：Flow API、动态 UI 与旧 Requirement Importer

对应 [Plan 07](plan-07-flow-api-ui-importer.md)。

## A. API 身份与合同

- [ ] control/definition/instance/document/work/workRun/importer API 均有 schema 和稳定错误。
- [ ] actor/Project 身份由 server 注入，renderer/LLM 不能伪造。
- [ ] reconnect/refetch 能恢复持久事实，不依赖进程内 event。
- [ ] Project config API/tool 以 kind + 完整 definition/ref 工作，Flow/Work validator 独立。

## B. Agent 工具授权边界

- [ ] 管理 Agent 的 Project 提供 config.validate/publish/activate/list/get 与 work.fire。
- [ ] 普通 Project Agent 的 Flow 只有 FlowInstance runtime action，无 definition mutation。
- [ ] 普通 Project Agent 的 Work 只有 WorkRun runtime action，无 definition CRUD/manual fire。
- [ ] Work 在一个原子提交中切换 schema/prompt/registration/policy；任何 commit 都不存在
  两个同名 Work 或 feature flag 双语义。
- [ ] 不存在 action-level tool grant；未持有对应工具时整个能力不可调用。
- [ ] CallerCtx 注入 project/session/agent/currentWorkRun，伪造跨 Project/run 稳定拒绝。
- [ ] WorkRun mutation 仅作用于当前 Agent Session；跨 Agent Session 或 switch 两端 scope
  不一致稳定拒绝。
- [ ] Project config 扁平 schema 没有复制每个 Flow/Work definition 字段。

## C. 动态 Flow UI

- [ ] UI 列和 allowed transitions 来自当前 Project FlowDefinition。
- [ ] Ready→Discuss、Build→Plan、Verify→Build 等回边不会因列顺序被隐藏或禁用。
- [ ] transition input 表单来自 definition contract；缺失 reason 在 UI 和 API 得到一致错误。
- [ ] 返工 preview/history 显示 from/to、actor、reason、revision 和触发的 WorkRun。
- [ ] terminal abandoned 进入终止筛选，保留 reason/history/documents；首版不可恢复。
- [ ] 3、7 和自定义状态 fixture 无 renderer 常量改动即可显示。
- [ ] instance version/revision/history/documents/workRuns 可追踪。
- [ ] prerequisite/dependent、milestone、satisfied/blocked/unknown 和 gated transition
  在 UI/API 一致。
- [ ] add/remove dependency 有 impact/cycle preview；跨 Project 不泄露未授权 Flow。
- [ ] split/merge preview 与 execute 使用同一 policy 校验结果，提交前显示涉及的
  instances、固定 document revisions 和可选 dependency edge。
- [ ] merge 可明确选择新 target 或 policy 允许的既有 target，并显示 revision conflict。
- [ ] lineage 正反向可导航，且 UI 不把 composition edge 画成 dependency gate。
- [ ] 首版跨 Project split/merge 在 UI/API 都稳定拒绝并解释应使用 dependency。
- [ ] conflict/unavailable Project 不允许误操作且不影响其他 Project。
- [ ] 新组件不 import RequirementStatus 或旧 FLOW_TRANSITIONS。

## D. WorkRun UI

- [ ] queued/deferred/running/waiting/terminal、defer/prioritize/switch/retry/cancel 行为可自动化验证。
- [ ] defer reason/notBefore、priority/order、actor/revision 在重连后仍一致。
- [ ] switch 只在安全 handoff 后改变 current invocation。
- [ ] session/turn/worktree/trigger event 关联准确。
- [ ] 无效 WorkDefinition 在保存/启用前被拒绝。

## E. Importer

- [ ] preview 列出状态、文档、冲突、目标 id 和来源 hash。
- [ ] execute 幂等；中断恢复不会生成重复 FlowInstance。
- [ ] import 后正文/hash/count 符合预览，provenance 完整。
- [ ] 旧 Requirement 表、状态和文档不被删除或修改。
- [ ] 未知状态/definition mismatch 不被静默猜测。

## F. 验证与证据

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run test:e2e
npm run check:links
```

`result-07.md` 包含 API contract、三工具授权矩阵、Project config、动态状态和正反向/废案
E2E、dependency/cycle/unknown UI、split/merge preview/lineage/idempotency E2E、
queue defer/switch/reconnect、import 前后 hash/count 与 legacy isolation。

## G. 拒绝条件

- 把旧 Kanban 复制后继续写死状态。
- 新旧系统双写或 importer 自动运行。
- 仅靠人工截图验收 transition/queue/import。
- 普通 Agent通过 Work 修改 definition，或通过 Flow 发布 definition。
