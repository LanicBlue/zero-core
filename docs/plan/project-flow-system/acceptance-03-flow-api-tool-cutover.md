# Acceptance 03：Flow API 与 Agent 工具切换

对应 [Plan 03](plan-03-flow-api-tool-cutover.md)。

## A. 多 Definition API

- [ ] 同一 Project 可发布并同时激活至少三个不同 definitionId。
- [ ] 切换一个 definition 的 active version 不改变其他 binding。
- [ ] create 显式 definitionId 优先；省略时只使用 defaultDefinitionId。
- [ ] 既有 instance 固定旧 version/digest。

## B. 工具授权

- [ ] 只有持有 Project 的管理 Agent能管理 `kind: flow` definition。
- [ ] Flow 工具只包含 instance runtime action，无 definition mutation。
- [ ] 没有 action-level tool grant 或两个同名 Flow 工具。
- [ ] forged actor/Project 与未授权跨 Project relation 稳定拒绝。

## C. 关系与事件

- [ ] dependency、composition、related 使用不同 schema、repository 和查询类型。
- [ ] related 不参与 cycle、milestone satisfaction 或 transition gate。
- [ ] fixed Flow action 和新→旧 Requirement 调用生产引用为零。

## D. 验证

运行 typecheck、build:lib、unit、API contract 和 check:links。`result-03.md` 包含多
definition fixture、授权矩阵、关系隔离和 legacy 数据 hash/count。
