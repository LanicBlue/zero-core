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

## 3. Archive Analyst

归档分析直接读取普通 archive JSON，不读取 zero-core 私有 DB。checkpoint 与去重保存在
分析 Project 的控制面，不改 archive。目标 Project 已注册时，Agent可通过通用 Flow 工具
创建 Found instance；未注册时只保留报告。

## 4. 自主演进

seeded Skill 目录可以在软件运行后显式注册为普通 Project，由 Agent 通过正常 Flow/Work
维护。注册、外层 Git 初始化和 bundled source 回写都是不同的显式操作。
