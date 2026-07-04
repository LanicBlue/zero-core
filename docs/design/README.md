# docs/design — 设计 spec(进行中)

放**正在讨论/细化**的设计 spec。每个主题一个子目录,至少一份 spec 文件。

> **当前状态:无进行中的设计 effort。** 已完成的 5 个 effort 全部归档到 [`../archive/`](../archive/):
> - `archive/agent-driven-workflow/`(v0.8 多 agent 工作流,P0–P9)
> - `archive/hook-redesign/`(hook 生命周期重做)
> - `archive/project-flow/`(需求→代码合并 Flow)
> - `archive/runtime-push-ui-sync/`(运行时推送 · UI 窗口,N1–N4)
> - `archive/agent-context-fields/`(上下文字段接通,C1–C3)
>
> 当前架构以 [`../arch/`](../arch/) 为准(code-as-truth)。本目录是"为什么这么设计"的来源;一旦 effort 合并 master,spec 随 plan/acceptance 一起沉到 `archive/`。

## 约定(新 effort 进来时)

- 发现问题 → 先建 [`../issues/<name>.md`](../issues/)。
- 讨论细化 → 在本目录建 `<topic>/`,至少一份 spec。
- 需求明确 → 拆 [`../plan/<topic>/`](../plan/)(sub-impl + acceptance 一一对应)。
- 合并 master → 整组(spec + plan + acceptance)移到 [`../archive/<topic>/`](../archive/)。

完整生命周期见 [`../issues/README.md`](../issues/README.md)。
