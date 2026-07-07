# sub-7:补完 sub-2 —— work-context hook 真正拆解到三通道

> 这是 sub-2 欠交付的补完(sub-2 原本只删了 Current Task,主体被错误标"延后")。依赖 sub-1(workbench 通道)。对应 design §1.1/§1.2/§1.3。

## 背景(为什么欠交付)

`workflow-context-hook.ts`(server 层,PreLLMCall)对 work session 把 Project / Wiki Baseline / Requirement / Steps Progress 全塞进 `memoryContext` → 渲染成 context 块的 `## Recalled Memories`(误标 —— 装的不是 memory)。design §1.1 要求按变化频率重分配到三通道,sub-2 该做没做。

## 任务

按 design §1.1 分配:
1. **Project / Requirement / Wiki Baseline → system**(按需段)。
2. **Steps Progress → workbench**(per-step)。
3. **Wiki Anchors 合并**:renderSystemAnchors + renderContextAnchors 合一(system,根 summary + 一层),默认不更新。
4. **context 通道**只剩 Recalled Memories(持久日志机制;recall 源 = wiki memory 子树,**本次仍空**,记忆写入未完善 —— 只保证机制位就绪、不再被工作信息占用)。
5. 删 `memoryContext` 误标 + 旧 work-context hook 的 memoryContext 注入路径。

## DI 关键(不许 runtime import server)

system prompt 在 runtime(AgentLoop,SystemPromptAssembler)组装,work-context 数据在 server stores。解法(仿 wikiStore/wikiAnchors 注入):
- agent-service 建 SessionConfig 时注入**渲染闭包**(或 store 接口),如 `config.workContextSystemSection?: () => string`(Project/Requirement/Wiki Baseline)、`config.stepsProgressSection?: () => string`(Steps Progress)。
- AgentLoop 加 system 段 `{ name:"work-context", compute: () => config.workContextSystemSection?.() ?? "", cacheBreak:false }`(on-demand,invalidate on change)。
- workbench.ts renderWorkbench 加 Steps Progress 段(调 `config.stepsProgressSection`)—— 但 workbench 渲染在 runtime,需 steps 数据经 config 注入(同上闭包)。
- 闭包在 server 侧(agent-service)捕获 projectStore/requirementStore/taskStepStore,runtime 只调函数,不碰 server 类型 → 不跨层。

## 范围确认

- 本次做 1-5 的**机制 + 数据迁移**。
- recall 实际接入(产生 Recalled Memories)不在本次(记忆写入未完善)。
- 不动 todos(workbench 已有,sub-1)、task 状态(sub-4 workbench Task 段)。

## 风险

- system 段注入闭包的生命周期:work-context 随 activeRequirement 变,需 hot config 时 invalidate(类似 wiki-system-anchors)。
- Steps Progress 进 workbench:每 step 重渲染,steps 多时 token —— 紧凑渲染(只 role: title: icon)。
- 删旧 memoryContext 路径要同步改 context-message.ts(去 memoryContext?或保留为 recall 专用)。

## 验收

见 `acceptance-7.md`。
