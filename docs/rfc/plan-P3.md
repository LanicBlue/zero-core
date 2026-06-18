# Plan P3 — 工具重组(4 action + verify)

> **依赖**:P0(tool_configs/tool_usage 表)+ P2(subagents 委派入口、agent-loop buildTools 改造)。
> **对应规范**:§7.3 / §11.4 / §4.5。**验收**:`acceptance-P3.md`。
> **文件**:`src/runtime/tools/zero-admin-tools.ts`、`src/runtime/tools/index.ts`、`src/runtime/tools/orchestrate-*`、`src/server/zero-admin-service.ts`、PM 工具(requirement-tools)、verify 工具(新)。

**为什么在 P2 后**:工具装配挂在 agent-loop buildTools(P2 已改 subagents);4 action 工具 + verify 是 zero/lead/PM 的能力落地。这层立了,P7 流程(verify→PM)才跑得通。

## 设计细节要求

### zero 4 action 工具(§7.3 / §8.2 / §9.4 / §10.7)

1. **`Project`**:判别联合 schema,action=create/update/delete/get/list(§8.2)。create 同步 ensureProjectSubtree + 异步 kick 扫描;get 支持 includeContext(容器视图,P5 细化,本阶段先返回元数据)。
2. **`Agent`**:action=create/update/delete/get/list/listTemplates/getTemplate(§7.3)。create 接 template(从模板拷身份);update 改 toolPolicy/subagents/wikiAnchors 全走这里。delete zero protected。
3. **`Cron`**:action=create/update/delete/get/list/trigger(§9.4)。本阶段接 P0 的三模式 schedule(调度逻辑 P4)。
4. **`Wiki`**:action=expand/read/upsert/search(§10.7),scope=caller 锚点并集(P1)。
5. 四个工具都 `buildTool` + 判别联合 inputSchema(zod discriminatedUnion)。

### 平台原语(扁平,不动)

6. Shell/Read/Write/Edit/Grep/Glob 保持扁平独立(§11.4),按 toolPolicy 开关。

### 工作流域工具(§11.4 / §4.5)

7. **`Orchestrate`**(lead,既有):保留,confirm 门(阻塞工具 await 用户,ConfirmRegistry)。
8. **`CreateRequirement`**(PM):建需求记录 + repo 文档(复用 `PmService.createRequirementWithDoc`,§4.1),落 discuss 栏。幂等(同 title no-op)。
9. **`verify`**(lead 提交):lead 调用 → 写 verify payload + 置 status `verify` → 工具按 `req.createdByAgentId`/`reviewer_agent_id` 调 PM 判(§4.5)→ await PM verdict → return 给 lead。**阻塞工具**(等 PM)。不通过返回意见,lead 据此改计划重提(P7 闭环)。
10. verify 工具调 PM 的机制:激活 PM 的 {PM, projectId} session 跑覆盖判断(复用 delegateTask 或 session 激活),拿 verdict。

### 删旧工具(§7.7)

11. 删 `InstantiatePreset`(由 Agent create + template 替代)、`SetToolPolicy`/`SetToolEnabled`(并入 Agent update)、`ExposeAgentAsTool`/`UnexposeAgentAsTool`(P2 已废 expose)。
12. `tools/index.ts` ALL_TOOLS 更新:去删除的,加 4 action 工具 + verify。

### tool_configs / tool_usage 落库(§7.7#4)

13. 工具调用时落 `tool_usage`(tool_name/agent_id/session_id/params 摘要/success/duration);默认 config 读写 `tool_configs`。本阶段先把记录链路接上(读多用 P5 仪表盘)。

## 风险

- **判别联合 schema 复杂度**:4 工具各多 action,zod discriminatedUnion 写错易致 LLM 调用失败;每个 action 单测。
- **verify 阻塞 PM**:verify 工具 await PM 判,PM 跑覆盖判断可能慢/失败——超时/失败处理要明确(默认返回 fail+意见让 lead 重提,还是 error)。
- **PM 覆盖判断调用**:verify 工具激活 PM session 跑判断,与 PM 自己的 cron 巡检 session 是同一个(按 createdByAgentId+projectId)?确认不冲突。
- **tool_usage 量**:每次工具调用都写库,高频场景写放大;params 摘要要截断。

## 不在本阶段

- Cron 三模式调度触发逻辑 / cron_runs 写入 → **P4**(本阶段 Cron 工具只接 store CRUD)。
- 容器视图 includeContext 聚合 → **P5**。
- verify→PM 的端到端流程闭环(archivist 合并等)→ **P7**(本阶段 verify 工具机制就绪)。
