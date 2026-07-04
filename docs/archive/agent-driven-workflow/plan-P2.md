# Plan P2 — agent 运行时(委派 + memory 合并)

> **依赖**:P0(AgentRecord.subagents/wikiAnchors、wiki memory 子树)+ P1(wiki 多锚点/注入)。
> **对应规范**:§11。**验收**:`acceptance-P2.md`。
> **文件**:`src/runtime/agent-loop.ts`(buildTools)、`src/runtime/tools/agent-tool.ts`、`src/runtime/tools/index.ts`(buildToolsSet)、`src/runtime/subagent-delegator.ts`、`src/runtime/hooks/memory-hooks.ts`、`src/server/memory-recall.ts`、`src/server/extractor-a-service.ts`、`src/runtime/context-message.ts`。

**为什么在 P1 后**:subagents 委派入口 + memory(并入 wiki)都建在 wiki 多锚点 + AgentRecord 字段上。这层立了,P3 工具、P7 流程才有运行时支撑。

## 设计细节要求

### 废 agent-as-tool(§11.5)

1. 删 `AgentToolEntry` 类型、`buildAgentTools`(`tools/agent-tool.ts`)、`ExposeAgentAsTool`/`UnexposeAgentAsTool` 工具、agent-tool-entries 表的运行时读写(`AgentToolStore` 的 register/getAgentToolEntries 调用点)。
2. `agent-loop.ts` `buildTools` 不再 `getAgentToolEntries()` → `buildAgentTools`;改从 `AgentRecord.subagents` 派生委派入口。
3. **表保留还是删**:agent-tool-entries 表本阶段停止读写(P9 清理时再 DROP,避免本阶段 migration 风险)。

### subagents 委派(§11.5)

4. caller agent-loop 按 `AgentRecord.subagents` 每项生成一个委派入口(名字 = subagent.name 或目标 agent.name;描述 = description)。入口调用 `delegateTask(task, {targetAgentId})`,继承 caller context bundle(含 projectId)。
5. 委派入口**不进全局工具 UI**,只出现在该 caller 的工具配置列表。
6. `delegateTask`(`subagent-delegator.ts:96`)targetAgentId 参数化(既可真实 agentId 也可临时 `:sub`),不改默认。

### memory 合并进 wiki(§11.6)

7. memory = `memory/<agentId>/` 子树(wiki 节点,正文 = 记忆内容)。废独立召回系统:
   - 删 `MemoryRecall`(`memory-recall.ts`)/ `memory-hooks.ts` 独立召回 hook / legacy FTS5 memory 存储。
8. **写入**:提取者 A(`extractor-a-service.ts`)按 session 来源(agentId)用 `Wiki(upsert)` 写对应 agent 的 memory 子树;agent 自己也能 `Wiki(upsert)` 写/整理。
9. **读取/召回**:memory 是 agent 自动锚点(P1 已注入索引);具体记忆 `Wiki(expand/read)`;按相关性 `Wiki(search)`(语义召回留将来,给 wiki search 加向量索引)。

### context builder 整合(§11.7)

10. `buildContextMessage`(`context-message.ts`)拼:Environment + Guidelines + wiki 动态锚点(P1 已注入)+ memory 索引 + current-task(session 内变则 context)+ RAG(若用)。均不入 message history。
11. current-task 来源:session 当前处理的 requirement(按 context.projectId + 活跃需求)。

### 清运行时 roleTag

12. runtime 侧(agent-loop/delegator/context)不再读 `AgentRecord.roleTag`。service 侧(findPmAgent 等)留 P7。

## 风险

- **buildTools 改造影响面大**:agent-loop buildTools 是所有 agent 工具装配入口,改 subagents 派生要确保不破坏 FS 工具/Orchestrate 等既有工具装载。
- **memory 合并丢历史**:现有 FTS5 memory 数据迁移到 wiki memory 节点——若数据量大或不可逆,评估是否迁移(测试库可能直接弃)。
- **提取者 A 写入路由**:按 session.agentId 写 memory/<agentId>——跨项目角色(一个 PM 多项目)memory 是共享的(全局 memory/<pmId>),要确认这是期望语义(§11.6 定的是 per-agent 全局)。
- **subagents 委派入口与 toolPolicy 冲突**:委派入口不在 toolPolicy.tools 里(那是硬编码工具开关),两者分开——确认 buildToolsSet 不把 subagents 当 toolPolicy key。

## 不在本阶段

- 4 action 工具 / verify 工具 → **P3**。
- findPmAgent 等 service roleTag 删除 + 路由废除 → **P7**。
- ProjectNotificationRouter 删除 → **P7**。
