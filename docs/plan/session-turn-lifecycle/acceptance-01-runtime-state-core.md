# Acceptance 01：统一运行时状态核心

- [ ] 一个 Session 同时最多一个 active TurnRun。
- [ ] 所有前台 effect completion 携带 turnRunId。
- [ ] 旧 Turn control event 不能改变新 Turn snapshot。
- [ ] task event 不因 origin Turn 已结束而被错误丢弃。
- [ ] snapshot revision 单调，UI/API 可忽略旧 revision。
- [ ] provider capacity 显示为 waiting reason，不再与 input queued 混义。
- [ ] 新状态只有一个写入所有者；旧 adapter 只读。
- [ ] reducer table、race、initial snapshot/增量一致性测试通过。

