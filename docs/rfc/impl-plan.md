# v0.8 实现计划（impl-plan）

> 本文档是 [workflow-spec.md](./workflow-spec.md) 的**实现拆解**：把规范里的「落地待办」(§6/§7.7/§8.7/§9.6/§10.10/§11.11) + 流程重做(§4/§1.5)按依赖顺序拆成阶段,每阶段给**任务清单 + 验收标准 + 测试要求**。
> 规范是「为什么/是什么」,本文档是「按什么顺序做、怎么算 done」。

## 推进方式

- **sub1 实现**每一阶段(按本文件的阶段顺序)。
- **sub2 独立验收** + **写测试 + 跑测试**(unit + 已有 e2e 基建,见 `project-e2e-test-setup`)。
- 验收通过 → commit git → 下一阶段;不通过 → 把 sub2 的理由喂回 sub1 迭代到通过。
- 每阶段宣称完成前:`npm run build:lib`(tsc 类型检查,契约见 `feedback-build-verification`)+ 测试绿。
- schema 变更走显式 migration + 同步 `*_COLUMNS`(契约 1.2)。
- 遇到规范没覆盖或无法解决的问题,停下来问用户。

## 关键路径与并行

- **关键路径**:P0 → P1 → P2 → P3 → P7(流程闭环)。
- 可并行:**P4(cron)/ P5(project)/ P6(template+seed)** 互相独立,关键路径推进到 P2 后可穿插。
- **P8(UI 收尾)** 依赖 P1/P2;**P9(清理)** 最后。

---

## P0 — 基础:数据模型 & schema

**目标**:把所有类型/表结构改到位,为后面所有阶段铺地基。不含逻辑,只动类型 + schema + migration。

**任务**
1. `AgentRecord`(`src/shared/types.ts`):加 `subagents?: [{agentId, name?, description?}]`、`wikiAnchors?: [{nodeId, inject, depth?}]`;**删 `roleTag`**。
2. `db-migration.ts`:`AGENT_COLUMNS` 同步(加 subagents/wikiAnchors JSON 列,删 roleTag 列)+ 显式 migration(旧库 ALTER 加列;roleTag 列保留但不再用,避免破坏现有数据)。
3. `wiki_nodes` 表:加 `links`(JSON 无向数组)列。(`type`/`detail` 的去除移到 P1,随正文移磁盘一起做,避免中间态破坏。)
4. `crons` 表:`schedule` 改存结构化 JSON;加列 `trigger_mode`/`last_run_at`/`last_status`/`last_error`/`next_run_at` + migration 映射旧 schedule(hourly→interval 3600000;daily→alarm time+[];weekly→alarm+[当日];off→enabled=false)。
5. 新表 `cron_runs`(id, cron_id, fired_at, agent_id, session_id, success, error, duration_ms, tokens, cost)。
6. 新表 `tool_configs`(工具默认参数配置)+ `tool_usage`(工具调用记录)。
7. 所有 migration 遵契约 1.2:分支处理空表/非空表;`*_COLUMNS` 同步。

**验收**
- fresh DB 启动:新表/新列齐全,zero-core 正常起。
- 旧 DB(当前 dev 库)启动:migration 跑通,不崩,数据不丢。
- `npm run build:lib` 通过(tsc)。

**测试(sub2 写+跑)**
- migration 测试:构造旧 schema 库 → 跑 migration → 断言新列/新表 + 旧数据保留。
- store CRUD 测试:AgentStore 读写 subagents/wikiAnchors;CronStore 读写三模式 schedule + 新列。

---

## P1 — wiki 存储分离 + 多锚点

**目标**:wiki 正文移磁盘、FS 隔离、多锚点权限 + 注入。规范 §10。

**任务**
1. wiki 正文 → `~/.zero-core/wiki/<path>.md`:WikiStore 读写正文改走文件;DB 只存结构(`id/parentId/path/title/summary/docPointer/links/flags/timestamps`)。去除 `detail` 列(随正文移走,P0 没动)。
2. 去除 `type` 列(位置即类型,§10.4);migration 按原 type 决定节点归到 projects/knowledge/memory 哪个父。
3. **FS 隔离**:agent 工具层禁止 Read/Shell/Grep 等访问 `~/.zero-core/wiki/`(路径不暴露/不授权),正文只走 wiki 工具。
4. **多锚点 scope guard**(替 `assertNodeInsideProjectScope`):session 锚点 = 自动(memory/<agentId> + project=wiki-root:<projectId>) ∪ 自由(`wikiAnchors`);读+写统一「目标在 caller 任一锚点子树内」。
5. **锚点注入**(§10.6):每锚点按 inject(system/context/off)走 SystemPromptAssembler section 或 PreLLMCall context builder;project 锚点展 2 层 title+summary,memory 锚点注索引(MEMORY.md 式)。

**验收**
- wiki 节点正文在磁盘文件;改正文不动 DB。
- agent 用 FS 工具读 `~/.zero-core/wiki/` 被 reject。
- 项目角色 session 只看本项目子树 + 自己 memory(zero 看全树);写域同边界。
- 注入渲染:project 锚点出 2 层结构,memory 出索引。

**测试**
- store:正文磁盘 round-trip;scope guard:锚点并集可见性(项目角色看不到别项目/全局根)。
- 注入:snapshot 2 层结构 + memory 索引的渲染输出。
- FS 隔离:agent-loop 拦截 wiki 路径访问。

---

## P2 — agent 运行时

**目标**:废 agent-as-tool、subagents 委派、memory 合并进 wiki、context builder 整合。规范 §11。

**任务**
1. **废 agent-as-tool**:删 `AgentToolEntry`/`buildAgentTools`/`ExposeAgentAsTool`/agent-tool-entries 表引用;caller agent-loop 不再从 entries 建工具。
2. **subagents 委派**:agent-loop 按 `AgentRecord.subagents` 派生委派入口(复用 `delegateTask`,继承 caller bundle);委派入口只出现在 caller 工具配置,不进全局工具 UI。
3. **memory 合并进 wiki**(§11.6):memory = `memory/<agentId>/` 子树;废 `MemoryRecall`/`memory-hooks` 独立召回/legacy FTS5(`memory-recall.ts`);提取者 A 用 `Wiki(upsert)` 写、agent 自写。
4. **context builder 整合**(§11.7):wiki 动态锚点 + memory 索引 + current-task + env/guidelines;均不入 message history。
5. 清掉运行时对 `roleTag` 的依赖(runtime 侧;service 侧 findPmAgent 等留 P7)。

**验收**
- 委派走 subagents(无 agent-tool-entries);caller 能 delegateTask 到 subagents 列表里的 agent。
- memory 是 wiki 节点;无 MemoryRecall 二套系统。
- context 层含 wiki+memory 注入。

**测试**
- 委派:caller→subagent 调用 + 结果返回 + bundle 继承。
- memory-as-wiki:写入/索引注入/expand 读取。
- context builder:注入内容正确。

---

## P3 — 工具重组

**目标**:zero 4 个 action 工具 + 平台原语扁平 + 工作流工具(含 verify)+ tool_configs/usage。规范 §7.3/§11.4。

**任务**
1. **zero 4 action 工具**:`Project`/`Agent`/`Cron`/`Wiki`,判别联合 schema(§7.3/§8.2/§9.4/§10.7)。
2. **平台原语保持扁平**:Shell/Read/Write/Edit/Grep/Glob 不动。
3. **工作流域工具**:`Orchestrate`(lead,既有)、`CreateRequirement`(PM 建需求+文档)、`verify`(lead 提交 → 按 `req.createdByAgentId` 调 PM 判,§4.5)。verify 工具是阻塞工具(await PM verdict)。
4. 删 `InstantiatePreset`/`SetToolPolicy`/`SetToolEnabled`/`ExposeAgentAsTool`/`UnexposeAgentAsTool` 工具(toolPolicy 并入 Agent update)。
5. `tool_configs`/`tool_usage` 落库(默认 config + 每次调用记录)。

**验收**
- zero 工具集 = 4 action 工具 + 原语 + Wiki;无 InstantiatePreset/expose 工具。
- verify 工具提交后调 PM、拿到 verdict 返回 lead。
- 工具调用落 tool_usage。

**测试**
- 4 action 工具各 action 的 schema + 行为。
- verify 工具:end-to-end(lead 提交 → PM 判 → verdict 返回)。

---

## P4 — cron 重写 + 调度台

**目标**:三模式调度器 + cron_runs + 调度台 UI。规范 §9。

**任务**
1. `CronSchedule` 三模式(once/alarm/interval);废 `parseSchedule` 命名档。
2. CronManager 重写:按 mode 调度(setTimeout/interval/compute-next);启动恢复;missed-once 不补跑(置 disable + 记 missed)。
3. 每次触发落 `cron_runs`;回写 `last_run_at`/`last_status`/`next_run_at`。
4. Cron action 工具(create/update/delete/get/list/trigger)。
5. 调度台 UI(顶级页):24h 时间轴 + 闹钟卡片网格 + 分组切换 + 闹钟式新建。
6. 删 project 域 dead 调度通道(pause/resume/updateInterval,§8.6)。

**验收**
- once 到点触发后 disable;alarm 按日重复;interval 按节奏;missed-once 不补。
- cron_runs 有记录;UI 展示时间轴/卡片/倒计时。

**测试**
- 调度器:三模式各触发一次(用假时钟)+ missed-once 不补。
- cron_runs 落记录。

---

## P5 — project 模块 + 项目页

**目标**:容器视图 + 项目页(替看板)+ 死代码清理。规范 §8。

**任务**
1. `Project` action 工具(create/update/delete/get/list);`get(includeContext)` 返回容器视图(§8.4:requirementsByStatus + crons + wikiSummary + activeSessions)。
2. create 副作用:同步 `ensureProjectSubtree`(空根)+ 异步 kick archivist 渐进扫描。
3. 项目页(替换看板页):左列表 + 右三 tab(仪表盘+动态 / 项目视图 / 看板)+ 新建项目。
4. 仪表盘:更新情况(wiki 扫描进度/git main HEAD/sync 时间)+ 资源消耗(sessions 表 token SUM by projectId,§8.5);动态:status_history+messages+cron usage 派生。
5. 死代码:删 pause/resume/updateInterval IPC + handler + REST;删 trigger-analysis;级联删除补删 crons。

**验收**
- 容器视图一处拿全;项目页三 tab 可用;资源消耗按 project 聚合正确。
- 删除 project 级联清 requirements+task_steps+wiki 子树+crons。

**测试**
- 容器视图 API 测试(聚合正确)。
- 级联删除测试(crons 也被删)。
- 资源消耗 SUM 正确。

---

## P6 — 角色 template + fresh-DB seed

**目标**:Preset→Template 改名、§12 prompt 原地改、seed。规范 §7.1/§7.2/§12。

**任务**
1. **Preset → Template 改名**:`role-presets.ts`→`role-templates.ts`、`ROLE_PRESETS`→`ROLE_TEMPLATES`、`getPreset/listPresets`→`getTemplate/listTemplates`、`buildAgentFromPreset`→`buildAgentFromTemplate`;preset-router→template-router;zero-admin 引用同步。
2. **§12 prompt 原地改**(在现有 role-templates.ts 基础上,§12 内容):zero/pm/lead/archivist/developer/reviewer/qa 的 system prompt 适配 v0.8(去 verify notify、lead 不合并、verify 门、memory 合并等);**把混进 system prompt 的任务规则/输出格式挪到工具**(§12 三层原则)。
3. **analyzer/planner 模板保留不动**(抽象定义,不用)。
4. **fresh-DB seed**(`startServer` 内,`agentStore.list().length===0` 时):seed 一个 zero agent(workspaceDir=`~/.zero-core`)+ wiki `knowledge/software-dev` 节点(含 software-dev 工作流配置)。两者 **protected 不可删**(delete reject)。

**验收**
- fresh DB 启动:自动有 zero agent + software-dev 节点;两者 delete 被 reject。
- 全仓无 Preset 残留(除注释);prompt 符合 §12。

**测试**
- seed 测试(空库 → seed 两条)+ protected-delete 测试。
- prompt 内容断言(关键字段:lead 提交 verify、PM 判覆盖、archivist 合并)。

---

## P7 — 流程重做(拉模型)

**目标**:废 router/notify,verify 工具调 PM,PM 委派 archivist,discuss 按 id。规范 §1.5/§4。

**任务**
1. 删 `ProjectNotificationRouter` + `requirement-hooks.ts` 里的 `notify(...)` 推送。
2. **verify 工具调 PM**:lead 提交 verify → 工具按 `req.createdByAgentId`/`reviewer_agent_id` 调 PM 判 → verdict 返回 lead(P3 的 verify 工具实现闭环)。
3. **PM 委派 archivist**:PM 判通过 → delegateTask(archivist) 合并(archivist 是 PM subagent,zero 配);archivist merge 后置 archived + 增量扫描。
4. **discuss 按 createdByAgentId**:`pm:openDiscuss` 用 `req.createdByAgentId` 定位 PM(删 `findPmAgent`)。
5. requirement-hooks 重做:状态流转(plan→build on PostToolUse)保留为平台数据;**不再** PostTurnComplete 自动 verify(verify 是 lead 显式提交);删 verify_accept 推送。
6. lead 自动领下一个(autoPickupIfIdle primary + cron fallback)。

**验收**
- 端到端拉模型:pipeline ready→plan(confirm)→build→verify(lead 提交,PM 判)→archivist 合并→archived;全程无 router/notify。
- verify 不通过 → lead 收意见 → 改计划重提。
- discuss 跳转打开正确 PM session(by createdByAgentId)+ 需求文档。

**测试**
- 端到端流程测试(用 mock provider,ZERO_CORE_TEST_FIXTURE)。
- verify verdict 往返(通过/不通过)。
- discuss-by-id。

---

## P8 — UI 收尾

**目标**:wiki 浏览器 + agent 配置页。规范 §10.9/§11.10。

**任务**
1. WikiPage 升级为全局树浏览器(左树按锚点截断 + 右正文 expand);zero 看全树,项目角色看本子树。
2. agent 配置页:身份(name/systemPrompt/model/provider,无 roleTag)/ 工具(toolPolicy)/ 委派(subagents)/ wiki 锚点(自由锚点 + 自动锚点 inject 覆盖)/ template 参考(listTemplates/getTemplate)。

**验收**
- wiki 浏览器按角色显示正确可见域;配置页能改全 harness 字段。

**测试**
- e2e:wiki 浏览器渲染 + 配置页编辑保存。

---

## P9 — 清理

**目标**:dead path + 债务。规范 §6。

**任务**
1. dead IPC path:`src/main/ipc.ts` registerIpc + `src/main/ipc/{cron,orchestrate,pm}-handlers.ts` + typed-ipc.ts + core.ts ctx 装配(确认无引用后删)。
2. CronAnalysisManager legacy aliases(`restoreSchedulesForProjects` 等 no-op)。
3. 其余 §6 债务项。

**验收**
- 删除后 `npm run build:lib` + 全测试绿;dev 启动无 `No handler registered`。

**测试**
- 回归:全测试套件绿。

---

## 全局完成定义(每个阶段都要)

- `npm run build:lib`(tsc)通过。
- sub2 写的该阶段测试绿 + 已有测试不退化。
- schema 变更:旧 DB migration 跑通(契约 1.2)。
- 该阶段规范引用的「落地待办」对应项可勾。
