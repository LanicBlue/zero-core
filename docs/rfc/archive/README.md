# 归档：Multi-Agent Workflow（M1-M5）

> **状态**：已归档（2026-06-13）
> **取代者**：`../agent-driven-workflow.md`
> **归档原因**：本组文档基于「系统自动创建 workflow agent（`Analyst-{name}` / `Lead-{name}`）」的假设，实际跑通后暴露出 workflow agent 与用户真实 agent 脱节的根本问题。已被 **Agent 驱动的工作流** 重构方案取代。

## 本目录收录

- `multi-agent-workflow-requirements.md` — 顶层需求 RFC（v4）
- `design-M1.md` … `design-M5.md` — 各里程碑设计
- `plan-M1.md` … `plan-M5.md` — 各里程碑计划
- `acceptance-M1.md` … `acceptance-M5.md` — 各里程碑验收

## 与现有代码的关系

M1-M5 的代码**仍然存在**于仓库中（Analyst/Lead/Cron/Kanban/Orchestrate 等）。新 RFC `agent-driven-workflow.md` 第 5 节「对 M1-M5 现有代码的影响清单」描述了如何把这些代码从「自动造 agent」重构为「Agent 配置化」。

因此本目录作为**历史计划记录**保留：它解释了现有 M1-M5 代码当初为什么这么设计，是后续重构的对照基准，不再作为活跃设计依据。
