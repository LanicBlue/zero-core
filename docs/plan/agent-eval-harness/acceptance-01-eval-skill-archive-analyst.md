# Acceptance 01：内置 Eval Skill 与归档分析

对应 [Plan 01](plan-01-eval-skill-archive-analyst.md)。

## A. 发行与 seed

- [ ] builtin 清单恰好包含既有 `skill-creator` 和新增 `agent-eval-harness`。
- [ ] 打包产物包含 SKILL、scripts、profiles、scenarios、tests/package metadata。
- [ ] fresh seed 完整；已有本地副本不被整体覆盖。
- [ ] 所有 Skill 内公开路径使用 `skill://`。

## B. Runner

- [ ] profile/scenario schema 错误稳定、可定位。
- [ ] deterministic fixture 重跑结果一致。
- [ ] JSON/Markdown/exit code 合同稳定。
- [ ] timeout/cancel/cleanup 不残留子进程或临时目录。
- [ ] 默认不调用 model judge、不设置全局 CI gate。

## C. Archive Analyst

- [ ] archive v1 JSON 可直接分析，不读取私有 DB。
- [ ] checkpoint/dedupe 不修改 archive，重跑不重复 finding。
- [ ] archive 中 project context 正确路由已注册 Project。
- [ ] 未注册目标只保存报告，不自动注册。
- [ ] Agent 可通过 Flow tool 创建带 archive/session 证据的 Found instance。

## D. 无启动副作用

- [ ] 启动不自动创建 Eval Project、Agent、Cron、Flow 或运行评估。
- [ ] seed 目录显式注册后按普通 Project 工作。
- [ ] 本地 Skill 演进不自动写回 bundled source。

## E. 验证与证据

运行 typecheck、build:lib、unit、Skill 自测、打包测试、check:links。`result-01.md` 包含
fixture 输出、archive 增量两轮结果、unknown/registered project 路由和启动副作用检查。

## F. 拒绝条件

- Eval 逻辑进入 AgentLoop 固定分支。
- Skill 脚本搜索物理 `.zero-core` 或读取 Core DB。
- 分析结果直接修改目标项目代码。
