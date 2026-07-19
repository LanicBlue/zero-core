# Plan 00：Eval 上游设施对齐

## 目标

以已合并 Flow/Work/VFS/archive 接口为事实源，冻结 Skill 的调用、路径、finding、输入
合同和 OTel adapter 边界。

## 依赖

`project-flow-system` 与 `agent-work-runtime` Final PASS 并合并。

## 实施范围

- 记录 builtin Skill seed/copy/package 真实接口；
- 核对 `skill://`、Flow create、Work invocation 与 archive v1 JSON；
- 在实施时记录 OpenTelemetry GenAI 官方仓库 commit/revision、规范状态、OTLP
  JSON/Protobuf 编码和 `gen_ai.evaluation.result` 实际字段，不从过时二手文档抄 schema；
- 冻结 archive-v1/OTLP → normalized trajectory 与 Eval result 的版本化映射，明确未知
  属性、缺失 parent、span link、乱序和 redaction 规则；
- 记录 Session/Turn/invocation/WorkRun/toolCall/provider attempt 与 OTel
  conversation/trace/span/link 的映射，但不要求上游增加原生 OTel 字段；
- 记录目标 commit、环境、baseline 和实现所有者文件；
- 不因缺少 UI 创建 Eval 专用核心 API；
- 不向 AgentLoop、Provider、Session、Tool、Flow 或 Work runtime 注入 instrumentation。

## 完成定义

[Acceptance 00](acceptance-00-upstream-reconciliation.md) 通过并生成 `result-00.md`。
