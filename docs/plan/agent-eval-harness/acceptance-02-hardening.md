# Acceptance 02：Eval Skill 加固

对应 [Plan 02](plan-02-hardening.md)。

- [ ] fresh/existing seed 和 packaged artifact 内容一致，用户副本不被覆盖。
- [ ] malformed input、timeout/cancel、child process 和 cleanup 有自动化证据。
- [ ] deterministic fixture 重复结果一致，secret 不进入报告。
- [ ] malformed/truncated OTLP、未知属性、缺失 parent、乱序、span link、混合 revision
  和 adapter migration 有自动化证据。
- [ ] archive-v1/OTLP 等价 fixture 的 normalized trajectory 与 grader result 一致。
- [ ] 大 trace/高基数输入达到预先记录阈值；默认离线、内容关闭，显式 export 已 redaction。
- [ ] archive 增量扫描达到 result 预先记录阈值且不重复 finding。
- [ ] 启动无自动 Eval Project/Agent/Cron/Flow/执行、OTel exporter 或 bundled 回写。
- [ ] AgentLoop、Provider、Session、Tool、Flow/Work runtime 无本 effort 引入的
  instrumentation 或 OTel SDK 依赖。
- [ ] Skill 自测、typecheck、build:lib、unit、package、check:links 全部成功。
