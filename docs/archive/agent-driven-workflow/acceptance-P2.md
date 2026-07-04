# Acceptance P2 — agent 运行时

> **前置**:P0/P1 完成。**核心**:验「废 agent-as-tool + subagents 委派 + memory 合并 + context 整合」,不验 4 action 工具(P3)/ 路由废除(P7)。

### 废 agent-as-tool
- [ ] `AgentToolEntry`/`buildAgentTools`/`ExposeAgentAsTool`/`UnexposeAgentAsTool` 已删,grep 无运行时引用
- [ ] agent-loop `buildTools` 不再从 agent-tool-entries 建工具
- [ ] agent-tool-entries 表停止读写(P9 再 DROP)

### subagents 委派
- [ ] agent-loop 按 `AgentRecord.subagents` 派生委派入口(名/描述正确)
- [ ] caller 能 `delegateTask` 到 subagents 列表里的 agent;结果返回 caller;继承 caller bundle(含 projectId)
- [ ] 委派入口不进全局工具 UI,只在 caller 工具配置列表
- [ ] toolPolicy.tools(硬编码工具)与 subagents(委派)分开,互不干扰

### memory 合并进 wiki
- [ ] `MemoryRecall`/`memory-hooks` 独立召回/FTS5 已废;memory 是 `memory/<agentId>/` wiki 子树
- [ ] 提取者 A 按 session.agentId 用 `Wiki(upsert)` 写 memory;agent 自写可用
- [ ] memory 索引注入(P1 已做)+ `Wiki(expand/read)` 取具体 + `Wiki(search)` 找
- [ ] 无第二套召回系统

### context builder 整合
- [ ] `buildContextMessage` 含 env/guidelines/wiki 动态锚点/memory 索引/current-task
- [ ] context 内容不入 message history(每轮重算)

### 运行时 roleTag
- [ ] runtime 侧(agent-loop/delegator/context)不读 roleTag
- [ ] service 侧 findPmAgent 等暂留(P7 清)

### 测试(sub2 写 + 跑)
- [ ] 委派:caller→subagent 调用 + 结果返回 + bundle 继承(projectId 带过去)
- [ ] memory-as-wiki:提取者写入 → 索引注入 → expand 读取 一致
- [ ] context builder:注入内容正确(snapshot)
- [ ] subagents 空 vs 非空:空则无委派入口,不报错

### 边界(不验证)
- [ ] ~~4 action 工具 / verify 工具~~ → P3
- [ ] ~~findPmAgent 删 / router 删~~ → P7
