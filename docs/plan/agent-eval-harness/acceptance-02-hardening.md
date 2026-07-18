# Acceptance 02：Eval Skill 加固

对应 [Plan 02](plan-02-hardening.md)。

- [ ] fresh/existing seed 和 packaged artifact 内容一致，用户副本不被覆盖。
- [ ] malformed input、timeout/cancel、child process 和 cleanup 有自动化证据。
- [ ] deterministic fixture 重复结果一致，secret 不进入报告。
- [ ] archive 增量扫描达到 result 预先记录阈值且不重复 finding。
- [ ] 启动无自动 Eval Project/Agent/Cron/Flow/执行或 bundled 回写。
- [ ] Skill 自测、typecheck、build:lib、unit、package、check:links 全部成功。
