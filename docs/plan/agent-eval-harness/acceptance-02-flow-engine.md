# Acceptance 02：Project FlowDefinition 与原子 Flow Engine

对应 [Plan 02](plan-02-flow-engine.md)。

## A. Definition 与实例

- [ ] Flow 状态/transition 不依赖 TypeScript 业务 union。
- [ ] definition version 文件不可变，active switch 只影响新 instance。
- [ ] FlowInstance 固定 definition id/version/digest。
- [ ] 无效 YAML、超限配置和未知 schema 稳定拒绝，无代码执行。

## B. Transition 事务

- [ ] expected revision 防止丢失更新。
- [ ] state/event/files/inner commit 成功后才更新 DB index 和 emit。
- [ ] Git commit 故障不会留下“已发事件但无权威 commit”的状态。
- [ ] pending transaction 可在重启时恢复或回滚。
- [ ] commit 后、index/publish 前崩溃返回/恢复为 `committed_pending_delivery`，重启补索引
  和重发同一 eventId。
- [ ] 多 Agent 并发 transition 只有一个成功，另一个得到可恢复 conflict。

## C. Dependency graph

- [ ] dependency 引用 prerequisite instance 固定 definition 暴露的 milestone，不写死
  目标内部 state。
- [ ] `transition-reached` 一旦达到持续满足；`state-in` 随目标当前 state 实时变化。
- [ ] `state-in` 回退发 regressed event，不自动回滚 dependent，只影响后续 gate。
- [ ] 无 dependency edge 时 `all-satisfied` 为真。
- [ ] self、直接 cycle、间接 cycle 全部拒绝。
- [ ] 并发 A→B/B→A 只有一边提交，锁顺序无死锁。
- [ ] 图/目标 revision 不可 reconcile 时返回 `DEPENDENCY_GRAPH_UNAVAILABLE`。
- [ ] 既有 target unavailable/missing 显示 unknown，并在 gated transition 上 fail closed。
- [ ] prerequisite definition migration 不得破坏 inbound milestone；缺失时拒绝或在同一
  审计事务显式 remap。
- [ ] 依赖只阻止声明 gate 的 transition；Found/Discuss/Plan 等未声明 transition 可继续。
- [ ] 依赖满足只发幂等标准 event，不自动 transition 或 dispatch Work。

## D. Split、merge 与 lineage

- [ ] split/merge 必须命中 FlowDefinition 命名 policy，并校验 actor、milestone、
  definition、数量和 expected revision。
- [ ] split policy 固定 source definition version；merge policy 使用显式
  definition id/version/digest，active switch 不改变重试语义。
- [ ] split 创建多个 child；merge 同时支持创建新 target 和 policy 允许的既有 target。
- [ ] 同一 idempotency key + 参数重试返回同一结果；同 key 不同参数稳定冲突。
- [ ] source/parent 保留且 currentState 与既有 transition history 不变；参与实例只推进
  revision 并追加 composition 事实，不自动关闭、删除或迁移任何 source。
- [ ] 同一 source/target 的并发 composition 使用 expected revision，旧 revision 最多
  一个成功。
- [ ] source 文档以固定 revision/inner commit 作为只读输入；核心不自动复制、拼接或
  覆盖 target 文档。
- [ ] 新 child/target 固定请求中的 definition id/version/digest；active switch 不改变
  operation 或其幂等重试结果。
- [ ] instance、manifest、可选 dependency edge 和 event 以一个内层 Git commit 提交；
  任一校验或 commit 失败不留部分结果。
- [ ] 带 dependency template 的 split 使用全局 dependency graph → Project 固定锁顺序，
  与并发普通 dependency mutation 不死锁或漏 cycle。
- [ ] lineage self、直接 cycle、间接 cycle 全部拒绝，正向/反向查询一致。
- [ ] 首版跨 Project split/merge 稳定拒绝；跨 Project dependency 仍可正常使用。
- [ ] split/merge event 幂等发出，不自动 transition 或 dispatch Work。

## E. Tool 与隔离

- [ ] Flow tool 只有通用 action，不包含固定 ready/build/verify 分支。
- [ ] Flow tool 暴露 policy 驱动的 split、merge 和 lineage 通用 action。
- [ ] actor/Project 身份由 host context 注入。
- [ ] 跨 Project 未授权操作不泄露 instance/definition。
- [ ] 旧 Requirement 表和文档在新 Flow 操作前后完全不变。

## F. 索引与恢复

- [ ] 删除可重建 DB index 后能从 `.zero-core` 恢复。
- [ ] eventId 重放幂等，补发不会产生第二个 WorkRun。
- [ ] inner Git history 能定位 definition、state、event 和 actor。
- [ ] dependency 正向/反向索引可从各 Project `dependencies.json` 重建。
- [ ] lineage 正向/反向索引可从 `compositions/*.json` 重建。
- [ ] idempotency 映射可从 manifest 重建；删 DB index 后重试同 key 不创建第二次操作。

## G. 验证与证据

运行 typecheck、build:lib、unit、check:links。`result-02.md` 必须包含 commit 前后故障
注入矩阵、dependency graph/cycle/并发反向边、split/merge/lineage/idempotency、
Git log、outbox 补发、索引重建和 legacy DB 不变 hash/count。

## H. 拒绝条件

- 新 Flow 调用旧 Requirement state machine。
- DB 复制 Markdown 正文或成为 FlowInstance 唯一事实源。
- commit 失败仍返回成功或发出 Work 可消费事件。
- 用目标 state 名替代 milestone contract，或允许未知图乐观添加依赖。
- split/merge 删除 source、隐式改变 source state、自动拼接正文，或跨 Project 留下
  部分提交。
