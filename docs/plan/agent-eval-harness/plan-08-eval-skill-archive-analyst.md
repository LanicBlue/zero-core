# Plan 08：内置 Eval Skill 与归档分析

## 目标

交付自包含 bundled `agent-eval-harness` Skill，包括脚本、profiles、scenarios 和测试；
Agent 可在任意注册 Project 上运行它，也可把 `~/.zero-core/archives` 作为 workspace
增量分析归档并向目标 Project 提交 Flow finding。

## 依赖

Acceptance 02–07 通过。

## 实施范围

### 1. Bundled 结构

创建设计规定的：

```text
src/server/bundled-skills/agent-eval-harness/
├── SKILL.md
├── scripts/
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
- analyze-session/archive；
- JSON + Markdown 输出；
- 稳定 exit code。

脚本优先 Node 标准库；若复用 YAML parser，必须有明确 package/runtime resolution，不假定
Project 安装依赖。所有路径显式传入或来自 Work manifest，不扫描目标 `.zero-core`。

### 3. Grader

首版支持：

- deterministic outcome assertions；
- command/test exit；
- file/JSON assertions；
- trajectory diagnostics；
- 可选 model judge adapter，但默认不启用、不设全局阈值。

trial 临时环境隔离，timeout/cancel/cleanup 可测试。失败报告保留证据，不泄露 secret。

### 4. 归档分析

读取 archive v1 JSON，按 sessionId/archivedAt/project context 增量扫描。checkpoint/去重位于
分析 Project 控制面或 Work 状态，不修改 archive。

提供两种配置示例：

- 全局 Cron → Archive Analyst Agent(defaultWorkspace = archives)；
- 注册 Archive Project → Cron Work(`workspace.kind: agent`)。

Skill 输出 finding；由 Agent 使用通用 Flow tool 向已注册目标 Project create Found
instance。目标未注册时保留报告，不自动注册。

### 5. 自主演进

验证 seeded Skill 目录可以显式注册成普通 Project。启动不自动注册、不初始化该目录的
外层源码 Git、不创建 Cron/Agent/Flow。发行回写 bundled 副本必须是显式审核 Work。

## 测试

覆盖 assets/package、fresh/existing seed、profile/scenario schema、deterministic runner、
timeout/cleanup、archive scan/checkpoint/dedupe、unknown project、Flow finding 和
`skill://` 路径。

## 完成定义

[Acceptance 08](acceptance-08-eval-skill-archive-analyst.md) 全部通过并生成
`result-08.md`。
