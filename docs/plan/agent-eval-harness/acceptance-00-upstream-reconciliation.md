# Acceptance 00：Eval 上游设施对齐

对应 [Plan 00](plan-00-upstream-reconciliation.md)。

- [ ] 起点包含 Flow/Work 两个 Final 的合并 commit/result。
- [ ] bundled seed/package、`skill://`、Flow create 和 archive JSON 实际接口有源码证据。
- [ ] OTel GenAI 来源、commit/revision、Development/Stable 状态和 OTLP 编码基线有官方
  规范证据；未假定未发布 schema URL 或固定当前草案字段。
- [ ] archive-v1/OTLP 与内部 normalized trajectory/Eval result 的版本和映射边界已冻结。
- [ ] Session/Turn/invocation/WorkRun/tool/provider attempt 的相关性映射不把长期 Session
  变成单一 trace，也不把普通 reasoning 冒充 `plan`。
- [ ] 没有计划新增 Eval 专用 AgentLoop/DB/Flow 状态机。
- [ ] 没有计划修改 AgentLoop/Provider/Session/Tool/Flow/Work runtime 或增加原生实时
  OTel instrumentation。
- [ ] baseline、差异和所有者文件写入 `result-00.md`。
