# Final Acceptance：Agent Eval Harness Skill

> 只在 Acceptance 00–02 全部通过后执行。

- [ ] bundled Skill 包含说明、脚本、profiles、scenarios 和自测。
- [ ] fresh seed 可用，已有本地副本不被整体覆盖。
- [ ] deterministic runner、报告和 exit code 合同稳定。
- [ ] archive-v1、OTLP JSON/Protobuf 通过 adapter 进入版本化 normalized trajectory，
  OTel 规范变动不成为 grader 内部 schema。
- [ ] operation/response scoped `gen_ai.evaluation.result` 映射正确，trial/outcome 级结果
  不误用该事件；默认离线、内容关闭并执行 redaction。
- [ ] archive checkpoint/dedupe 不修改 archive 或读取私有 DB。
- [ ] registered/unknown Project finding 路由正确。
- [ ] Eval 不直接修改目标项目代码或自动成为 Flow gate。
- [ ] 本 effort 未修改或 instrument AgentLoop、Provider、Session、Tool、Flow/Work runtime。
- [ ] seeded Skill 可显式注册并按普通 Project 自主演进。
- [ ] 独立验收 Agent 明确记录 PASS。
