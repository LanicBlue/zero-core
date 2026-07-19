# Acceptance 06：Agent Work Runtime 加固

对应 [Plan 06](plan-06-hardening.md)。

- [ ] WorkRun/Turn/handoff/restart 状态矩阵有自动化证据。
- [ ] 用户输入、Wait、Cron、Work 和 subagent 不继承错误 workspace/mount。
- [ ] traversal/junction/mount conflict/content revision 稳定拒绝。
- [ ] worktree 失败无主目录 fallback，cleanup 可恢复且不删除 Flow 文档。
- [ ] 生产 prompt/schema/tool output 无 `[skills]/` 或旧 Work 双语义。
- [ ] benchmark 达到 result 预先记录阈值，无 skipped/only。
- [ ] typecheck、build:lib、unit、build、E2E、check:links 全部成功。
