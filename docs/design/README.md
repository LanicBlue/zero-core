# docs/design — 设计 spec 统一入口

只放**设计 spec**(为什么这么设计 / 是什么)。每个主题一个子目录,至少一份 spec 文件。

> design/ 现在只管 spec。实施计划 + 验收标准在 [`../plan/`](../plan/),已完成的归档在 [`../archive/`](../archive/),问题记录在 [`../issues/`](../issues/)。issue 全生命周期见 [`../issues/README.md`](../issues/README.md)。
>
> 当前架构以 [`../arch/`](../arch/) 为准(基于代码反向推导)。本目录是"为什么这么设计"的来源记录,不一定与最新代码逐字同步;代码是唯一真相。

## 目录布局

```
docs/design/
├── README.md                       ← 本文
├── agent-context-fields/           ← Agent 上下文字段接通(死字段:contextConfig/skillPolicy/knowledgeBaseIds)
├── agent-driven-workflow/          ← v0.8 多 Agent 工作流重构(原 docs/rfc/)
├── hook-redesign/                  ← hook 生命周期重做(per-loop registry + step 中心)
├── project-flow/                   ← 需求→代码合并的统一流转(Flow 工具)
└── runtime-push-ui-sync/           ← 运行时推送 · UI 窗口(单一真源 · 零轮询)
```

## 各主题 spec

### agent-driven-workflow/(v0.8 工作流)

原 `docs/rfc/` 整体迁入。spec 文件:

| 文件 | 作用 |
|------|------|
| `agent-driven-workflow.md` | **设计 RFC** —— 为什么 / 是什么(54 条决策 + 变更沿革 v0.1→v0.8) |
| `workflow-spec.md` | 执行 spec —— 真实代码里流程怎么走(触发点/数据流/IPC/存储/prompt 契约,标 `文件:行号`) |
| `platform-notes.md` | 平台备忘 —— 平台相关注意事项 |

实施计划 + 验收(P0–P9):[`../../plan/agent-driven-workflow/`](../plan/agent-driven-workflow/)(`impl-plan.md` 为索引)。
已退役里程碑(M0–M5):[`../../archive/agent-driven-workflow/`](../archive/agent-driven-workflow/)。

### hook-redesign/(hook 生命周期重做)

| 文件 | 作用 |
|------|------|
| `hook-step-redesign.md` | **权威 spec** —— per-loop registry + step 中心 + 去 turn 表(背景/命名映射/step 级恢复) |

已完成的执行步骤(1A–5B 的 impl/accept,已合并 master):[`../../archive/hook-redesign/`](../archive/hook-redesign/)。

### runtime-push-ui-sync/(运行时推送 · UI 窗口)

| 文件 | 作用 |
|------|------|
| `runtime-push-ui-sync.md` | **设计(已落地 N1–N4)** —— UI 是运行时的展示窗口:四条不变量 + 两类数据各一套统一契约。N1–N4 已合入 master |
| `conventions.md` | 实现规约 —— 冷启动 subagent 必读的项目级硬规约(三层 tsc / sessions.db 只读 / commit / Edit 陷阱 / 不动他人代码 / 层级边界) |

实施计划 + 验收(N1–N4):[`../../plan/runtime-push-ui-sync/`](../plan/runtime-push-ui-sync/)。

### agent-context-fields/(Agent 上下文字段接通)

runtime-push N4 核实出的"死字段"接通 effort。

| 文件 | 作用 |
|------|------|
| `agent-context-fields.md` | **设计 Draft** —— 现状审计 + 逐字段方案 + 6 个待产品决策项 + 建议节点拆分(C1–C4 + 独立 KB effort) |

### project-flow/(需求→代码合并的统一流转)

把"需求→代码合并"整条交付链统一成 project 类的 `Flow` 工具。**Flow 只做状态迁移 + 发 hook,下游全靠 work 订阅 hook 反应**——不在工具里硬编码。

| 文件 | 作用 |
|------|------|
| `project-flow.md` | **设计 Draft** —— 模型(迁态+发hook、work订阅)+ 状态机/action/驱动 + hook 词表 + 5 个架构变更 + 责任矩阵 |

实施计划 + 验收(F1–F5):[`../../plan/project-flow/`](../plan/project-flow/)。

## 约定

- **新努力**:发现问题先建 [`../issues/<name>.md`](../issues/);讨论细化进 design/(本文入口),至少一份 spec;需求明确后拆 [`../plan/<topic>/`](../plan/)(sub-impl + acceptance 一一对应);合并 master 后归档 [`../archive/<topic>/`](../archive/)。完整生命周期见 [`../issues/README.md`](../issues/README.md)。
- **design/ 只放 spec**:plan-*.md / acceptance-*.md 不放这里,放 plan/。
- **跨主题导航**:从本 README 进;主题内部用相对链接。
- 旧路径 `docs/rfc/` 已废弃 → 现为 `docs/design/agent-driven-workflow/`。
