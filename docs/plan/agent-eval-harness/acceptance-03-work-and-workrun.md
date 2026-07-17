# Acceptance 03：WorkDefinition、Trigger 与持久 WorkRun

对应 [Plan 03](plan-03-work-and-workrun.md)。

## A. WorkDefinition

- [ ] trigger、Agent、prompt、workspace、mount、retry 来自版本化配置。
- [ ] composition-triggered Work 只挂载 manifest 固定的 source document revisions，
  输出指向独立 child/target 文档。
- [ ] WorkRun 固定 definition snapshot/digest，配置更新不改变已排队 run。
- [ ] 无效 trigger/filter/workspace/mount 在启用前拒绝。

## B. Trigger 与幂等

- [ ] Flow event 只由 Work trigger 消费，Flow 无 Work id。
- [ ] dependency satisfied event 可以触发 Work，但不会由 Flow 核心直接 dispatch。
- [ ] split/merge event 可以触发综合、分派或后续 Work，但不会由 Flow 核心直接
  dispatch。
- [ ] 同一 event 对同一 Work version 只产生一个 WorkRun。
- [ ] manual 每次产生新 run；Cron 每次 fire 可审计且重放幂等。
- [ ] disabled/vacant/missing tools 有稳定状态和原因，不静默丢失。

## C. Queue 与恢复

- [ ] claim 使用原子 CAS，两个 dispatcher 不会执行同一 run。
- [ ] 同一 Project Session 默认 FIFO。
- [ ] queued/running/terminal 重启矩阵符合 plan。
- [ ] retry 增加 attempt 且保留原 snapshot。
- [ ] terminal run 不重放，cancelled 不被复活。

## D. 解耦

- [ ] WorkRun success 不自动 transition Flow。
- [ ] 新 WorkRun 不写旧 project_work/Requirement 状态。
- [ ] 本阶段 fake dispatcher 测试不伪装成 AgentLoop 已接入。

## E. 证据

运行 typecheck、build:lib、unit、check:links。`result-03.md` 包含 transition /
dependency / composition 事件幂等键、并发 claim、restart/retry 状态矩阵和新旧表
隔离证据。

## F. 拒绝条件

- Session busy 时删除或 skip 持久 WorkRun。
- 执行时重新读取 active WorkDefinition 覆盖 snapshot。
- 在 Flow transition 内直接调用 Agent。
