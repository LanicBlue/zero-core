# Acceptance 04：Wait、跨 Turn 任务事件与后台硬门禁

- [ ] running/finishing task 存在时 Session 始终有 active/continuation Turn。
- [ ] Agent 忽略一次提醒后不能自行结束 Turn。
- [ ] background barrier 不循环消耗模型。
- [ ] Stop 后 background task 继续，system continuation 原子建立。
- [ ] task progress/terminal 可跨 Turn，且重复 eventId 只交付一次。
- [ ] 旧 Turn control completion 不能覆盖 continuation 或新 invocation。
- [ ] Wait 多唤醒源按 dispose > Stop > AskUser response > invocation > task > timeout
  集中仲裁且只 settle 一次，未获胜 invocation/task event 不丢失。
- [ ] restart 可为持久 task 恢复 continuation；纯内存任务不伪称可恢复。
