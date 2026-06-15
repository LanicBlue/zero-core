# RFC: Agent 驱动的工作流 — 从配置涌现

> **Status**: Draft v0.7 — 讨论中
> **Author**: Lanic + AI
> **Created**: 2026-06-13
> **Updated**: 2026-06-15
> **Level**: 顶层 RFC
> **关系**: 取代已归档的 `archive/multi-agent-workflow-requirements.md`,修订其中"自动创建 workflow agent"的设计假设（原 M1-M5 计划组已整体归档于 `archive/`）

> **变更沿革**
>
> - **v0.1 → v0.2**:废弃 `workflowRole` + `subAgentChain`,调用图走 agent-as-tool + toolPolicy,workflow 从配置涌现。
> - **v0.2 → v0.3**:保留轻量 `Project` 实体(project 绑定 workspace,agent 绑定 project 或全局),修订 v0.2「去 Project / lead=项目本体」;`analyst` 预设更名 **product manager(PM)**。
> - **v0.3 → v0.4**:**三项目绑定 agent 分工定型** —— PM 独立(自带 cron,管产品/发现/需求/discuss)、lead 收窄(交付 pipeline + 门)、**新增 archivist**(专职 wiki + 需求↔设计 traceability);**Project 升级为通知枢纽**(跨 agent 边界通知,cron 兜底);**discuss 改为文档为中心**(需求文档入 repo、PM chat 页面、无 session 隔离);收敛 Q2/Q5/Q7(详见 §7)。
> - **v0.4 → v0.5**:**archivist 的「read-only」收敛为「逻辑 read-only、文档注释可写」** —— 文件说明书 header、folder README、docs/basic、wiki 都在其写入范围,把补文档债从一次性人工活变成 archivist 常态化职责(由它持续兜住 doctor 标准化门禁);**新增 docs/basic ↔ wiki 分歧信号**作为 archivist 主动产出(意图 vs 现实不一致 → 文档过时则顺手更新 / 代码跑偏则 flag 给 PM·lead)。详见 §2.16。
> - **v0.5 → v0.6**:**设计哲学显式化** —— 工作流目的是「通过层级调用给每个 agent 一个干净视角」(每层只处理自己颗粒度的问题,细节委托下层专门 agent);**沉淀定义为「层级内、私有」**(agent 自己的工具/环境经验积累,服务自己下次,不跨 agent)。据此收敛三处:**(a) wiki node 加 provenance**(只标 archivist 自己该信哪条:代码结构 / commit·ADR·用户 discuss,不泛化成全工作流标签);**(b) 门控 = 工具调用本身**(execute/plan 工具即门,调用即暂停、返回 false+理由,不另设 hook 拦截层);**(c) verify 标准化为证据清单**(PM 验收看清单从 needs-evidence→pass,不引入 productionReady 多门禁聚合)。砍掉 v0.5 候选的 L0/L1/L2 入口分流 —— 本版单流程,简化 PM 判断负担。详见 §2.17。
> - **v0.6 → v0.7**:**wiki 架构根本重构** —— wiki 不是「另一批文档」,是**项目文档的结构本身**:代码文件、需求文档都是 wiki 树的叶子节点,archivist 管的是**结构**(叶子指向的指针 + 它们之间的关系),不是叶子内容。wiki 树在 **zero-core 数据库**里(不在项目 workspace),archivist 对**实际项目文档只读、对 wiki 树读写**。§2.16 那套「archivist 回写代码文件头注释、兜 doctor 门禁」**整块作废** —— 文件说明书从「代码头注释」迁移为「wiki 树里的 header 节点」;**docs/basic 砍掉**(那是 openprd 的产物)。沉淀哲学从 v0.6「私有」改为**「一棵全局 wiki 记忆树,project 子树挂 project 节点下,视角靠 wiki 访问权限做边界」**(项目 agent 根节点 = 自己的 project wiki,看不到更大的根;全局 agent 如 zero 可观测所有 project)。**plan 门重构成 Orchestrate DSL**:lead 用 planner 出大纲 → 拆成 Orchestrate 流程(parallel/pipeline/if/for/barrier)→ Orchestrate.confirm 等用户确认才 run。**验收归 lead/Orchestrate 流程内产出**,PM 只判「改动是否覆盖原需求意图」,不碰技术。详见 §2.16/§2.17/§2.18。

---

## 1. 背景与问题

### 1.1 现状

`archive/multi-agent-workflow-requirements.md`(v4,已归档)及其 M1-M5 实现已落地了一套多 Agent 协同工作流骨架:Analyst 巡检建 Wiki、Lead 编排 sub-agent、Kanban 驱动需求流转。但实际跑通时暴露出一个**根本性的脱节问题**:

**workflow agent 与用户的真实 agent 没有任何绑定关系。**

具体表现:
- `AnalystService.ensureAnalystAgent()` 用名字模式 `Analyst-{projectName}` 扫描 AgentStore 自动创建 agent
- `LeadService.ensureLeadAgent()` 同理创建 `Lead-{projectName}`
- 子 agent(developer/reviewer/qa)由 `createRoleLoopFactory` 临时生成,ID 形如 `role-developer-{timestamp}`,**不持久化**
- 用户实际只有一个 "zero" agent(日常聊天用),系统却凭空造出一个跟它毫无关联的 "Analyst-zero"

> 注:旧 M1-M5 代码里的 `Analyst` 角色即本 RFC 的 **PM(product manager)** 预设前身。

### 1.2 问题本质

1. **双重 agent 体系割裂**:用户的 agent(zero)和系统的 workflow agent(Analyst-zero)是两套东西
2. **角色不可配置**:谁当 PM、谁当 lead 是硬编码的自动行为
3. **cron 与 agent 无关**:定时巡检挂在 ProjectRecord 上,无法针对特定 agent
4. **子 agent 是黑盒**:临时生成、不持久、用户看不见也配不了
5. **Project 概念被过度加载**:旧 `ProjectRecord` 不只是 workspaceDir 容器,还塞了 `analysisInterval` / `status` / `analystCronId` / `analystSessionId` 等 cron 与 session 运行态。正确做法是保留一个**轻量 Project**(只绑定 workspace + 归属成员 agent),把运行态挪回 agent
6. **重复造轮子**:zero-core 已有 agent-as-tool 机制(暴露 + 委托),M1-M5 却另起一套 role/chain 抽象

### 1.3 目标

让 workflow 从 agent 的配置**涌现**,而不是用固定的角色枚举去描述:

- **调用关系复用 agent-as-tool + toolPolicy**,不新造 role/chain 字段
- **定时巡检、需求驱动**变成 agent 上的可配置能力(cron + 指派)
- **轻量 `Project` 实体绑定 workspace + 充当通知枢纽**;agent 绑定 project 或全局
- **项目侧三 agent 分工**(PM 产品 / lead 交付 / archivist 知识),各持 cron、各管一块、互不直接调用,只经 Project 解耦
- **角色降级为 prompt 预设**,非运行时类型

---

## 2. 核心设计:workflow 从配置涌现

### 2.1 设计哲学

**工作流的目的是简化 agent 之间的合作方式,并简化单个 agent 的工作视角与内容。** 人的工作流是人之间的合作,agent 的工作流是 agent 之间的合作 —— 类比成立:人很难在思考宏观问题的同时兼顾细节,agent 同样不应该同时处理不同颗粒度的问题。

**通过 agent 层级调用,让每个 agent 只处理自己视角的问题,不必关心更底层的细节,细节交给专门处理它的下层 agent。** lead 关心交付节奏,不操心 dev 怎么用测试框架;analyzer 关心代码健康度,不操心发现怎么变成需求文档。颗粒度由调用层级天然分层,每层固定,agent 不必自己判断该处理多粗多细。

workflow 因此不是预设的角色脚本,而是 agent 配置形成的**有向图** + 一个归属实体:

- **节点** = agent(各有 projectId/全局、prompt、model、tools)
- **边** = 「A 能调用 B」(A 的 toolPolicy 放行了 B 暴露的工具名)
- **能力** = cron(哪些 agent 定时跑)、requirement 指派(哪个 agent 驱动某需求)
- **归属实体** = 轻量 `Project`(绑定 workspace、看板入口、并发单元、**通知枢纽**)

「角色」(lead/PM/archivist/analyzer/planner/dev/review/qa)不是类型字段,是**可选的 prompt 预设**。

**沉淀 = 一棵全局 wiki 记忆树,通过 wiki 访问权限做视角边界(v0.7 修订 v0.6「私有」)。** 整个 zero-core 只有一棵 wiki 记忆树(存在数据库,不在项目 workspace)。各类文档/记忆都挂在这棵树上:**项目文档**(代码文件、需求文档、ADR)是叶子节点;**项目 wiki** 是挂在 `project` 节点下的子树,即「对这个具体项目的记忆」;其他类型记忆(跨项目经验、工具使用心得等)也挂在各自类型的节点下。**沉淀不硬性按 agent 分割** —— 经验都写进 wiki 树,只是别的 agent 平时用不到所以不读;不是私有存储,是「共用 wiki 里别的 agent 平时不访问的子树」。

**视角边界靠 wiki 访问权限(读取根节点)做。** 项目绑定 agent(PM/lead/archivist)的 wiki 根节点 = 自己的 `project` 子树,看不到更大的根(看不到别的 project、看不到跨项目记忆的更上层结构);全局 agent(如 zero)的根节点更高,可观测所有 project 及其运行情况。这样「干净视角」是结构上强制的:agent 看不到职责范围外的 wiki 节点,自然不会被无关信息干扰 —— 视角隔离从「私有存储」变成「读取边界」,既保持每层视角干净,又让记忆全局可复用(将来某个 agent 需要跨项目经验时,提升权限即可访问,不必重新积累)。详见 §2.18。

### 2.2 调用图:复用现有机制(不加字段)

| 半边 | 现有实现 | 位置 |
|------|---------|------|
| **暴露** | agent 勾选「暴露为工具」→ `AgentToolEntry(type:"internal", agentId:self)`,工具名默认 `kebab(agentName)` | `ExposeAsToolSection.tsx` |
| **消费** | `getAgentToolEntries(callerId)` 返回除自己外所有已暴露 agent;`buildAgentTools` 建工具;`buildToolsSet` 按 caller 的 `toolPolicy` 过滤 | `agent-loop.ts:414`、`tools/index.ts:199` |

`DEFAULT_ENABLED` 仅 `{Shell,Read,Write,Edit,Grep,Glob}`,agent-tool 默认不在其中 → toolPolicy 对 agent-tool **已是 opt-in**,必须显式写 `policy.tools[name]={enabled:true}` 才能调用。

→ **不加** `workflowRole` / `subAgentChain`。前端加「可调用 Agent」选择器,**toolPolicy 对 agent-tool 以 `AgentToolEntry.id`(稳定)为 key 存配置、UI 显示工具名** —— 改名不影响引用,删工具才 orphan(内置工具 Shell/Read/… 名字是常量,仍按名 key)。

### 2.3 Project:绑定 workspace + 通知枢纽 + 生命周期

轻量 `ProjectRecord` = `{ id, name, workspaceDir }`,是**项目本体**:绑定规范化工作目录、看板入口、并发单元、requirements/wiki 归属键、**跨 agent 通知的发出方**。

**agent 与 project 的关系:**
- **项目绑定 agent**(PM、lead、archivist):`projectId` 指向某 Project,有效 workspace = `project.workspaceDir`
- **全局 agent**(analyzer/planner/dev/review/qa、zero):无 `projectId`,运行时继承 caller 的 workspace

**生命周期:**
- **创建**:zero 对话生成(主)+ UI 直接建(辅);**显式创建,不自动**。
- **workspace 唯一 + 不可变**:一个 workspaceDir 只能绑一个 Project(规范化后唯一约束,防 split-brain);创建后不可改,换目录就新建 Project(磁盘挪动靠 Q1 的 realpath 归一吸收)。
- **删除**:**绝不碰 workspace 文件**(Project 纯元数据);**默认 archive**(隐藏出看板、保留数据、可恢复);**硬删(需确认)级联**清掉该 projectId 的 requirements/wiki/task-steps。
- **绑定 agent 随 Project 删除只解绑**(projectId=null)、不删(agent 是配置资产,另行删)。

### 2.4 cron:通用能力,项目侧三 agent 各持

`AgentRecord` 加 `cronSchedule`(off/hourly/daily/weekly) + `cronPrompt`。`CronAnalysisManager` 扫描 `cronSchedule` 非空的 agent 定时触发。

cron 通用,本设计的项目侧分工是:**PM、lead、archivist 各持一个 cron,各管一块** —— PM 管发现/需求,lead 管交付 pipeline,archivist 管 wiki 刷新。三者经 Project 解耦,不互相直接调用。cron 同时充当跨 agent 通知的兜底(见 2.10)。

### 2.5 PM(product manager)侧:独立发现 + 需求 + discuss

PM 是**项目绑定 agent**,自带 cron,管**产品侧**,**独立于 lead**(不再被 lead 调用激活):

- **cron 周期扫描 workspace → 调 analyzer 做专项分析(UI/安全/性能/…)→ 发现问题 → 创建需求文档(新)→ 入 `discuss`**
- **discuss 时与用户对话细化**需求文档,用户确认 → `ready`
- PM 的 cron **只发现/创建新需求,不改已有需求文档;对 wiki 和代码 read-only**(写隔离见 2.12)
- PM 读 archivist 的 wiki 获取项目上下文,写出更好的需求
- 一个 project **一个 PM 作入口 agent**;多样化的产品需求靠 PM 调其他 agent tool(analyzer 等)实现,不靠多 PM

### 2.6 lead 侧:交付 pipeline + 门

lead 是**项目绑定 agent**,自带 cron,管**交付侧**,职责收窄为纯粹的「计划 + 执行管理」:

- **pickup** `ready` 的需求(经 Project 通知或 cron 兜底)→ 写 `assignedAgentId`
- **路由 planner**(按需求类型)拿回 TaskStepRecord 任务队列 → 进 `plan`
- **plan 门**:lead 调 planner 出的 plan 留在 lead 自己的上下文里,**approve 直接续跑 lead**(不经 Project 通知,见 2.10)→ `build`
- **build**:用 execute 工具按队列分步派 dev/review/qa,控节奏、复核结果
- **验收门**:build 完成 → 进 `verify` → Project 通知 PM 验收
- lead 读 archivist 的 wiki 做好 plan

lead 不碰 PM 的需求文档、不碰 archivist 的 wiki、不亲自写代码(全外包给 dev)。

### 2.7 archivist 侧:管 wiki 结构 + 需求↔设计 traceability

archivist 是**项目绑定 agent**,自带 cron,管**知识侧 + main 分支 git**,专职维护项目 wiki 的**结构**(不是叶子内容):

- **对实际项目文档(代码 + 各类文档文件)只读,对 wiki 树可读写**(见 §2.16)。wiki 树在 zero-core 数据库里(不在项目 workspace);archivist 在树上建**结构节点 + 指针**:意图节点指向需求文档、header 节点指向代码文档,并维护节点间关系(模块/依赖/需求↔实现)。它不写代码、不写需求文档本身(那是 PM 的),只读写 wiki 树的结构。
- 周期扫描项目文档 → 更新 wiki 结构(架构、模块、依赖、约定、traceability);扫到文件实质变化 → 更新对应的 wiki 结构节点(header 节点描述、关系、指针),**不改原文件**。
- **兼管 main 分支 git**:统一 commit PM 写的需求文档、verify 后合并 feature→main、清理 worktree(见 §2.15);feature 分支 git 归 lead。archivist 自己产出的 wiki 在数据库,不经 git。
- **PM 和 lead 都读它**:PM 读 wiki 写好需求,lead 读 wiki 做好 plan
- 有自己的 chat 页面,**可与用户直接对话**(解释架构、澄清设计),但 PM 是默认入口,一般不直接打扰用户
- 详见 §2.13 archivist 的更新与意图理解机制、§2.16 wiki 树结构维护

### 2.8 planner 侧:按需拆解任务队列

planner 是**全局专业 agent**(无 projectId、无 cron),暴露为工具、在 lead 的 toolPolicy 中。lead 依据需求类型选不同 planner(后端功能/bugfix/重构/调研/…),planner 读需求 + 上下文产出 TaskStepRecord 队列(软件项目 = 编码→审核→测试循环)。可配多个 planner 覆盖不同领域。

### 2.9 通知与门

**通知只在跨 agent 边界(领域交接)发生;同一 agent 自己管线内的门是工具调用级 pause(工具未返回,等用户反馈,不超时)。**

| 时刻 | 方向 | Project 通知 |
|------|------|------------|
| 进 `ready` | PM → lead | → lead(pickup) |
| 进 `verify` | lead → PM | → PM(判断覆盖) |
| verify accept → 合并 main | lead → archivist | → archivist(刷新 wiki) |

- **cron 兜底**:ready/verify 两个交接点若通知漏掉,lead/PM 的 cron 扫到就补上。pickup 的幂等靠 `assignedAgentId` 已写则跳过。
- **plan 门 = Orchestrate DSL 的确认点(v0.7)**:lead 先用专家 **planner** 出计划大纲,再自己把大纲拆成 **Orchestrate 流程**(`parallel` / `pipeline` / `if` / `for` / `barrier` 等)作为 Orchestrate 工具的输入。lead 调用 Orchestrate 工具提交该流程 → **Orchestrate 停住等用户确认**(这一步就是 plan 门,审核方 = 用户),确认后 lead 才能 `Orchestrate run` 执行,否则 Orchestrate 返回 `false`。审核暂停本质是「工具调用还没返回、在等用户反馈」,不超时、不占资源(不发下一次 API call)。用户在哪看到有 plan 待审 = 看板提醒。
- **验收门(v0.7 修订 M4)**:验收**不再由 PM 做技术判断**。验收工作(单测/smoke/审查)**包含在 Orchestrate 流程里**,是 lead 执行流程的自动产出 → 沉淀成「这个需求改了哪些文件、跑了哪些测试」的清单。**PM 只看这份清单判断「改动+测试是否覆盖了原需求意图」**(产品颗粒度,不碰技术)。`reviewerAgentId` 默认不再是 PM(技术验收在流程内);PM 的角色是「覆盖判断」而非「技术 accept」。验收通过 → lead→archivist 通知合并。
- **驳回回路**:
  - plan 门驳回 → lead 拿反馈**自重 Orchestrate 流程**(同 agent);仅当需求本身有问题才退 `discuss`、通知 PM 重谈。
  - 验收不通过(PM 判「未覆盖需求」)→ PM→lead 交接、通知 lead 补;根本性问题 → 退 `discuss`,PM 重新找用户谈。

### 2.10 discuss:文档为中心

discuss 不靠 session 隔离,**需求文档是持久 substrate**:

- **入口**:看板需求卡「讨论」→ **跳转到该 PM 的 chat 页面**(每 agent 有自己的 chat 页面)。
- **PM chat 页面** = 跟 PM 的持久对话 + 文档/目录面板(复用现有 chat 页面的文档+目录渲染),展示该 PM 管理的所有需求文档(`createdByAgentId` = 此 PM)。跨 session、跨日期都在这一处。
- **需求 = 文档 + 记录**:
  - **RequirementRecord**(DB,喂看板):名称、摘要、属性、status、指派字段 + `docPath`(指向 repo 内文档)。
  - **需求文档**(文件,markdown):完整内容 + 讨论沉淀。
  - **需求文档是 wiki 树的一个叶子节点(v0.7)**:wiki 是项目文档的**结构本身**,代码文件、需求文档都是叶子(见 §2.16/§2.18)。需求文档这个叶子由 PM 管(写内容),archivist 只读它、在 wiki 树里为它建意图节点 + 关系。
  - 卡片 = record 的摘要/属性;完整文档在 PM chat 页面显示。
- **需求文档放代码仓库**(如 `{workspace}/.zero/requirements/{pmId}/`),跟 repo 走、**跨设备可恢复**。
- **无 session 隔离**:状态不在 session 里、在文档里。PM 用文件工具现读文档(不用 session 启动注入上下文)。
- **用户创建的需求也生成需求文档**,归到对应 PM 目录(由 project 的 PM 认领建档)。
- ready 确认 → status→ready → Project 通知 lead。

### 2.11 子 agent 执行上下文

- **项目绑定 agent**(PM、lead、archivist):`projectId` 指向 Project,workspace = `project.workspaceDir`
- **全局 tool-agent**(analyzer/planner/dev/review/qa):无 `projectId`,运行时**继承 caller** 的 workspace;caller 可 per-call 覆盖(限定子目录)
- 身份 + 历史 + toolPolicy 一律用**目标 agent 自身**;需扩展 `delegateTask`:传目标 agent 全配置(toolPolicy、agentId)+ per-call 覆盖(workspace、scope)

### 2.12 session 生命周期与并发(写隔离靠角色 scope,无锁)

- **并行**:每 session 独立 AgentLoop,多 cron/子 agent/用户聊天互不阻塞
- **临时 session 归档**:cron/子 agent session 运行完归档;chatUI 只留用户对话 session
- **归档前双 API call(并行)**:总结→记忆节点+wiki;评价工具。可配置开关
- **写隔离靠角色 scope,不用锁**:
  - PM cron:**只建新需求文档**,代码 read-only、wiki 树结构 read-only(§2.16)
  - PM discuss:**只改已有需求文档**的内容(需求文档叶子),不碰 wiki 树结构
  - archivist:**只读写 wiki 树结构**(建结构节点/指针/关系),对实际项目文档(代码、需求文档等)只读
  - lead/dev:**只写 feature 分支的代码**;不碰 wiki 树、不碰需求文档
  - → 三者写入目标不相交(PM 写需求文档叶子内容、archivist 写 wiki 树结构、lead/dev 写代码),零冲突

### 2.13 archivist 的更新与意图理解

**更新来源 = git(骨干):**
- archivist 记 `lastScannedRef`(**主分支** commit sha)。**只跟踪 main** —— 合并后跑 `git log/diff <last>..main`,只重读变化部分更新 wiki;feature 分支的 WIP **不进 wiki**(见 §2.15)。
- 周期性全量 rescan 兜底漂移/归一化。可选 fs.watch 实时感知,落地仍走 git。
- 代码和文档都在 repo、靠 git 跨设备同步 → git 同时是 artifact store 和变更信号。

**设计意图 = 从 artifact 聚合,不发明:**
- **结构层(what)**:读代码(模块/类型/调用图)。
- **意图层(why)**:commit message、需求文档(PM discuss 记下的用户意图)、ADR/设计文档、代码注释、README。
- **深度意图外包 analyzer**:复杂模块「为什么这么设计」archivist 啃不动时,调 architecture-lens 的 analyzer 深挖(archivist 广、analyzer 深,正交)。
- **诚实边界**:意图只能从人写下的地方提取;缺失时 archivist 只描述结构并 flag「无记录理由」,触发 PM discuss 找用户补 → 正循环。

**需求 → 设计 traceability(双向):**
archivist 读三样东西缝合:
1. 需求文档 R(意图)
2. R 的工作轨迹:TaskStepRecord(挂在 R 下,记录碰了哪些文件)+ 引用 R 的 commits(`git log --grep R` + file diff)
3. 代码结构(实际是什么)
→ wiki 节点 ↔ 需求文档双向链(R 实现于模块 A、B;模块 A 服务于 R、S)。
**约定**:build 管线(lead→dev)干活时 commit 引用 requirementId(如 `feat: ... [req-123]`),喂饱 traceability;无引用时退回语义推断(弱)。

### 2.14 zero:全局管理 agent(对话式搭建 workflow)

zero 作为**全局管理 agent**(无 projectId),通过对话创建和配置整个 workflow:

- 配 **agent/project 管理工具**(封装 ProjectStore/AgentStore/AgentToolStore):create/update/delete project、create/update/delete agent、bind agent to project、set toolPolicy、expose-as-tool、set cronSchedule
- 内置**角色预设模板**(§3),一键实例化项目侧三 agent + 全局 tool
- 用户对话描述需求,zero 建 Project(绑 workspaceDir)+ 建 PM/lead/archivist + 建/接入 analyzer/planner/dev/review/qa + 接好 toolPolicy
- 工具层扩展,不改数据模型

### 2.15 Git 分支与合并

按分支划分 git 责任:**archivist 管 main,lead 管 feature 分支**(每条分支单一提交者,零 git 竞态):

- **workspace 必须是 git repo**:非 repo 时 archivist 自动 `git init`。
- **lead 管 feature 分支**:需求进 build 时 lead 创建 feature worktree(独立目录/沙盒,如 `{workspace}.worktrees/req-{id}/`,分支 `req-{requirementId}`);**lead 在实现每一步 commit**(增量,**commit 引用 reqId** 喂 traceability)。默认串行(lead 一次一个需求)。
- **archivist 管 main**:主 worktree 留 main —— PM 写需求文档、archivist 写 wiki,**都由 archivist 统一 commit 到 main**(PM 不碰 git);**PM verify accept 后,archivist 把 feature 分支合并回 main** + 清理 feature worktree → 需求 `closed`。
- **archivist 只索引 main**:合并后 main 前进 → Project 通知 archivist 刷新 wiki/traceability(cron 兜底);feature 分支 WIP 不进 wiki。
- 生命周期:`verify`(accept)→ archivist merge main → `closed`。

### 2.16 wiki 树结构维护(archivist 的职责,v0.7 重构)

**核心转变:wiki 是项目文档的「结构本身」,不是「另一批文档」。** 代码文件、需求文档、ADR 等都是 wiki 树的**叶子节点**;archivist 管的是**叶子指向的指针 + 它们之间的关系**(结构),不是叶子内容本身。

**两层严格分离:**
- **实际项目文档**(workspace 里的代码文件、需求文档文件等)= archivist **只读**。它不写代码、不写需求文档内容(需求文档内容归 PM)。文件说明书不再是「代码文件头部的注释」—— 它现在是 **wiki 树里的 header 节点**,描述一个代码文件。
- **wiki 树**(在 zero-core 数据库,不在项目 workspace)= archivist **可读写**。archivist 在这棵树上建结构节点,节点带指针指向实际文档:`意图节点` → 指向需求文档,`header 节点` → 指向代码文档;并维护节点间关系(模块包含、依赖、需求↔实现 traceability)。

**作废 v0.5/v0.6 的设计:**
- ~~archivist 回写代码文件头注释、兜 doctor 标准化门禁~~ —— archivist 不碰代码文件了。文件说明书迁移为 wiki 树里的 header 节点(描述代码文件,但写在数据库 wiki 树上,不在代码文件里)。
- ~~docs/basic ↔ wiki 分歧信号~~ —— `docs/basic` 是 openprd 的产物,**本工作流砍掉**。

**archivist 怎么维护 wiki 结构:**
- **增量更新**:记 `lastScannedRef`(main commit sha),合并后跑 `git log/diff <last>..main`,只重读变化的项目文档 → 更新对应的 wiki 结构节点(header 节点描述、意图节点、关系)。
- **provenance 标签**(见 §2.17a):每个结构断言标 `structure`(从代码推断)/`derived`(从 commit·ADR 聚合)/`confirmed`(从需求文档·用户 discuss),让 archivist 自己知道哪条该信、哪条该 flag。
- **分歧信号(保留但重定向基线)**:archivist 不再对齐 docs/basic(已砍),改为对齐 **wiki 意图节点(指向需求文档)↔ 代码结构(指向代码文档)** —— 需求文档是人写的「应该怎样」,代码结构是「实际怎样」,两者 diff 是高价值信号:需求未实现 → flag;代码有需求文档没覆盖的能力 → flag(可能是隐性需求或跑偏)。

**这跟「干净视角 + 全局 wiki 树」的关系:** archivist 写的 wiki 结构节点都在 project 子树下(§2.18);PM 读 wiki 时看到的是结构 + 叶子指针,可以顺着意图节点找到需求文档、顺着 header 节点找到代码 —— wiki 树是 PM/lead 访问项目知识的统一入口,而 archivist 是这棵 project 子树结构的唯一维护者。

### 2.17 wiki provenance + verify 证据清单 + 单流程(v0.6)

本节把「干净视角 + 私有沉淀」的哲学落到三处具体机制。**刻意收窄范围**:只服务本工作流自身,不引入通用 harness 的复杂度。

**(a) wiki node provenance —— 给 archivist 自己用,不泛化。**
archivist 在 wiki node 上记每条断言的**出处标签**:
- `structure` —— 从代码结构推断(模块/类型/调用图),可靠但只描述 what。
- `derived` —— 从 commit message / ADR / 设计文档 / 注释聚合的意图,有依据但可能滞后。
- `confirmed` —— 从用户 discuss 或 PM 需求文档拿到的,人确认过的意图。

**目的不是给全工作流打标签,而是让 archivist 自己知道哪条该信、哪条该 flag**(§2.16 的分歧信号据此才有底气:「这条 `structure` 推断和 `docs/basic` 冲突」比「这条和文档冲突」可操作得多)。PM/lead 读 wiki 时也能一眼看出哪些是事实、哪些是推断。这是 archivist 层内的工具,不外溢成通用 provenance 体系。

**(b) verify = Orchestrate 流程的自动产出 + PM 的覆盖判断(v0.7 修订 M4)。**
验收**不再让 PM 做技术判断**(那违反 PM 的产品颗粒度)。验收工作(单测、smoke、审查)**包含在 Orchestrate 流程里**,是 lead 执行流程的自动产出,沉淀成清单:**这个需求改了哪些文件、跑了哪些测试、审查结果如何**。PM 看这份清单,只判断一件事 —— **改动 + 测试是否覆盖了原需求意图**(产品视角的覆盖判断,不碰技术细节)。不通过则通知 lead 补;根本性问题退 `discuss`。**不引入 openprd `productionReady` 多门禁聚合**(通用 harness 复杂度,本工作流不需要)。

**(c) 本版单流程,不做入口分流。**
所有需求走同一条 发现→discuss→ready→plan→build→verify。**砍掉**「L0 小修直干 / L1 mini-plan / L2 完整流程」这种入口复杂度分流 —— 那要求 PM 在入口判断颗粒度,反而增加 PM 的判断负担、违反「每层视角固定」的哲学。颗粒度由层级固定(lead 该不该拆给 planner、planner 该不该派 dev),不由 PM 在入口预判。简化后 PM 的视角更干净。

---

## 3. 能力与预设

| 预设 | 归属 | 典型能力组合 | 说明 |
|------|------|------------|------|
| lead | 项目绑定 | 持 cron,toolPolicy 放行 planner/dev/review/qa + Orchestrate 工具 | 交付:pickup→planner 大纲→拆 Orchestrate DSL→用户确认门→run→验收产出 |
| PM | 项目绑定 | 持 cron,toolPolicy 放行 analyzer 及其他专项 agent tool | 产品:发现→需求文档→discuss;读 wiki;验收时判覆盖 |
| archivist | 项目绑定 | 持 cron,实际项目文档只读 / wiki 树读写(§2.16),toolPolicy 放行 analyzer(architecture lens) | 知识:wiki 树结构 + 需求↔设计 traceability + provenance + 意图↔结构分歧信号 |
| analyzer | 全局 | 被调用 + 专项分析 prompt(UI/安全/性能/架构) | 按问题维度深度分析(可多个) |
| planner | 全局 | 被 lead 调用 + 规划 prompt | 按需求类型拆任务队列(可多个) |
| developer | 全局 | 被 lead 调用 + 写文件 prompt | 编码 |
| reviewer | 全局 | 被 lead 调用 + 审查 prompt | 代码审查 |
| qa | 全局 | 被 lead 调用 + 测试 prompt | 测试验证 |

预设只是起点,可任意组合。

### 2.18 wiki 记忆树架构与访问权限(v0.7)

§2.16 讲了 archivist 在一棵 wiki 树上做结构维护。这棵树是**全局唯一**的、是 zero-core 全部知识/记忆的载体。本节定义它的结构与访问边界。

**一棵全局 wiki 记忆树:**
- 整个 zero-core 只有一棵 wiki 记忆树,存在**数据库**(不在任何项目 workspace)。
- 各类记忆都挂在这棵树上:**项目文档**(代码文件、需求文档、ADR)= 叶子节点;**各 project 的 wiki 子树**挂在 `project` 节点下(对某个具体项目的记忆);其他类型记忆(跨项目经验、工具使用心得、会话归档总结等)挂在各自类型的节点下。
- 沉淀**不硬性按 agent 分割** —— 经验都写进这棵树,只是别的 agent 平时用不到所以不读(不是私有存储)。这正是 §2.1 修订后的沉淀哲学的物理载体。

**视角边界 = wiki 访问权限(读取根节点):**
- **项目绑定 agent**(PM/lead/archivist):wiki 根节点 = 自己的 `project` 子树。看不到更大的根 —— 看不到别的 project、看不到跨项目记忆的更上层结构。它的整个知识视野就是「这一个项目」。
- **全局 agent**(如 zero):根节点更高,可观测**所有 project 子树**及全局类型节点 → 能跨项目看到运行情况、做全局管理/观测。
- 视角隔离因此是**结构上强制的**(读到哪棵子树由权限决定),而非「私有存储 + 自觉不读」。agent 看不到职责外的节点,自然不被干扰;将来某 agent 需要跨项目经验时,提升它的读取根即可,不必重新积累。

**节点类型(结构层,archivist 维护;叶子内容各归其主):**
- `header 节点` —— 描述一个代码文件,指针指向该文件(archivist 从代码推断 + provenance 标)。
- `意图节点` —— 描述一个需求文档,指针指向该文件(PM 写内容,archivist 建节点 + 关系)。
- `结构节点`(模块/子系统/约定等)—— archivist 从代码 + artifact 聚合,带 provenance。
- 关系边:模块包含、依赖、需求↔实现 traceability、文档↔代码。

**archivist 的 scope:** 只在自己绑定的 `project` 子树下读写结构节点(建/改节点 + 指针 + 关系);对实际项目文档只读;不碰别的 project 子树、不碰全局类型节点(那是别的 archivist 或全局机制管)。

---

## 4. 数据模型变化

### 4.1 AgentRecord(+projectId +cron +archivist 游标)

```typescript
interface AgentRecord {
  // ... existing(prompt、model、toolPolicy 等不变)...
  projectId?: string;        // 项目绑定 agent 指向 Project;缺省 = 全局
  cronSchedule?: "off" | "hourly" | "daily" | "weekly";
  cronPrompt?: string;       // 定时触发的提示词
  lastScannedRef?: string;   // archivist 专用:上次扫描到的 main commit sha
  wikiRootNodeId?: string;   // wiki 访问权限:此 agent 能读的 wiki 根节点(§2.18)。项目 agent 默认 = 其 project 子树根;全局 agent 默认 = 全局根
}
```

项目绑定 agent 的有效 workspace 由 `project.workspaceDir` 解析,**禁止自带 workspaceDir**(已设则校验报错/忽略);全局/独立 agent 可保留 `workspaceDir` 作默认。**不加** `workflowRole`、**不加** `subAgentChain`(调用图走 toolPolicy)。

### 4.2 ProjectRecord(精简保留 + 通知枢纽)

```typescript
interface ProjectRecord {
  id: string;
  name: string;
  workspaceDir: string;      // 规范化工作目录,唯一,创建后不可变
  createdAt: string;
  updatedAt: string;
}
```

原 `analysisInterval`/`status`/`analystCronId`/`analystSessionId` 等运行态废弃(cron 归 agent,通知由 Project 在状态转移时发出)。

### 4.3 RequirementRecord(改挂 projectId + 指派 + docPath + 覆盖判断)

```typescript
interface RequirementRecord {
  projectId: string;
  docPath: string;            // repo 内需求文档路径(wiki 树的一个意图叶子节点)
  createdByAgentId?: string; // 创建该需求的 PM(discuss 对话方)
  assignedAgentId?: string;  // 拉取该需求的 lead
  reviewerAgentId?: string;  // 覆盖判断方(默认 = createdByAgentId 的 PM);注意 v0.7 后这是"覆盖判断"而非"技术 accept",技术验收在 Orchestrate 流程内
  // ... 其余不变 ...
}
```

### 4.4 WikiNode(全局记忆树,v0.7 重构)

**一棵全局 wiki 记忆树**(数据库,不在项目 workspace),节点类型按结构/叶子区分:

```typescript
interface WikiNode {
  id: string;
  parentId?: string;          // 树结构:挂哪个父节点下(project 子树 / 全局类型节点)
  type: "header" | "intent" | "structure" | "project" | "memory" | ...;
  // header 节点 → 指向代码文件;intent 节点 → 指向需求文档;structure → 模块/子系统;project → project 子树根;memory → 会话归档/经验等
  docPointer?: string;        // 叶子节点指向的实际文档路径(代码文件 / 需求文档 / ADR),实际文档不在 wiki 里
  provenance?: "structure" | "derived" | "confirmed";  // 结构断言出处(archivist 自用,§2.17a)
  requirementIds?: string[];  // traceability:此节点关联的需求
  summary: string;            // 节点摘要(archivist 维护)
  // ... 关系边、时间戳等 ...
}
```

`project` 子树 = 挂在某 `project` 节点下的全部节点(该 project 的记忆);archivist 只在自己 project 子树下读写结构节点。

### 4.5 TaskStepRecord

跟随所属 RequirementRecord;记录 `touchedFiles` + 测试执行结果(供 archivist 拼 traceability + 喂 PM 覆盖判断清单,见 §2.17b)。

---

## 5. 对 M1-M5 现有代码的影响清单

> 只列影响面。下文 `analyst-service.ts` 等为现有 M1-M5 文件名,实现期可重命名。

### 数据层
- `src/shared/types.ts` — AgentRecord +`projectId`/`cron`/`lastScannedRef`/`wikiRootNodeId`;`ProjectRecord` 精简;RequirementRecord +`docPath`/指派/覆盖判断;**WikiNode 重构为全局记忆树**(type/docPointer/provenance/requirementIds)
- `src/server/db-migration.ts` — agents 表加列(**同步 AGENT_COLUMNS**);projects 表精简;requirements 表 `projectId`+docPath/指派;**wiki_nodes 表重构**(全局树,parent/type/docPointer/provenance)
- `src/server/agent-store.ts` / `project-store.ts`(精简保留)/ `requirement-store.ts` / `wiki-node-store.ts`(全局树读写 + 按权限根查询) — 对应字段与查询

### 服务层
- `src/server/analyst-service.ts`(对应 PM)— 重构为被自身 cron 驱动(发现/建需求),删 `ensureAnalystAgent`
- `src/server/lead-service.ts` — `ensureLeadAgent` → 读 `assignedAgentId`;pickup 逻辑保留;**plan 改为 planner 大纲 → lead 拆 Orchestrate DSL → Orchestrate.confirm 门**
- **新增 `archivist-service.ts`** — git 增量扫描、**wiki 树结构维护**(建/改 header·intent·structure 节点 + 指针 + 关系,数据库内,不碰实际文档)、provenance 打标、traceability 拼接、意图↔结构分歧检测;对实际项目文档只读
- `src/server/cron-analysis.ts` — 调度源切 agentStore(多个 cron agent)
- **新增 project 通知分发** — requirement 状态转移时按 §2.9 表向目标 agent 发通知(触发 session);cron 兜底;**看板提醒 plan 门待确认**(用户确认才放行 Orchestrate run,不确认就停着不占资源)

### 编排层
- `src/server/agent-service.ts` — **删 `createRoleLoopFactory`**;子 agent 走 `delegateTask` + toolPolicy
- `src/runtime/tools/orchestrate-tool.ts` — 重构为 **Orchestrate DSL 引擎**(parallel/pipeline/if/for/barrier);**内置 plan 门 = `Orchestrate.confirm`**:lead 提交流程后停住等用户确认,确认才 `run`,否则返回 false(§2.9);**验收工作(单测/smoke/审查)作为流程节点自动执行 + 产出清单**(§2.17b);不再造临时 role agent
- `src/runtime/tools/agent-tool.ts` + `delegateTask` — 扩展传目标 agent 全配置 + per-call 覆盖
- **session 归档钩子(新)** — 双 API call 后归档
- **agent/project 管理工具(新)** — 供 zero 调用
- **角色预设模板(新)** — lead/PM/archivist/analyzer/planner/dev/review/qa

### 前端
- `AgentEditor.tsx` — cron 区、projectId 归属、`lastScannedRef`(archivist)、`wikiRootNodeId`(访问权限)、「可调用 Agent」选择器
- `KanbanPage.tsx` — 按 Project 分组;需求卡显示摘要/属性 + 「讨论」跳 PM chat 页面;**plan 门待确认提醒**(状态标记 + 入口)
- **验收覆盖判断视图** — PM 验收时展示「改动文件 + 测试清单」,PM 判覆盖(§2.17b)
- **每 agent 的 chat 页面** — 复用现有文档+目录渲染,展示该 agent(尤其 PM)管理的需求文档
- `src/shared/ipc-api.ts` / `preload` / `ipc-proxy` — projects 精简 CRUD+绑定;保留 requirements;wiki 改为全局树查询(按 agent 的 wikiRootNodeId 截断)

---

## 6. 已确认的决策(基线)

**调用图与字段**
1. ✅ 复用 agent-as-tool + toolPolicy,不加 `workflowRole`/`subAgentChain`
2. ✅ toolPolicy 对 agent-tool 已 opt-in;且以 `AgentToolEntry.id`(稳定)为 key 存配置(UI 显示 name),改名不断引用、删工具才 orphan

**Project 实体**
3. ✅ 轻量 `Project` 绑定 workspace,是看板入口 + 并发单元 + 通知枢纽
4. ✅ agent 绑定 project(PM/lead/archivist)或全局(analyzer/planner/dev/review/qa/zero)
5. ✅ Project 生命周期:zero 对话创建(显式);workspace 唯一+不可改;删 Project 绝不碰文件,默认 archive / 硬删级联;绑定 agent 解绑不删

**项目侧三 agent + cron**
6. ✅ cron 通用;PM/lead/archivist 各持 cron,各管一块(产品/交付/知识)
7. ✅ PM 独立(自带 cron),不再被 lead 调用;管发现 + 需求 + discuss;cron 只建新需求、wiki/代码 read-only(修订旧「PM 由 lead cron 调用」)
8. ✅ lead 收窄为交付:pipeline(pickup→plan→build)+ 门
9. ✅ archivist 专职 wiki 结构(v0.7 修订):**对实际项目文档(代码/需求文档)只读,对 wiki 树读写**;维护 wiki 结构节点(header→代码、intent→需求文档)+ traceability + provenance;可直连用户但 PM 默认入口(修订 v0.5「逻辑 read-only 文档注释可写」—— 那套「回写代码头注释」已作废)

**通知与门**
10. ✅ 通知只在跨 agent 边界:ready(PM→lead)、verify/覆盖判断(lead→PM);plan 门是工具调用级暂停,不跨 agent 通知;cron 兜底;pickup 幂等靠 assignedAgentId 已写则跳过
11. ✅ 门 = 工具调用本身(v0.7 具体化为 Orchestrate.confirm):lead 用 planner 出大纲 → 拆 Orchestrate DSL(parallel/pipeline/if/for/barrier)→ `Orchestrate.confirm` 等用户确认才 run,否则返回 false;审核暂停 = 工具未返回、等用户反馈,不超时、不占资源;驳回回路:plan 驳回 lead 自重 Orchestrate 流程 / 覆盖判断未通过通知 lead 补 / 根本问题退 discuss

**需求与文档**
12. ✅ 需求 = 文档(repo 内,跨设备)+ 记录(DB);RequirementRecord +`docPath`
13. ✅ discuss 文档为中心:PM chat 页面、需求文档入 repo、无 session 隔离(文档是 substrate)
14. ✅ 一个 project 一个 PM 入口;多样化产品需求靠其他 agent tool
15. ✅ ready→pickup 用 pull 模型(通知为主 + cron 兜底)

**子 agent 与 session**
16. ✅ 子 agent 上下文:项目绑定(PM/lead/archivist)用 project workspace;全局 tool-agent 继承 caller(可 per-call 覆盖);身份/toolPolicy/历史用目标 agent 自身
17. ✅ session 并行;cron/子 agent session 归档前双 API call(可配置)
18. ✅ 写隔离靠角色 scope(PM 写需求文档叶子内容;archivist 写 wiki 树结构;lead/dev 写 feature 代码),三者目标不相交,无锁

**archivist 机制**
19. ✅ git 增量更新(`lastScannedRef` + log/diff)+ 周期全量 rescan
20. ✅ 意图从 artifact 聚合(代码结构 + commit/需求文档/ADR/注释);深度外包 analyzer
21. ✅ 需求↔设计 traceability:读需求文档 + 工作轨迹(task steps、commits 引用 reqId)+ 代码;约定 commit 引用 requirementId

**其他**
22. ✅ 角色 = prompt 预设 + 工具配置(toolPolicy)+ 写 scope 的组合,非运行时类型(v0.7 修订:不仅是 prompt)
23. ✅ 不改现有 agent,不写迁移脚本;M1-M5 数据破坏性重构(无真实数据)
24. ✅ zero 全局管理 agent(对话式搭建 workflow,工具层扩展)

**Git 分支**
25. ✅ feature 分支由 lead 管(进 build 时建 worktree、每步 commit 引用 reqId);PM verify accept 后 **archivist** 合并 main → closed → 清理 worktree
26. ✅ archivist 只索引 main(合并后刷新 wiki/traceability),feature 分支 WIP 不进 wiki
27. ✅ git 按分支划分:archivist 管 main(统一 commit PM 文档/wiki、合并、非 repo 自动 init);lead 管 feature(建 worktree、commit);PM/dev 不碰 git
28. ✅ 默认串行(lead 一次一个需求);多需求并行留以后

**archivist 文档维护(v0.5 提出,v0.7 作废大部分)**
29. ✅(v0.7 作废)~~archivist「逻辑 read-only、文档注释可写」、回写代码头注释~~ —— v0.7 改为「实际项目文档只读、wiki 树读写」,archivist 不再碰任何项目文件(含代码头注释);文件说明书从「代码头注释」迁移为「wiki 树里的 header 节点」(见 §2.16)
30. ✅(v0.7 保留精神)archivist 增量维护 wiki 结构:扫到文件实质变化 → 更新对应 wiki 结构节点(header 节点描述、关系、指针),**不改原文件**;header 节点仍可作 wiki 结构的低成本种子 + 版本指纹
31. ✅(v0.7 改基线)分歧信号从「docs/basic ↔ wiki」改为「wiki 意图节点(指向需求文档)↔ 代码结构」;**docs/basic 砍掉**(openprd 产物,非本工作流);archivist 不擅自改代码,只 flag 给 PM/lead

**设计哲学与收窄(v0.6 新增,v0.7 修订)**
32. ✅ 工作流目的 = 层级调用给每个 agent 一个干净视角(每层只处理自己颗粒度的问题,细节委托下层专门 agent);**沉淀 v0.7 修订**:不再「私有」,改为「一棵全局 wiki 记忆树 + 按 wiki 访问权限(wikiRootNodeId)做视角边界」—— 经验都写进 wiki 树,别的 agent 平时不读 ≠ 看不见,需要时提升读取根即可访问
33. ✅ wiki node provenance(`structure`/`derived`/`confirmed`)只给 archivist 自己判断该信哪条 + PM/lead 读时参考,不泛化成全工作流标签
34. ✅(v0.7 修订)验收技术工作(单测/smoke/审查)在 **Orchestrate 流程内自动执行 + 产出清单**;**PM 只判「改动+测试是否覆盖原需求意图」**(产品覆盖判断,不碰技术);reviewerAgentId 语义从「技术 accept」改为「覆盖判断方」(默认 PM);不引入 productionReady 多门禁聚合
35. ✅ 本版单流程,不做 L0/L1/L2 入口分流(会增加 PM 判断负担、违反颗粒度由层级固定);颗粒度由调用层级固定,不由 PM 预判

**wiki 架构与门控(v0.7 新增)**
36. ✅ wiki = 项目文档的「结构本身」,不是另一批文档;代码文件/需求文档/ADR 都是 wiki 树叶子;archivist 管结构(节点指针 + 关系),不管叶子内容
37. ✅ 一棵全局 wiki 记忆树在数据库(不在项目 workspace);project 子树挂 project 节点下;各类记忆(项目文档/经验/归档)都挂这棵树
38. ✅ 视角边界 = wiki 访问权限(读取根节点 wikiRootNodeId):项目 agent 根 = 自己 project 子树(看不到更大根);全局 agent(如 zero)根更高(可观测所有 project)。视角隔离结构强制,非「私有存储 + 自觉」
39. ✅ archivist 写入守卫靠 prompt 自约束 + 工具能力(只对 wiki 树有写工具,对项目文档只读工具)—— 不走 AST 守卫/外部 hook 那种重机制;scope = 自己 project 子树,不碰别的 project / 全局类型节点

---

## 7. 开放问题(待讨论)

### ✅ 已收敛(记录决议)
- **Q1(workspaceDir 规范化)**:Project 创建时 `path.resolve + fs.realpath` 归一落库;`projectId` 是身份键(不靠路径字符串相等)。
- **Q2(并发领取)**:标准 1 PM + 1 lead,通知目标唯一,无竞争 → 消解。
- **Q3(看板入口)**:= Project(决策 3)。
- **Q4(暴露名稳定性)**:toolPolicy 对 agent-tool 以 `AgentToolEntry.id` 为 key(UI 显示 name),改名不断、删才 orphan(决策 2)。
- **Q5(cron/门交互)**:决策 10/11 —— 跨 agent 边界通知 + 门 session resume + cron 兜底。
- **Q6(PM→analyzer 子 session)**:analyzer 只读、不写文件,归属问题消解;tool-agent(analyzer/planner/dev/review/qa)子 session **不跑双 API 归档**(太短/费),只项目绑定 agent session + 用户 session 跑。
- **Q7(wiki/文档并发)**:决策 18 —— 角色 scope 写隔离,无锁。
- **Q-字段共存**:项目绑定 agent 禁止自带 workspaceDir,一律从 project 解析;全局/独立 agent 保留 workspaceDir 作默认(见 §4.1)。
- **Project 生命周期 / workspace 唯一性 / discuss 路由**:决策 5/13。

### ✅ v0.7 收敛(矛盾/OQ 审计)
- **M1(plan 门审核方 + 恢复源)**:重构成 Orchestrate.confirm 门 —— lead 拆 Orchestrate DSL → 提交 → 停住等用户确认(工具未返回、不超时、不占资源)→ 确认才 run 否则 false。审核方明确 = 用户,看板提醒入口。死锁消解(不确认就停着不发 API call)。决策 11。
- **M2(docs/basic 基线 vs 现实 自我消解)**:砍掉 docs/basic(openprd 产物);分歧信号基线改为「wiki 意图节点(指向需求文档)↔ 代码结构」。决策 31/36。
- **M3(wiki 写入者归属 + 需求文档 vs wiki)**:wiki 是结构本身,需求文档/代码都是叶子;PM 写需求文档叶子内容、archivist 写 wiki 树结构 —— 职责正交。决策 18/36。
- **M4(verify 颗粒度混给 PM)**:技术验收归 Orchestrate 流程内(自动产出清单);PM 只判覆盖,不碰技术。决策 34。
- **OQ1(archivist 写入守卫机制)**:prompt 自约束 + 工具能力,不走 AST/hook。决策 39。
- **OQ2(archivist scope)**:只在自己绑定的 project workspace 文档 + project wiki 子树。决策 39。
- **OQ3(私有沉淀 vs 共用)**:沉淀不硬性按 agent 分割,落到全局 wiki 记忆树;project wiki 是子树;视角靠 wiki 访问权限做边界(非私有存储)。决策 32/37/38。
- **OQ4(plan 门死锁)**:看板提醒 + 停着不占资源(不发 API call)。决策 11。
- **OQ5(pickup 幂等)**:assignedAgentId 已写则跳过。决策 10。

### 仍 open
无实质 open 问题。剩余(Orchestrate DSL 语法定义、wiki 节点关系边 schema、wikiRootNodeId 权限查询实现、子 session 双 API 开关、path 落库等)均为纯实现期细节,按决议执行即可。

---

## 8. 下一步

本 RFC 定稿后,再起独立 milestone 计划(plan/实现),按数据模型与影响清单执行。v0.7 完成 wiki 架构根本重构 + 矛盾/OQ 审计收敛(决策 36-39,M1-M4/OQ1-5 全部解决);实现期需重点设计:
- **Orchestrate DSL 引擎**(parallel/pipeline/if/for/barrier 语义)+ `Orchestrate.confirm` 门状态机(提交→等用户确认→run/返回 false)
- **全局 wiki 记忆树**(WikiNode 重构:type/docPointer/provenance/关系边;按 wikiRootNodeId 权限截断查询)
- **archivist-service**(实际文档只读 + wiki 树结构读写;git 增量 → wiki 结构更新;意图↔结构分歧检测)
- **验收覆盖判断视图**(Orchestrate 产出「改动+测试清单」,PM 判覆盖)
其余(wiki 节点关系边 schema、wikiRootNodeId 权限实现、子 session 双 API 开关、path 落库等)均为纯实现期细节,按决议执行即可。
