# Plan 00：Wiki 合并后基线对齐

## 目标

不实现功能；在 Wiki 最终验收并合并后重新定位 Session、Loop、Hook、Task、compression、
HTTP/WS 和 UI 所有者，复现 research 中的关键行为，并锁定与 Agent Eval 的交界。

## 工作

1. 记录当前 commit、Wiki merge commit、dirty files、Node/npm/OS 和 baseline 命令。
2. 映射 lifecycle/run state、Turn boundary、abort signal、provider/tool queue、Wait、AskUser、
   input queue、TaskRegistry、compression、event DTO、UI store 的真实接口。
3. 最小复现：Stop 后 drain、Wait 时双状态、force-Wait 二次结束、晚到 task event、
   insert_now 无下一 step、AskUser Stop、compression 中 Stop。
4. 核对 Agent Eval Plan 04 和 WorkRun dispatcher；标明本计划提供与其消费的契约。
5. 若合并后事实已经修复某项，保存测试证据并删减后续工作，不重新实现。

## 不做

- 不修改生产代码或测试预期。
- 不把 research 的旧行号当最终接口。
- 不在此阶段修改 Agent Eval/Wiki 实现。

## 完成

[Acceptance 00](acceptance-00-reconciliation.md) 通过并创建 `result-00.md`。

