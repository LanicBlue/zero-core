# Acceptance 05：Work API 与 Agent 工具切换

对应 [Plan 05](plan-05-work-api-tool-cutover.md)。

- [ ] Project 是 WorkDefinition 配置和 manual fire 的唯一 Agent 工具入口。
- [ ] Work 只有 WorkRun runtime action，无 definition CRUD/manual fire。
- [ ] Work schema/prompt/registration/policy 在同一提交切换，无 feature flag 双语义。
- [ ] WorkRun mutation 只作用于当前 Agent Session；跨 scope 稳定拒绝。
- [ ] 没有 Work 工具的 Agent仍可执行 dispatcher 分配的 run，但不能调整 queue。
- [ ] Agent不能直接设置 terminal status 或修改 snapshot。
- [ ] API reconnect/refetch 从持久事实恢复，不依赖进程内 event。
