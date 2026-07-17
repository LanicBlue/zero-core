# Acceptance 07：Flow API、动态 UI 与旧 Requirement Importer

对应 [Plan 07](plan-07-flow-api-ui-importer.md)。

## A. API 身份与合同

- [ ] control/definition/instance/document/work/workRun/importer API 均有 schema 和稳定错误。
- [ ] actor/Project 身份由 server 注入，renderer/LLM 不能伪造。
- [ ] reconnect/refetch 能恢复持久事实，不依赖进程内 event。

## B. 动态 Flow UI

- [ ] UI 列和 allowed transitions 来自当前 Project FlowDefinition。
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

## C. WorkRun UI

- [ ] queued/running/waiting/terminal、retry/cancel/manual fire 行为可自动化验证。
- [ ] session/turn/worktree/trigger event 关联准确。
- [ ] 无效 WorkDefinition 在保存/启用前被拒绝。

## D. Importer

- [ ] preview 列出状态、文档、冲突、目标 id 和来源 hash。
- [ ] execute 幂等；中断恢复不会生成重复 FlowInstance。
- [ ] import 后正文/hash/count 符合预览，provenance 完整。
- [ ] 旧 Requirement 表、状态和文档不被删除或修改。
- [ ] 未知状态/definition mismatch 不被静默猜测。

## E. 验证与证据

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run test:e2e
npm run check:links
```

`result-07.md` 包含 API contract、动态状态 E2E、dependency/cycle/unknown UI、
split/merge preview/lineage/idempotency E2E、queue reconnect、import 前后 hash/count
与 legacy isolation。

## F. 拒绝条件

- 把旧 Kanban 复制后继续写死状态。
- 新旧系统双写或 importer 自动运行。
- 仅靠人工截图验收 transition/queue/import。
