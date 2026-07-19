# Acceptance 04：Project Flow System 加固

对应 [Plan 04](plan-04-hardening.md)。

- [ ] 控制仓库、transition、event、binding 和三类关系索引的中断恢复有自动化矩阵。
- [ ] 一个 Project 损坏不会阻塞其他 Project 或全局 Agent。
- [ ] duplicate event、并发 dependency cycle、related 并发写和 split/merge 部分失败稳定。
- [ ] 规模 benchmark 达到 result 开始前记录的阈值，无 skipped/only 绕过。
- [ ] 生产 Flow 无 fixed action、Work 引用或 Requirement 双写。
- [ ] 活动架构文档只描述已经通过验收的事实。
- [ ] typecheck、build:lib、unit、build、E2E 和 check:links 全部成功。
