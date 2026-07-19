# Issue：Agent Work Runtime

zero-core 当前 Project Work 没有持久 WorkRun；Session busy 时可能直接 skip，cwd、worktree
和工具上下文又长期固化在 Session/Loop。Agent 因而无法可靠排队多个项目任务，也不能在
保留长期 Project 记忆的同时安全切换执行工作区。

本 effort 负责 WorkDefinition、WorkRun、Agent 自主调度、逐 Turn InvocationContext、
`flow://`/`skill://` VFS 和 Project 内 linked worktree。它消费已经稳定的 Project Flow
事件和 `session-turn-lifecycle` supervisor，不建立第二套 Flow 或 Session 状态机。
