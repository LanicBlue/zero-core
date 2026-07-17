# Plan 04：Wait、跨 Turn 任务事件与后台硬门禁

## 目标

把 Wait 唤醒、Session task event inbox、force-Wait 和 system continuation 组成可验证的不变量。

## 工作

1. TaskRegistry/task supervisor 发布带 eventId 和 originTurnRunId 的 SessionTaskEvent。
2. 持久 task terminal event 具备 dedupe/delivery ledger；进程内 task 明示较弱保证。
3. Wait 的 dispose/Stop/AskUser response/invocation/task/timeout 进入集中仲裁器，按设计顺序
   只 settle 一次并记录 winner；未获胜 invocation/task event 仍保留。
4. TurnEndCheck 首次发现后台任务时保留一次 Wait 提醒。
5. 再次结束时 runtime 自动进入 waiting(background_barrier)，不再调用模型。
6. Stop/错误隔离后后台任务仍在时，原子创建 system continuation Turn。
7. task event 可唤醒当前 Turn/continuation；新 invocation 可 handoff；所有 task terminal 后才允许结束。
8. restart 恢复持久 task 且无 active Turn 时创建 recovering → continuation。
9. 覆盖 task completion 与 input/timeout/Stop 同 tick、重复 terminal event、旧 Turn completion race。

## 完成

[Acceptance 04](acceptance-04-wait-background.md) 通过并创建 `result-04.md`。
