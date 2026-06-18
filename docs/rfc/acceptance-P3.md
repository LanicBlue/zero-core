# Acceptance P3 — 工具重组

> **前置**:P0/P2 完成。**核心**:验「4 action 工具 + verify 工具机制 + 旧工具删除 + tool_usage 落库」,不验调度触发(P4)/ 容器视图(P5)/ 端到端闭环(P7)。

### zero 4 action 工具
- [ ] `Project`(create/update/delete/get/list)、`Agent`(create/update/delete/get/list/listTemplates/getTemplate)、`Cron`(create/update/delete/get/list/trigger)、`Wiki`(expand/read/upsert/search)四个判别联合 schema 工具存在
- [ ] Agent create 接 template 拷身份;update 改 toolPolicy/subagents/wikiAnchors;delete zero protected(reject)
- [ ] Wiki 工具 scope = caller 锚点并集

### 平台原语
- [ ] Shell/Read/Write/Edit/Grep/Glob 扁平独立,按 toolPolicy 开关,未被合并

### 工作流域工具
- [ ] `Orchestrate`(lead)保留,confirm 门阻塞(await 用户)
- [ ] `CreateRequirement`(PM)建需求+文档+落 discuss,幂等
- [ ] `verify`(lead)提交 → 写 payload + 置 status verify → 按 req.createdByAgentId/reviewer_agent_id 调 PM 判 → verdict 返回 lead(阻塞)
- [ ] verify 不通过返回意见;PM 覆盖判断是产品粒度

### 旧工具删除
- [ ] `InstantiatePreset`/`SetToolPolicy`/`SetToolEnabled`/`ExposeAgentAsTool`/`UnexposeAgentAsTool` 已删
- [ ] `tools/index.ts` ALL_TOOLS 更新(无删除项,有 4 action + verify)

### tool_configs / tool_usage
- [ ] 工具调用落 tool_usage(tool_name/agent_id/session_id/params 摘要/success/duration)
- [ ] 默认 config 读写 tool_configs

### 测试(sub2 写 + 跑)
- [ ] 4 action 工具各 action 的 schema + 行为(每个 action 一个用例)
- [ ] verify 工具:lead 提交 → PM 判通过 → verdict 返回;lead 提交 → PM 判不通过 → 意见返回(mock PM)
- [ ] Agent delete zero 被 reject
- [ ] tool_usage 记录写入正确

### 边界(不验证)
- [ ] ~~Cron 三模式调度触发~~ → P4
- [ ] ~~容器视图 includeContext 聚合~~ → P5
- [ ] ~~verify→PM→archivist 端到端闭环~~ → P7
