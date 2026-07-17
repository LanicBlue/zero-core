# Acceptance 06：旧路径切换与硬化

- [ ] 全仓只有 supervisor/reducer 能写权威 Session runtime state。
- [ ] 无 Stop 后自动 drain、force-Wait 二次放行或无 scope AskUser。
- [ ] 所有前台事件带 turnRunId，task event 带 eventId/originTurnRunId。
- [ ] race、duplicate、restart、reconnect 和 listener leak 测试通过。
- [ ] active basic/arch 文档只描述新模型。
- [ ] D-004 更新为实际完成证据或剩余缺口，不提前宣称关闭。
- [ ] Agent Eval Plan 04 handoff 可由另一实施 Agent 独立执行。
- [ ] 不存在新旧状态双写 fallback。

