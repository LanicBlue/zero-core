# Acceptance 01：WorkDefinition、Trigger 与持久 WorkRun

对应 [Plan 01](plan-01-work-and-workrun.md)。

## A. WorkDefinition

- [ ] trigger、Agent、prompt、workspace、mount、retry 来自版本化配置。
- [ ] composition-triggered Work 只挂载 manifest 固定的 source document revisions，
  输出指向独立 child/target 文档。
- [ ] WorkRun 固定 definition snapshot/digest，配置更新不改变已排队 run。
- [ ] Flow-triggered run 保存 originFlowInstanceId/revision；manual/cron 可为空且不伪造关联。
- [ ] 无效 trigger/filter/workspace/mount 在启用前拒绝。
- [ ] WorkDefinition mutation 只存在于 validator/repository management service，不进入
  普通 Agent 的 Work runtime contract。

## B. Trigger 与幂等

- [ ] Flow event 只由 Work trigger 消费，Flow 无 Work id。
- [ ] 正向与反向 `flow.transitioned` 都能按 transition/from/to/input 匹配 Work。
- [ ] Ready→Discuss、Build→Plan、Verify→Build 各创建配置指定的返工 WorkRun。
- [ ] 返工 WorkRun 使用新 eventId，是新 run，不复活或 retry 已 terminal 的交接 run。
- [ ] dependency satisfied event 可以触发 Work，但不会由 Flow 核心直接 dispatch。
- [ ] split/merge event 可以触发综合、分派或后续 Work，但不会由 Flow 核心直接
  dispatch。
- [ ] 同一 event 对同一 Work version 只产生一个 WorkRun。
- [ ] manual 每次产生新 run；Cron 每次 fire 可审计且重放幂等。
- [ ] disabled/vacant/missing tools 有稳定状态和原因，不静默丢失。

## C. Queue 与恢复

- [ ] claim 使用原子 CAS，两个 dispatcher 不会执行同一 run。
- [ ] 同一 Project Session 默认 FIFO + definition priority，但顺序可审计调整。
- [ ] trigger 创建 run 只表示新任务进入队列，不把 Agent Session 绑定到 Flow，也不强制
  该 run 成为下一项；origin Flow/trigger/current run 均可辨识。
- [ ] queued/running 可 defer，reason/notBefore/deferCount 持久；到期前不 claim。
- [ ] prioritize/reorder 使用 expectedRevision，不改变 definition snapshot。
- [ ] switch 对当前/目标两个 revision 原子校验；任一冲突不留下半次切换。
- [ ] queued/running/terminal 重启矩阵符合 plan。
- [ ] deferred 重启后保留，按 notBefore 恢复 eligible。
- [ ] retry 增加 attempt 且保留原 snapshot。
- [ ] terminal run 不重放，cancelled 不被复活。
- [ ] Flow terminal event 取消此前关联 run，但排除发起 run和该 event 新建的清理/通知 run。

## D. 解耦

- [ ] WorkRun success 不自动 transition Flow。
- [ ] 打回/废案可让审核 WorkRun succeeded，并记录 returned/abandoned outcome。
- [ ] Agent不能直接设置 succeeded/failed 或改写固定 snapshot。
- [ ] queue mutation 只能作用于当前 Agent Session 的 run；跨 Project、跨 Agent Session
  或 switch 两端 scope 不一致均稳定拒绝。
- [ ] 新 WorkRun 不写旧 project_work/Requirement 状态。
- [ ] 本阶段 fake dispatcher 测试不伪装成 AgentLoop 已接入。

## E. 证据

运行 typecheck、build:lib、unit、check:links。`result-01.md` 包含 transition /
dependency / composition 事件幂等键、并发 claim、restart/retry 状态矩阵和新旧表
隔离证据，并包含三组正反向交接 trigger trace。

## F. 拒绝条件

- Session busy 时删除或 skip 持久 WorkRun。
- 执行时重新读取 active WorkDefinition 覆盖 snapshot。
- 在 Flow transition 内直接调用 Agent。
