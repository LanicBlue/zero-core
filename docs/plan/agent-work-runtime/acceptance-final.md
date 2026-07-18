# Final Acceptance：Agent Work Runtime

> 只在 Acceptance 00–06 全部通过后执行。

- [ ] Flow event 到 durable WorkRun 幂等，Session busy 不丢任务。
- [ ] Agent Session 保持 Project 绑定而非 Flow 绑定，可审计选择多个任务。
- [ ] defer/prioritize/switch 安全且不产生并发 Turn 或 context 泄漏。
- [ ] Stop/Wait/用户队列行为只使用 Session Lifecycle supervisor。
- [ ] `flow://`/`skill://` 和物理 `.zero-core` 隐藏合同成立。
- [ ] project/worktree/agent workspace policy 与失败语义成立。
- [ ] Project/Work 工具级边界成立，旧 Work 新系统路径为零。
- [ ] 独立验收 Agent 明确记录 PASS。
