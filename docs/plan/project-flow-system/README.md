# Project Flow System：实施路线图

> 状态：设计完成，尚未实施。
> 外部前置已满足：`wiki-system-redesign` Final PASS，并于 2026-07-19 合入 `master`（基线 `a58102d`）后归档；现在可执行 Plan 00。
> 共同合同：[Agent Project Automation](../agent-project-automation.md)。

## 阶段

| 阶段 | Plan | Acceptance | 依赖 | 主要产物 |
|---|---|---|---|---|
| 00 | [Post-Wiki Reconciliation](plan-00-post-wiki-reconciliation.md) | [Acceptance 00](acceptance-00-post-wiki-reconciliation.md) | Wiki Final + merge | baseline、真实接口映射 |
| 01 | [Project Control Git](plan-01-project-control-git.md) | [Acceptance 01](acceptance-01-project-control-git.md) | 00 | `.zero-core` manifest、内层 Git |
| 02 | [Flow Engine](plan-02-flow-engine.md) | [Acceptance 02](acceptance-02-flow-engine.md) | 01 | 多 Definition、FlowInstance、关系图、事件 |
| 03 | [Flow API & Tool Cutover](plan-03-flow-api-tool-cutover.md) | [Acceptance 03](acceptance-03-flow-api-tool-cutover.md) | 02 | Project flow config、Flow runtime API/tool |
| 04 | [Hardening](plan-04-hardening.md) | [Acceptance 04](acceptance-04-hardening.md) | 01–03 | 恢复、性能、旧 Flow 隔离 |

全部阶段通过后执行 [Final Acceptance](acceptance-final.md)。

```text
wiki-system-redesign FINAL + merge → 00 → 01 → 02 → 03 → 04 → FINAL
```

## 不变量

- 一个 Project 可有多个命名 FlowDefinition；active version 按 definitionId 独立绑定。
- FlowInstance 固定 definition version/digest。
- dependency、composition、related 是三种不同关系。
- Flow 不引用 Work，也不直接 dispatch Agent。
- Project 管 definition；Flow 管 instance runtime；权限仍按工具名配置。
- 新 Flow 不调用或双写旧 Requirement。
