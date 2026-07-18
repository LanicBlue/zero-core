# Plan 07：旧路径切换与硬化

## 目标

删除旧状态真相源和兼容分支，完成 race、restart、E2E、架构文档与 Agent Work Runtime
交接。

## 工作

1. 删除/收紧 AgentService runStates、SessionManager lifecycle 和 UI busy/waiting 的旧写路径。
2. 删除 Stop 后自动 drain、force-Wait 二次放行和 AskUser 无 scope timeout 路径。
3. 删除 AgentLoop 私有 retry/backoff、未完成 stream 内工具自动执行和 Assistant error
   message 兼容路径。
4. 搜索所有 session/agent lifecycle event，确保 DTO、revision、turnRunId 完整。
5. 运行 Stop/Wait/AskUser/task/compaction/provider failure 的故障注入与竞争测试。
6. 运行 restart/reconnect/E2E，检查 listener/promise/task/event inbox/provider waiter 泄漏。
7. 更新 `docs/basic`、`docs/arch`、术语表和技术债 D-004 状态。
8. 为 Agent Work Runtime Plan 02 生成明确 handoff：可用接口、禁止 fallback、待它完成的
   context 收紧。

## 完成

[Acceptance 07](acceptance-07-cutover-hardening.md) 通过并创建 `result-07.md`。
