# Acceptance 09：切换、恢复、性能与活动文档

对应 [Plan 09](plan-09-cutover-hardening.md)。

## A. 恢复

- [ ] control/inner Git/Flow transaction/DB index/dependency/composition event 与
  idempotency/WorkRun/worktree/skill migration/archive checkpoint 的中断矩阵有自动化
  测试。
- [ ] 一个 Project 损坏不会阻塞其他 Project 或全局 Agent。
- [ ] 恢复不从 DB 摘要伪造 Flow 文档。

## B. Cutover

- [ ] Agent-facing Flow 无 fixed ready/build/verify action。
- [ ] Project 是 Flow/Work definition 配置的唯一 Agent tool；Project config 使用通用
  kind + definition/ref，不复制领域 schema。
- [ ] Flow 只暴露 FlowInstance runtime action，可授予普通 Project Agent。
- [ ] Work 只暴露 WorkRun runtime action，可授予普通 Project Agent。
- [ ] 旧 Work create/update/delete/list/fire action、旧 runner 新系统路径和 definition/run
  双语义全部删除。
- [ ] 工具授权仍按工具名，无新 action-level grant。
- [ ] 生产 prompt/schema/tool output 无 `[skills]/`。
- [ ] 新 Work 无 busy skip、旧 worktree create fallback 或 Requirement 双写。
- [ ] 临时 adapter/feature flag 已删除或有用户批准的独立后续 issue。
- [ ] 旧 Requirement 数据/UI 未被误删，且明确标为 legacy。

## C. 安全与性能

- [ ] Windows traversal/junction、repo lock、disk/Git failure、duplicate event、并发反向
  dependency、missing target、split/merge revision conflict/partial commit、forged actor/
  project/workRun、switch/terminal cleanup race、malformed config/archive、child process
  均有证据。
- [ ] Project 根 Glob/Grep 不遍历 `.zero-core/worktrees`。
- [ ] Flow/WorkRun/index/inner Git/archive benchmark 满足 result 中预先记录阈值。
- [ ] 无 skipped/only 测试绕过关键平台场景。

## D. 文档

- [ ] 活动架构文档只描述已经通过验收的实现。
- [ ] 清理警告明确 `git clean -ffdx` 边界。
- [ ] Flow dependency/composition、Work、Context、VFS、Eval、legacy Requirement
  边界一致。
- [ ] `npm run check:links` 成功。

## E. 全局验证

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run test:e2e
npm run check:links
```

## F. 必备证据

`result-09.md` 包含恢复矩阵、legacy grep 分类、性能报告、失败注入、所有命令和活动文档
变更。

## G. 拒绝条件

- 为完成 cutover 删除用户 Requirement 数据。
- 用吞错、fallback、关闭测试或保留双写通过验收。
- 在实现证据前把 design 目标写成当前架构事实。
