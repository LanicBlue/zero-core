# Plan P7 — 流程重做(拉模型,关键路径终点)

> **依赖**:P2(subagents 委派)+ P3(verify 工具)+ P6(PM/archivist prompt)。关键路径终点。
> **对应规范**:§1.5 / §4。**验收**:`acceptance-P7.md`。
> **文件**:`src/server/project-notification-router.ts`(删)、`src/server/requirement-hooks.ts`、`src/server/pm-service.ts`(findPmAgent/openDiscussSession/submitCoverageVerdict)、`src/server/archivist-service.ts`(mergeFeatureToMain)、`src/server/lead-service.ts`。

**为什么是终点**:前面所有阶段的数据/工具/委派/seed 都是为这条端到端流程服务。这层把 router/notify 废掉、改成拉模型,流程闭环。

## 设计细节要求

### 废 router/notify(§1.5)

1. 删 `ProjectNotificationRouter` + 所有 `notify(...)` 调用点(requirement-hooks / pm-service / lead-service)。
2. requirement-hooks 重做:
   - 保留 plan→build 状态流转(PostToolUse 监听 Orchestrate,步骤>0 时 build)。
   - **删** PostTurnComplete 自动 build→verify(verify 是 lead 显式提交,P3 的 verify 工具置 status)。
   - **删** verify_accept/verify 推送。

### verify 工具调 PM(§4.5,P3 工具的闭环)

3. lead 提交 verify(P3 工具)→ 按 `req.createdByAgentId`/`reviewer_agent_id` 调 PM session 跑覆盖判断 → verdict 返回 lead。
4. verdict 通过 → 置 status 待合并(或直接驱动 archivist);不通过 → 意见回 lead,lead 改计划重提。

### PM 委派 archivist 合并(§4.6)

5. PM 判通过 → `delegateTask(archivist, "merge req X")`(archivist 是 PM subagent,zero 配)→ archivist `mergeFeatureToMain` + 增量扫描 → 置 archived。
6. PM 的 subagents 含 archivist(由 software-dev playbook/seed 决定,zero 组装时配)。

### discuss 按 createdByAgentId(§4.2)

7. `pm:openDiscuss` 改用 `req.createdByAgentId` 定位 PM session(删 `PmService.findPmAgent` 的 roleTag 查找);REST `/api/pm/:requirementId/discuss`。
8. discuss = 打开 PM session + 需求文档。

### lead 自动领取(§4.3)

9. lead 完成上一需求后 `autoPickupIfIdle` 自动领下一个(primary);cron 激活保底(fallback)。删旧的 notify("ready") 推送路径。

### service roleTag 清理

10. 删 pm-service `findPmAgent`(按 roleTag)、ProjectNotificationRouter 里的 role-based 查找;所有寻址改用 req 记录的 agentId(§1.5)。
11. **清 AgentStore legacy "Zero" 默认 seed**(`agent-store.ts` 构造函数的 `DEFAULT_AGENT` + 默认 seed 逻辑):P6 的 fresh-db-seed 用幂等 name="zero" guard 绕开它,本阶段清掉 legacy 默认,让 `agentStore.list().length===0` 在真正空库成立。

## 风险

- **端到端链路长**:ready→plan(confirm)→build→verify(PM)→archivist 合并→archived,任一环断流程卡;需 mock provider 跑完整 e2e。
- **verify 阻塞 + PM 判断失败**:PM 覆盖判断失败/超时,verify 工具要降级(默认返回 fail+意见让 lead 重提,不卡死)。
- **archivist 不是 PM subagent 时**:若 zero 没配 archivist 为 PM subagent,PM 判通过后无法委派合并——流程卡在待合并。兜底:archivist cron 拉待合并状态自行处理(§4.6 注)。
- **状态机回退**:verify 不通过回 plan,lead 改计划重提——确认 status 流转允许 plan←verify 回退,不卡死。

## 不在本阶段

- verify 工具机制本身 → P3(本阶段是端到端接通)。
- agent-as-tool / subagents 委派机制 → P2。
- requirement-hooks 的 plan→build 保留部分已存在,本阶段只删 verify 推送。
