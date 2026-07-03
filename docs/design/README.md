# docs/design — 设计文档统一入口

所有**设计 / RFC / 实现计划 / 验收**文档按"努力"(effort)分子目录存放。每个子目录是一次完整的设计努力,内部自带它的 spec、计划、验收与归档。

> 当前架构以 [`../arch/`](../arch/) 为准(基于代码反向推导)。本目录是**为什么这么设计 + 按什么顺序落地**的来源记录,不一定与最新代码逐字同步;代码是唯一真相。

## 目录布局

```
docs/design/
├── README.md                ← 本文
├── agent-driven-workflow/   ← v0.8 多 Agent 工作流重构(原 docs/rfc/)
├── hook-redesign/           ← hook 生命周期重做(per-loop registry + step 中心)
└── runtime-push-ui-sync/    ← 运行时推送 · UI 窗口(单一真源 · 零轮询)
```

## 各努力说明

### agent-driven-workflow/(v0.8 工作流)

原 `docs/rfc/` 整体迁入。一次努力的完整四件套都在这里(RFC + 执行 spec + 计划 + 验收),并非纯 RFC 目录:

| 文件 | 性质 | 作用 |
|------|------|------|
| `agent-driven-workflow.md` | **设计 RFC** | 为什么 / 是什么(54 条决策 + 变更沿革 v0.1→v0.8) |
| `workflow-spec.md` | 执行 spec | 真实代码里流程怎么走(触发点/数据流/IPC/存储/prompt 契约,标 `文件:行号`) |
| `impl-plan.md` | 计划索引 | 按什么顺序做、怎么算 done |
| `plan-Px.md` × 10 | 实现计划 | 每阶段(P0–P9)的实现拆解 |
| `acceptance-Px.md` × 10 | 验收标准 | 每阶段的 done 判定 |
| `platform-notes.md` | 平台备忘 | 平台相关注意事项 |
| `archive/` | 已退役 | M0–M5 里程碑级计划(被 P0–P9 取代) |

### hook-redesign/(hook 生命周期重做)

| 文件 | 性质 | 作用 |
|------|------|------|
| `hook-step-redesign.md` | **权威 spec** | per-loop registry + step 中心 + 去 turn 表(背景/命名映射/step 级恢复) |
| `archive/` | 已完成 | 重做的 per-unit 执行步骤(1A–5B 的 impl/accept),已合并到 master |

### runtime-push-ui-sync/(运行时推送 · UI 窗口)

| 文件 | 性质 | 作用 |
|------|------|------|
| `runtime-push-ui-sync.md` | **设计 Draft** | UI 是运行时的展示窗口——四条不变量(所见即所跑 / 只更新变化部分 / 运行时状态变即实时反应 / 架构统一易扩展)+ 两类数据(状态 record / 流 stream)各一套统一契约 |
| `conventions.md` | 实现规约 | 冷启动 subagent 必读的项目级硬规约(三层 tsc / sessions.db 只读 / commit / Edit 陷阱 / 不动他人代码 / 层级边界) |
| `plan-N1.md` / `acceptance-N1.md` | 实现路线 / 测试要求 | N1 统一状态流基建(桥 + runtime emit + 白名单 + session emit) |
| `plan-N2.md` / `acceptance-N2.md` | 实现路线 / 测试要求 | N2 UI 推送驱动 + 消闪烁 + 重连 resync(依赖 N1) |
| `plan-N3.md` / `acceptance-N3.md` | 实现路线 / 测试要求 | N3 文件系统零轮询(非运行时) |
| `plan-N4.md` / `acceptance-N4.md` | 实现路线 / 测试要求 | N4 配置字段热更(不变量 1:所见即所跑) |

## 约定

- **新努力**:在 `docs/design/` 下新建一个子目录,至少含一份 spec(为什么/是什么)。是否拆 plan/acceptance 由努力规模决定。
- **完成或被取代的努力**:整体移到该努力自己的 `archive/` 子目录(而非顶层 `archive/`),保留历史。
- **跨努力导航**:从本 README 进;努力内部用相对链接。
- 旧路径 `docs/rfc/` 已废弃 → 现为 `docs/design/agent-driven-workflow/`。
