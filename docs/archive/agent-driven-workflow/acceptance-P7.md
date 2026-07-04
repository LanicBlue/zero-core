# Acceptance P7 — 流程重做(拉模型)

> **前置**:P2/P3/P6。**核心**:验「端到端拉模型闭环 + 无 router/notify + 寻址按 agentId」。这是关键路径终点。

### 废 router/notify
- [ ] `ProjectNotificationRouter` 已删;grep 无 notify(...) 推送
- [ ] requirement-hooks:plan→build 保留;PostTurnComplete 自动 verify 已删;verify_accept 推送已删
- [ ] verify 是 lead 显式提交(置 status verify),非 hook 自动

### verify 工具调 PM
- [ ] lead 提交 verify → 按 req.createdByAgentId/reviewer_agent_id 调 PM 判 → verdict 返回 lead
- [ ] 通过 → 驱动 archivist;不通过 → 意见回 lead
- [ ] PM 失败/超时降级(返回 fail+意见,不卡死)

### PM 委派 archivist 合并
- [ ] PM 判通过 → delegateTask(archivist) 合并(archivist 是 PM subagent)
- [ ] archivist mergeFeatureToMain + 增量扫描 → 置 archived
- [ ] 兜底:archivist cron 拉待合并状态自行处理(PM 无 subagent 时)

### discuss 按 createdByAgentId
- [ ] pm:openDiscuss 用 req.createdByAgentId 定位 PM(删 findPmAgent roleTag 查找)
- [ ] discuss = 打开 PM session + 需求文档

### lead 自动领取
- [ ] lead 完成上一需求 autoPickupIfIdle 领下一个(primary);cron 保底(fallback)
- [ ] 无 notify("ready") 推送

### service roleTag 清理
- [ ] findPmAgent(roleTag 查找)已删;寻址全用 req 记录的 agentId

### 端到端(核心)
- [ ] **完整 pipeline 跑通**:ready → plan(confirm 门,用户确认) → build(委派 dev/review/qa) → verify(lead 提交,PM 判) → archivist 合并 → archived;全程无 router/notify
- [ ] verify 不通过 → lead 收意见 → 改计划重提 → 通过
- [ ] discuss 跳转打开正确 PM session + 需求文档
- [ ] 全程寻址用 req.createdByAgentId / subagents 图,无角色查找

### 测试(sub2 写 + 跑)
- [ ] 端到端流程测试(mock provider,ZERO_CORE_TEST_FIXTURE)
- [ ] verify verdict 往返(通过/不通过两条路径)
- [ ] discuss-by-id(正确 PM session)
- [ ] 状态机回退(verify 不通过 → plan)

### 边界(不验证)
- [ ] ~~verify 工具机制~~ → P3(本阶段端到端接通)
- [ ] ~~subagents 委派机制~~ → P2
