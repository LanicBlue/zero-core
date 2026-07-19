# Acceptance 01：内置 Eval Skill 与归档分析

对应 [Plan 01](plan-01-eval-skill-archive-analyst.md)。

## A. 发行与 seed

- [ ] builtin 清单恰好包含既有 `skill-creator` 和新增 `agent-eval-harness`。
- [ ] 打包产物包含 SKILL、scripts、profiles、scenarios、tests/package metadata。
- [ ] input adapters 与其 schema/fixtures 是 Skill 资产，不依赖 zero-core runtime 私有模块。
- [ ] OTLP Protobuf/YAML 等额外依赖由 Skill 自己声明、打包和解析，不增加 Core runtime
  依赖，也不借用目标 Project 的安装。
- [ ] fresh seed 完整；已有本地副本不被整体覆盖。
- [ ] 所有 Skill 内公开路径使用 `skill://`。

## B. Runner

- [ ] profile/scenario schema 错误稳定、可定位。
- [ ] deterministic fixture 重跑结果一致。
- [ ] JSON/Markdown/exit code 合同稳定。
- [ ] timeout/cancel/cleanup 不残留子进程或临时目录。
- [ ] 默认不调用 model judge、不设置全局 CI gate。

## C. OpenTelemetry adapter

- [ ] archive-v1、OTLP JSON 和 OTLP Protobuf fixtures 都转换为版本化 normalized
  trajectory；语义等价 fixture 得到相同 grader 结果。
- [ ] OTel adapter 覆盖 agent/workflow/plan/model/tool/MCP span、token/error/duration 与
  trace/span/link 相关性。
- [ ] 对 operation/response scoped grader，`gen_ai.evaluation.result` 可表达 grader
  name、pass/fail label、score、explanation 和被评估 span/response 的可用关联；
  scenario/trial/outcome 级结论不误用该事件，稳定 JSON/Markdown 始终存在。
- [ ] result 记录 source schema、adapter version、pinned semantic-convention revision
  和 mapping diagnostics。
- [ ] 未知 attribute、缺失 parent、span link、乱序和不同 convention revision 有稳定、
  向前兼容的处理。
- [ ] 长期 Session 只作为 conversation/correlation identity；普通 reasoning 不生成伪
  `plan`，Flow/Work/Session 状态不从 telemetry 反推或回写。
- [ ] prompt/reasoning/tool args/result/model output 默认不 export；显式内容采集经过
  redaction，默认不连接 collector 或发送网络 telemetry。

## D. Archive Analyst

- [ ] archive v1 JSON 可直接分析，不读取私有 DB。
- [ ] checkpoint/dedupe 不修改 archive，重跑不重复 finding。
- [ ] archive 中 project context 正确路由已注册 Project。
- [ ] 未注册目标只保存报告，不自动注册。
- [ ] Agent 可通过 Flow tool 创建带 archive/session 证据的 Found instance。

## E. 无启动副作用

- [ ] 启动不自动创建 Eval Project、Agent、Cron、Flow 或运行评估。
- [ ] 启动不初始化 OTel SDK、collector/exporter 或后台 telemetry pipeline。
- [ ] seed 目录显式注册后按普通 Project 工作。
- [ ] 本地 Skill 演进不自动写回 bundled source。

## F. 验证与证据

运行 typecheck、build:lib、unit、Skill 自测、打包测试、check:links。`result-01.md` 包含
fixture 输出、archive/OTLP 等价结果、evaluation event、归档增量两轮结果、
unknown/registered project 路由、redaction/无网络发送和启动副作用检查。

## G. 拒绝条件

- Eval 逻辑进入 AgentLoop 固定分支。
- 为了 OTel 兼容修改或 instrument AgentLoop、Provider、Session、Tool、Flow/Work runtime。
- OTel schema 成为 grader 的内部真相源或 telemetry 成为业务状态恢复来源。
- Skill 脚本搜索物理 `.zero-core` 或读取 Core DB。
- 分析结果直接修改目标项目代码。
