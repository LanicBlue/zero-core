# Plan 01：内置 Eval Skill 与归档分析

## 目标

交付自包含 bundled `agent-eval-harness` Skill，包括脚本、profiles、scenarios 和测试；
Agent 可在任意注册 Project 上运行它，也可把 `~/.zero-core/archives` 作为 workspace
增量分析归档、读取其他 Project 提供的 OTLP trace，并向目标 Project 提交 Flow finding。

## 依赖

Acceptance 00 通过。

## 实施范围

### 1. Bundled 结构

创建设计规定的：

```text
src/server/bundled-skills/agent-eval-harness/
├── SKILL.md
├── scripts/
│   └── adapters/
├── profiles/
├── scenarios/
├── tests/
└── package.json
```

加入 builtin id 与打包复制；首装 seed，已有本地副本不被整体覆盖。

### 2. CLI 与 schema

至少提供：

- profile validation；
- scenario validation；
- run-eval；
- analyze-session/archive/trace；
- JSON + Markdown 输出；
- 可选 OTel evaluation result 产物/export；
- 稳定 exit code。

脚本优先 Node 标准库；若复用 YAML parser，必须有明确 package/runtime resolution，不假定
Project 安装依赖。OTLP Protobuf 若需要额外 decoder/runtime，依赖必须由 Skill 自己声明、
打包并解析，不加入 zero-core Core runtime，也不借用被评估 Project 的依赖。所有路径显式
传入或来自 Work manifest，不扫描目标 `.zero-core`。

### 3. Telemetry adapters

Skill 内提供统一 input adapter 接口和首版 `archive-v1`、OTLP JSON、OTLP Protobuf
实现。三者转换到版本化 normalized trajectory；grader 不直接依赖 OTel attribute 名。

OTel adapter 至少支持：

- `invoke_agent`、明确的 `invoke_workflow`、`plan`、model inference、`execute_tool` 和 MCP
  client/server span；
- `gen_ai.conversation.id`、trace/span/link、token usage、error、duration 和 tool identity；
- `zero_core.*` 可选扩展关联 project/session/turn/invocation/workRun/attempt，但不存在时
  仍能分析通用 Project trace；
- 当 grader 明确评价某个 GenAI operation/response 时，将对应结果映射为可选
  `gen_ai.evaluation.result`；scenario/trial/outcome 级结论不冒充该标准事件，同时始终
  保留稳定 JSON/Markdown 结果；
- profile pin 的 semantic-convention revision、adapter version、source schema 和转换
  diagnostics；
- 未知属性、缺失 parent、跨 trace link 和乱序 span 的确定行为。

默认只读取显式文件并写本地产物。连接 OTLP endpoint 或发送 evaluation telemetry 必须由
profile 显式配置；内容字段默认关闭并 redaction。adapter 不回写 Flow/Work/Session 状态，
也不尝试从 telemetry 恢复运行时。

### 4. Grader

首版支持：

- deterministic outcome assertions；
- command/test exit；
- file/JSON assertions；
- trajectory diagnostics；
- 可选 model judge adapter，但默认不启用、不设全局阈值。

trial 临时环境隔离，timeout/cancel/cleanup 可测试。失败报告保留证据，不泄露 secret。

### 5. 归档分析

读取 archive v1 JSON，按 sessionId/archivedAt/project context 增量扫描。checkpoint/去重位于
分析 Project 控制面或 Work 状态，不修改 archive。

提供两种配置示例：

- 全局 Cron → Archive Analyst Agent(defaultWorkspace = archives)；
- 注册 Archive Project → Cron Work(`workspace.kind: agent`)。

Skill 输出 finding；由 Agent 使用通用 Flow tool 向已注册目标 Project create Found
instance。目标未注册时保留报告，不自动注册。

### 6. 自主演进

验证 seeded Skill 目录可以显式注册成普通 Project。启动不自动注册、不初始化该目录的
外层源码 Git、不创建 Cron/Agent/Flow。发行回写 bundled 副本必须是显式审核 Work。

## 测试

覆盖 assets/package、fresh/existing seed、profile/scenario schema、deterministic runner、
timeout/cleanup、archive scan/checkpoint/dedupe、OTLP JSON/Protobuf normalize、
evaluation result 映射、semantic-convention 版本/未知属性、redaction、默认无网络发送、
unknown project、Flow finding 和 `skill://` 路径。

## 完成定义

[Acceptance 01](acceptance-01-eval-skill-archive-analyst.md) 全部通过并生成
`result-01.md`。
