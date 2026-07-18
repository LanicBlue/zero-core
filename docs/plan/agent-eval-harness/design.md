# Design：Agent Eval Harness Skill

本设计服从跨 effort 的
[Agent Project Automation 架构合同](../agent-project-automation.md)，研究输入见
[research.md](research.md)。

## 1. 交付形态

Eval 是自包含 bundled Skill，不进入 AgentLoop 固定分支：

```text
src/server/bundled-skills/agent-eval-harness/
├── SKILL.md
├── scripts/
├── profiles/
├── scenarios/
├── tests/
└── package.json
```

启动只 seed Skill；不自动注册 Project、创建 Agent/Cron/Flow 或运行评估。已存在本地副本
不被整体覆盖。

## 2. 执行与判断

Skill 优先使用 deterministic outcome assertions、项目命令、文件/JSON 断言和 trajectory
diagnostics。model judge 是显式 profile adapter，默认关闭，不能成为全局固定门禁。

Skill 诊断问题并生成证据，不直接修改被评估项目代码。是否把 finding 接入 gate 由目标
Project 的 FlowDefinition/WorkDefinition 配置决定。

## 3. OpenTelemetry 兼容边界

OpenTelemetry GenAI 是可选的 trajectory 输入和 evaluation 输出协议，不是 Eval 的内部
真相源。Skill 保留版本化的 normalized trajectory 与 Eval result 合同，adapter 负责在
以下格式之间转换：

```text
archive-v1 ───┐
OTLP JSON ────┼─> input adapter ─> normalized trajectory ─> grader
OTLP Protobuf ┘                                      ├─> stable JSON / Markdown
                                                    └─> optional gen_ai.evaluation.result
```

首版 adapter 遵守以下边界：

- profile 显式选择输入格式、OTel GenAI semantic-convention revision、redaction 和输出；
- OTLP 未知属性向前兼容；转换结果保留来源 schema/revision、trace/span identity 和映射
  diagnostics；
- Project Session 只作为 conversation/correlation identity，不创建贯穿长期 Session 的
  单一 trace；
- 只有可可靠识别的 planning/task decomposition 才映射 `plan`，普通 reasoning 不伪装成
  plan span；
- Flow/Work/Session 的业务状态不从 telemetry 反推或回写；`zero_core.*` 扩展属性只用于
  关联证据；
- 只有评价对象是具体 GenAI operation/response 的 grader result 才投影
  `gen_ai.evaluation.result`；scenario/trial/outcome 级结论继续使用稳定 Eval result，
  不冒充标准 response evaluation；
- prompt、reasoning、tool args/result 和模型输出默认不进入 OTel 输出；内容采集必须由
  profile 显式启用并经过 redaction；
- 默认只生成本地产物，不连接 collector、不发送网络 telemetry。

本 effort 不向 AgentLoop、Provider、Session supervisor、ToolExecutor、Flow 或 Work
runtime 注入 OTel SDK/instrumentation。zero-core 原生实时 spans、collector/export pipeline
和观测 UI 属于后续独立 effort。缺少原生 spans 不阻塞 Skill 分析 archive 或其他 Project
提供的 OTLP。

## 4. Archive Analyst

归档分析直接读取普通 archive JSON，不读取 zero-core 私有 DB。checkpoint 与去重保存在
分析 Project 的控制面，不改 archive。目标 Project 已注册时，Agent可通过通用 Flow 工具
创建 Found instance；未注册时只保留报告。

## 5. 自主演进

seeded Skill 目录可以在软件运行后显式注册为普通 Project，由 Agent 通过正常 Flow/Work
维护。注册、外层 Git 初始化和 bundled source 回写都是不同的显式操作。
