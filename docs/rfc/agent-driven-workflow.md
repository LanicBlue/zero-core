# RFC: Agent 驱动的工作流 — 从配置涌现

> **Status**: Draft v0.8 — 讨论中
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
> - **v0.7 → v0.8**:**身份与上下文分离 —— 取消「项目绑定 agent」,全部角色全局化**。洞察:「PM-for-A 和 PM-for-B 不是两个 agent,是同一个 agent 的两个 session」。PM/lead/archivist 不再各自绑 projectId,而是**全局角色(prompt + toolPolicy)**,经 **session 携带的 project 上下文 bundle**(projectId/workspaceDir/wikiRootNodeId)服务不同 project —— 这与 dev/review/qa「全局 + 继承 caller 上下文」的既有模型统一,消掉最后的特殊化,从根上作废 M1-M5「自动造 project agent」。**cron 升为一等公民**:独立于 agent 和 project,一条 cron = {执行的 agent, 工作范围(scope bundle), schedule};cron 的 scope = session 的上下文 bundle,触发即找/建对应 session。**归档从「双 API call」拆成两个独立提取者**(参考 MiMo Code 的 Writer「独立于主 agent 的提取者」身份):(A) 内容记忆提取者 —— 把易失 session(cron/subagent,用户看不到)做的事捞进全局 wiki 记忆节点;(B) 工具遥测提取者 —— 抽工具调用(尤其失败/无效调用)进**独立遥测存储**(v1),未来作为「zero-core 自管理」的数据源。**新增 §2.18 记忆与上下文恢复**(占位):目标是「新 session + 记忆召回 ≈ 续接」,session 历史非状态真相之源、记忆才是;五层状态分解,T3(当前工作态)是难点,活 checkpoint 方案待专项设计。git/wiki 归属精确化(N1/N2):git 只管 project(workspace 里的文档+代码),wiki 树非叶节点在数据库;archivist 只维护自己 project 的 wiki**子树**结构,提取者 A 写的是全局 memory 节点(不在 project 子树)。**新增设计约束:zero-core 自管理** —— 平台本身只是又一个 Project,不开后门特例。详见 §2.1/§2.4/§2.11/§2.12/§2.18/§2.19。

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
5. **Project 概念被过度加载**:旧 `ProjectRecord` 不只是 workspaceDir 容器,还塞了 `analysisInterval` / `status` / `analystCronId` / `analystSessionId` 等 cron 与 session 运行态
6. **重复造轮子**:zero-core 已有 agent-as-tool 机制(暴露 + 委托),M1-M5 却另起一套 role/chain 抽象

### 1.3 目标

让 workflow 从 agent 的配置**涌现**,而不是用固定的角色枚举去描述:

- **调用关系复用 agent-as-tool + toolPolicy**,不新造 role/chain 字段
- **角色全局化**:所有角色(PM/lead/archivist + tool-agent)都是全局角色,经 session 上下文 bundle 服务不同 project;不再「项目绑定 agent」
- **cron 升为一等公民**:独立于 agent 和 project,指定「执行的 agent + 工作范围 + schedule」
- **轻量 `Project` 实体**:绑定 workspace + 通知枢纽 + 归属键
- **三角色分工**(PM 产品 / lead 交付 / archivist 知识),各管一块、互不直接调用,只经 Project 解耦
- **角色降级为 prompt 预设**,非运行时类型

---

## 2. 核心设计:workflow 从配置涌现

### 2.1 设计哲学

**工作流的目的是简化 agent 之间的合作方式,并简化单个 agent 的工作视角与内容。** 人的工作流是人之间的合作,agent 的工作流是 agent 之间的合作 —— 类比成立:人很难在思考宏观问题的同时兼顾细节,agent 同样不应该同时处理不同颗粒度的问题。

**通过 agent 层级调用,让每个 agent 只处理自己视角的问题,不必关心更底层的细节,细节交给专门处理它的下层 agent。** lead 关心交付节奏,不操心 dev 怎么用测试框架;analyzer 关心代码健康度,不操心发现怎么变成需求文档。颗粒度由调用层级天然分层,每层固定,agent 不必自己判断该处理多粗多细。

workflow 因此不是预设的角色脚本,而是 agent 配置形成的**有向图** + 一个归属实体:

- **节点** = agent(全局角色:prompt、model、tools、toolPolicy)
- **边** = 「A 能调用 B」(A 的 toolPolicy 放行了 B 暴露的工具名)
- **能力** = cron(一等公民,指定 agent + 工作范围 + schedule,见 §2.4)、requirement 指派(哪个角色驱动某需求)
- **归属实体** = 轻量 `Project`(绑定 workspace、看板入口、并发单元、**通知枢纽**)

「角色」(lead/PM/archivist/analyzer/planner/dev/review/qa)不是类型字段,是**可选的 prompt 预设**。

> **自组织原则(v0.8 根本立场)。** 工作流由**背景(上下文/知识)、能力(prompt + 工具)、关系(toolPolicy 调用图)自组织**,不是固定角色脚本。本 RFC 全文的 PM/lead/archivist/dev/... 只是「**coding 这个最重要场景下的默认适配**」—— 一套开箱即用的 prompt 预设 + 调用关系,不是架构内建的角色类型。换一个领域(写作 / 运维 / 研究 / ...),用户配不同背景/能力/关系的 agent,就涌现不同的工作流,**架构层零改动**(这正是 §2「从配置涌现」的题中之义,也是决策 50「无类型区别」的由来)。下文为具体起见仍用 coding 场景的角色名举例,但请记住它们是预设、非内建。

**身份与上下文分离(v0.8 根本性转变)。** agent 是**全局角色**:身份 = prompt + toolPolicy + 能力标签,不绑任何 project。同一个 PM 角色服务 project A 和 project B 时,「PM-for-A」和「PM-for-B」**不是两个 agent,是同一个 agent 的两个 session** —— session 携带「当前服务的 project」上下文(workspaceDir / wikiRootNodeId / projectId)。这与 dev/review/qa「全局 + 继承 caller 上下文」的既有模型完全统一:不再有「项目绑定 agent」这个特殊类,所有角色都是全局的,差别只在**上下文谁塞给它**(被同步调用 → 继承 caller;被异步触发 → 来自 cron/notification 的 scope)。从根上作废了 M1-M5「为每个 project 造专属 agent」。

**沉淀 = 三层(v0.8 修订 v0.7)。** 整个 zero-core 一棵全局 wiki 记忆树(数据库,不在项目 workspace),三类沉淀各归其位:

| 层 | 是什么 | 位置 | 来源 |
|---|---|---|---|
| **角色技能记忆** | 「怎么当好 PM/dev」—— 跨项目、可复用 | 全局 wiki 树 `type=memory` 节点(不绑 project) | 提取者 A 归档易失 session |
| **项目知识** | 需求文档、代码结构、ADR —— 单项目 | 该 project 的 wiki 子树 | agent 工作时直接产出(PM 写需求、archivist 理结构) |
| **平台遥测** | 工具调用情况,尤其失败/无效调用 —— 优化 tool/agent-tool 的数据源 | 独立遥测存储(v1);未来 = zero-core 自管理项目 wiki | 提取者 B 归档 |

**视角边界靠 wiki 访问权限(读取根节点 wikiRootNodeId)做,且搬到 session 级(v0.8)。** 一个角色在 project A 的 session 里,wiki 根 = A 的 project 子树(看不到更大根);同一角色在全局观察 session 里,根更高。视角隔离因此是**结构上强制的**(session 级读取边界),而非「私有存储 + 自觉」。agent 看不到职责外的节点,自然不被干扰;将来某 session 需要跨项目经验时,提升该 session 的读取根即可,不必重新积累。详见 §2.19。

### 2.2 调用图:复用现有机制(不加字段)

| 半边 | 现有实现 | 位置 |
|------|---------|------|
| **暴露** | agent 勾选「暴露为工具」→ `AgentToolEntry(type:"internal", agentId:self)`,工具名默认 `kebab(agentName)` | `ExposeAsToolSection.tsx` |
| **消费** | `getAgentToolEntries(callerId)` 返回除自己外所有已暴露 agent;`buildAgentTools` 建工具;`buildToolsSet` 按 caller 的 `toolPolicy` 过滤 | `agent-loop.ts:414`、`tools/index.ts:199` |

`DEFAULT_ENABLED` 仅 `{Shell,Read,Write,Edit,Grep,Glob}`,agent-tool 默认不在其中 → toolPolicy 对 agent-tool **已是 opt-in**,必须显式写 `policy.tools[name]={enabled:true}` 才能调用。

→ **不加** `workflowRole` / `subAgentChain`。前端加「可调用 Agent」选择器,**toolPolicy 对 agent-tool 以 `AgentToolEntry.id`(稳定)为 key 存配置、UI 显示工具名** —— 改名不影响引用,删工具才 orphan(内置工具 Shell/Read/… 名字是常量,仍按名 key)。

### 2.3 Project:绑定 workspace + 通知枢纽 + 归属键

轻量 `ProjectRecord` = `{ id, name, workspaceDir }`,是**项目本体**:绑定规范化工作目录、看板入口、并发单元、requirements/wiki 归属键、**跨 agent 通知的发出方**。

> v0.8:Project 不再「绑定 agent」(agent 全局化了),也不再持有 cron 运行态(cron 升为一等公民,见 §2.4)。Project 只剩纯元数据 + 通知枢纽 + 归属键。

**生命周期:**
- **创建**:zero 对话生成(主)+ UI 直接建(辅);**显式创建,不自动**。
- **workspace 唯一 + 不可变**:一个 workspaceDir 只能绑一个 Project(规范化后唯一约束,防 split-brain);创建后不可改,换目录就新建 Project(磁盘挪动靠 realpath 归一吸收)。
- **删除**:**绝不碰 workspace 文件**(Project 纯元数据);**默认 archive**(隐藏出看板、保留数据、可恢复);**硬删(需确认)级联**清掉该 projectId 的 requirements/wiki/task-steps 及相关 cron。
- 删 Project 级联清理该 project 的 cron(解绑,不删 cron 引用的全局 agent)。

### 2.4 cron:一等公民(独立于 agent 和 project)

v0.8 把 cron 从 AgentRecord 字段升为**独立实体**,同时独立于 agent 和 project:

```typescript
interface CronRecord {
  id: string;
  agentId: string;            // 执行者:某个全局角色 agent(PM/lead/archivist/zero/…)
  workingScope: {             // 工作范围 = session 上下文 bundle
    projectId?: string;        // 服务的 project(项目角色 cron 必填;全局观察 cron 可空)
    workspaceDir: string;      // 解析自 project 或显式
    wikiRootNodeId: string;    // wiki 访问根(项目 cron = project 子树根;全局 cron = 全局根)
  };
  schedule: "off" | "hourly" | "daily" | "weekly" | string;
  prompt?: string;            // 定时触发的提示词(覆盖 agent 默认 prompt)
  enabled: boolean;
}
```

- 「PM 每小时巡 project A」= 一条 `agentId=PM, workingScope={projectA}, schedule=hourly` 的 cron。「lead 每天扫 project A」= 另一条。「zero 每周全局观测」= `workingScope={global root}` 的 cron。
- **同 agent 配 N 条 cron = N 个 scope**(全局 PM 服务多个 project,各 project 一条 cron)。
- **cron 的工作范围 = session 的上下文 bundle(D-B)**:cron 触发 → 拿 workingScope 找/建一个该 `{agentId, scope}` 的 session → 跑。cron、session-context、`{角色, project}→session` 三者统一(详见 §2.11)。
- `CronAnalysisManager` 扫描 enabled 的 cron 定时触发(调度源从「扫 agent.cronSchedule」切到「扫 cron 表」)。
- cron 同时充当跨 agent 通知的兜底(见 §2.9)。

### 2.5 PM(product manager)角色:独立发现 + 需求 + discuss

PM 是**全局角色**,经 session 上下文服务某个 project,管**产品侧**,**独立于 lead**(不被 lead 调用激活):

- **cron 周期扫描 workspace → 调 analyzer 做专项分析(UI/安全/性能/…)→ 发现问题 → 创建需求文档(新)→ 入 `discuss`**
- **discuss 时与用户对话细化**需求文档,用户确认 → `ready`
- PM 的 cron **只发现/创建新需求,不改已有需求文档;对 wiki 和代码 read-only**(写隔离见 §2.12)
- PM 读 archivist 的 wiki 获取项目上下文,写出更好的需求
- 一个 project **一个 PM session 作入口**(不是「一个 PM agent」—— PM agent 全局唯一,入口是「该 project 的 PM session」);多样化的产品需求靠 PM 调其他 agent tool(analyzer 等)实现,不靠多 PM

### 2.6 lead 角色:交付 pipeline + 门

lead 是**全局角色**,经 session 上下文服务某个 project,管**交付侧**,职责收窄为纯粹的「计划 + 执行管理」:

- **pickup** `ready` 的需求(经 Project 通知或 cron 兜底)→ 写 `assignedAgentId`
- **路由 planner**(按需求类型)拿回 TaskStepRecord 任务队列 → 进 `plan`
- **plan 门**:lead 调 planner 出的 plan 留在 lead 自己的上下文里,**approve 直接续跑 lead**(不经 Project 通知,见 2.9)→ `build`
- **build**:用 execute 工具按队列分步派 dev/review/qa,控节奏、复核结果
- **验收门**:build 完成 → 进 `verify` → Project 通知 PM 验收
- lead 读 archivist 的 wiki 做好 plan

lead 不碰 PM 的需求文档、不碰 archivist 的 wiki、不亲自写代码(全外包给 dev)。

### 2.7 archivist 角色:管 wiki 结构 + 需求↔设计 traceability

archivist 是**全局角色**,经 session 上下文服务某个 project,管**知识侧 + main 分支 git**,专职维护项目 wiki 的**结构**(不是叶子内容):

- **对实际项目文档(代码 + 各类文档文件)只读,对 wiki 树可读写**(见 §2.16)。wiki 树在 zero-core 数据库里(不在项目 workspace);archivist 在**自己服务的 project 子树**上建结构节点 + 指针:意图节点指向需求文档、header 节点指向代码文档,并维护节点间关系(模块/依赖/需求↔实现)。它不写代码、不写需求文档本身(那是 PM 的),只读写 wiki 树的结构。
- 周期扫描项目文档 → 更新 wiki 结构(架构、模块、依赖、约定、traceability);扫到文件实质变化 → 更新对应的 wiki 结构节点,**不改原文件**。
- **兼管 main 分支 git**:统一 commit PM 写的需求文档、verify 后合并 feature→main、清理 worktree(见 §2.15);feature 分支 git 归 lead。archivist 自己产出的 wiki 在数据库,不经 git。
- **PM 和 lead 都读它**:PM 读 wiki 写好需求,lead 读 wiki 做好 plan
- 有自己的 chat 页面(session 级),**可与用户直接对话**(解释架构、澄清设计),但 PM 是默认入口,一般不直接打扰用户
- 详见 §2.13 archivist 的更新与意图理解机制、§2.16 wiki 树结构维护

### 2.8 tool-role:caller 按问题类型选不同 prompt/工具的 agent(v0.8 明确)

planner、analyzer(以及 dev/review/qa)在用途上是一类,但**不是一个固定 agent** —— 用户可配多个 **prompt 和工具能力不同的 agent 实例**(不同知识背景 / 不同 lens),caller(lead/PM/archivist)根据**问题类型**从自己 toolPolicy 放行的实例里挑一个调用:

- planner 用途:lead 依据需求类型选(后端功能 / bugfix / 重构 / 调研 / …)的实例,产出 TaskStepRecord 队列(软件项目 = 编码→审核→测试循环)。
- analyzer 用途:PM / archivist 依据分析维度选(UI / 安全 / 性能 / 架构 lens / …)的实例,做深度分析。
- dev/review/qa 用途:lead 按任务性质选相应实例。

caller「选哪个」就是一次 toolPolicy 内的 agent-tool 选择,**不需要额外字段**。呼应 §2.1:**专家的细分颗粒度由调用选择体现,不在 caller 视角里展开**(lead 不操心「为什么选这个」,只按需求类型路由)。

> **没有「单例 vs 多实例」的类型区别(v0.8 明确)。** 所有 agent 之间只有 prompt 和工具能力(toolPolicy)的差异,没有运行时类型分类。PM/lead/archivist/zero 也只是某些 prompt 预设的 agent —— 配几个完全由用户决定(可以一个 PM 服务所有 project,也可以为不同领域配多个 PM)。本节强调「caller 按问题类型选不同专家」只是说明 toolPolicy + 多 agent 实例的自然用法,不引入类型系统。

### 2.9 通知与门

**通知只在跨角色边界(领域交接)发生;同一角色自己管线内的门是工具调用级 pause(工具未返回,等用户反馈,不超时)。** 通知的目标不再是「项目绑定 agent」,而是「该 project 的某角色 session」—— 即 `{角色, projectId} → session`(找/建,见 §2.11)。

| 时刻 | 方向 | Project 通知 |
|------|------|------------|
| 进 `ready` | PM → lead | → 该 project 的 lead session(pickup) |
| 进 `verify` | lead → PM | → 该 project 的 PM session(判断覆盖) |
| verify accept → 合并 main | lead → archivist | → 该 project 的 archivist session(刷新 wiki) |

- **cron 兜底**:ready/verify 两个交接点若通知漏掉,对应角色的 cron(scope=该 project)扫到就补上。pickup 的幂等靠 `assignedAgentId` 已写则跳过。
- **plan 门 = Orchestrate DSL 的确认点(v0.7)**:lead 先用专家 **planner** 出计划大纲,再**自己把大纲拆成 Orchestrate 流程**(参考 MiMo Code 的 Dynamic Workflow:主 agent 写编排脚本派子 agent —— 我们的 Orchestrate DSL 由 lead 撰写 + Orchestrate.confirm 门控,差异见下)`parallel` / `pipeline` / `if` / `for` / `barrier` 等)作为 Orchestrate 工具的输入。lead 调用 Orchestrate 工具提交该流程 → **Orchestrate 停住等用户确认**(这一步就是 plan 门,审核方 = 用户),确认后 lead 才能 `Orchestrate run` 执行,否则 Orchestrate 返回 `false`。审核暂停本质是「工具调用还没返回、在等用户反馈」,不超时、不占资源(不发下一次 API call)。用户在哪看到有 plan 待审 = 看板提醒入口。
  - **Orchestrate 的角色(v0.8 明确 OQ7/OQ9)**:Orchestrate 是**系统工具**,负责「按一定逻辑关系编排多个子 agent 执行」(parallel/pipeline/if/for/barrier 引擎);**lead 为 Orchestrate 指定「什么时候用哪个 agent」** —— 即 lead 在 DSL 的每个节点引用自己 toolPolicy 放行的 agent-tool(具体调 agent 仍走 toolPolicy)。lead 是 DSL 作者,Orchestrate 是执行引擎。
  - **与 MiMo Dynamic Workflow 的异同**:同 = 主 agent 写编排、派子 agent;异 = 我们的 DSL 是 lead 撰写 + 用户 confirm 门控(非 MiMo 的沙箱 JS 自动跑),且子 agent 调用走 toolPolicy(opt-in)。
- **验收门(v0.7 修订 M4)**:验收**不再由 PM 做技术判断**。验收工作(单测/smoke/审查)**包含在 Orchestrate 流程里**,是 lead 执行流程的自动产出 → 沉淀成「这个需求改了哪些文件、跑了哪些测试」的清单。**PM 只看这份清单判断「改动+测试是否覆盖了原需求意图」**(产品颗粒度,不碰技术)。`reviewerAgentId` 默认不再是 PM(技术验收在流程内);PM 的角色是「覆盖判断」而非「技术 accept」。验收通过 → lead→archivist 通知合并。
- **驳回回路**:
  - plan 门驳回 → lead 拿反馈**自重 Orchestrate 流程**(同角色);仅当需求本身有问题才退 `discuss`、通知 PM 重谈。
  - 验收不通过(PM 判「未覆盖需求」)→ PM→lead 交接、通知 lead 补;根本性问题 → 退 `discuss`,PM 重新找用户谈。

### 2.10 discuss:文档为中心

discuss 不靠 session 隔离,**需求文档是持久 substrate**:

- **入口**:看板需求卡「讨论」→ **跳转到该 project 的 PM session 页面**(`{角色=PM, projectId} → session`,找/建)。
- **PM session 页面** = 跟 PM 的持久对话 + 文档/目录面板(复用现有 chat 页面的文档+目录渲染),展示该 project 的所有需求文档。跨 cron 触发、跨日期都在这一处(同一 `{PM, project}` session)。
- **需求 = 文档 + 记录**:
  - **RequirementRecord**(DB,喂看板):名称、摘要、属性、status、指派字段 + `docPath`(指向 repo 内文档)。
  - **需求文档**(文件,markdown):完整内容 + 讨论沉淀。
  - **需求文档是 wiki 树的一个叶子节点(v0.7)**:wiki 是项目文档的**结构本身**,代码文件、需求文档都是叶子(见 §2.16/§2.19)。需求文档这个叶子由 PM 管(写内容),archivist 只读它、在 wiki 树里为它建意图节点 + 关系。
  - 卡片 = record 的摘要/属性;完整文档在 PM session 页面显示。
- **需求文档放代码仓库**(如 `{workspace}/.zero/requirements/{projectId}/`),跟 repo 走、**跨设备可恢复**。
- **无 session 隔离**:状态不在 session 里、在文档里。PM 用文件工具现读文档(不用 session 启动注入上下文)。
- **用户创建的需求也生成需求文档**,归到该 project(由该 project 的 PM session 认领建档)。
- ready 确认 → status→ready → Project 通知 lead。

### 2.11 执行上下文:全局角色 + session 上下文 bundle(v0.8 统一)

v0.8 取消「项目绑定 agent」,所有角色全局化,上下文统一由 session 携带:

- **session 上下文 bundle(D-B)**:每个 session 携带 `{ projectId?, workspaceDir, wikiRootNodeId }`:
  - `projectId` —— 当前服务的 project(全局观察 session 可空)
  - `workspaceDir` —— 当前工作目录(项目 session = `project.workspaceDir`)
  - `wikiRootNodeId` —— wiki 访问根(项目 session = 该 project 子树根;全局 session = 全局根)
- **上下文谁塞给 session**:
  - **被同步调用**(dev/review/qa/analyzer/planner 被 lead/PM/archivist 调):**继承 caller session 的 bundle**(caller 可 per-call 覆盖,如限定子目录)。身份 + 历史 + toolPolicy 用目标 agent 自身。
  - **被异步触发**(PM/lead/archivist 被 cron 或 Project 通知触发):**来自触发器的 scope** —— cron 的 `workingScope`(§2.4)或 notification 携带的 projectId。触发器找/建 `{agentId, scope}` 的 session。
- **`{角色, projectId} → session` 映射**:discuss/通知/cron 都靠它路由到一个具体 session(找已存在则续接、不存在则新建)。这是 v0.8 的运行时新概念,取代 v0.7「项目绑定 agent 实例」。
- 需扩展 `delegateTask`:传目标 agent 全配置(toolPolicy、agentId)+ per-call 覆盖(workspace、scope);同步调用时把 caller 的 bundle 传下去。

### 2.12 session 生命周期、并发与归档(两个独立提取者,v0.8)

- **并行**:每 session 独立 AgentLoop,多 cron/子 agent/用户聊天互不阻塞
- **临时 session 归档**:cron/子 agent session 运行完归档;chatUI 只留用户对话 session 和 `{角色, project}` 入口 session
- **归档 = 两个独立提取者(并行,v0.8 重构「双 API call」)**:参考 MiMo Code 的 **Writer —— 独立于主 agent 的提取者身份**:工作 agent 擅长做事、不擅长反思,所以归档**不让工作 agent 自己做,派独立提取 agent**(事后异步)。两个各司其职,可并行:
  - **提取者 A —— 内容记忆 / 关闭 flush**:读 transcript → 抽「做了什么 / 决策 / 成果 / 经验」→ 写入**全局 wiki 树 `type=memory` 节点**(跨项目角色技能,不绑 project)。**统一职责(v0.8 D-C 定稿推广)**:① session 关闭时对未提取的尾批做 terminal flush(§2.18 机制 3);② 预算分批提取后的提升(§2.18 机制 2)。提取者 A 不再是「易失 session 专用」,而是**所有 session 的统一关闭归档器**。
  - **提取者 B —— 工具遥测**:读 transcript → 抽**工具调用情况,尤其失败/无效调用**(错参数、幻觉工具名、重复重试)→ 写入**独立遥测存储**(v1;非 wiki 树,因为它是平台改进数据,不是项目知识也不是角色记忆)。这是未来优化 basic tool 和 agent-tool 定义的重要数据源(自管理,见决策 49)。
  - 两者都独立 agent、事后异步、互不阻塞。开关可配置。
- **写隔离靠角色 scope,不用锁**:
  - PM cron:**只建新需求文档**,代码 read-only、wiki 树结构 read-only(§2.16)
  - PM discuss:**只改已有需求文档**的内容(需求文档叶子),不碰 wiki 树结构
  - archivist:**只读写自己 project 的 wiki 树结构**(建结构节点/指针/关系),对实际项目文档(代码、需求文档等)只读
  - lead/dev:**只写 feature 分支的代码**;不碰 wiki 树、不碰需求文档
  - 提取者 A:只写**全局 memory 节点**(不在任何 project 子树);提取者 B:只写遥测存储
  - → 各写入目标不相交(PM 写需求文档叶子 / archivist 写 project wiki 子树结构 / lead-dev 写代码 / 提取者 A 写全局 memory / 提取者 B 写遥测),零冲突

> **易失 session 归档 vs 可见 session(v0.8 明确 OQ6)**:所有 session 都归档(含 dev/qa 的子 session)。dev/qa 的记忆是「开发/测试相关经验」,**可跨项目** → 写全局 memory 节点(不绑 project)。与提取者 A 的写入位置一致。

### 2.13 archivist 的更新与意图理解

**更新来源 = git(骨干):**
- archivist 的扫描游标 `lastScannedRef`(主分支 commit sha)按 **(archivist, project)** 维度记录(archivist 全局化后,游标不能挂在 agent 上,见 §4)。**只跟踪 main** —— 合并后跑 `git log/diff <last>..main`,只重读变化部分更新 wiki;feature 分支的 WIP **不进 wiki**(见 §2.15)。
- 周期性全量 rescan 兜底漂移/归一化。可选 fs.watch 实时感知,落地仍走 git。
- **N1 归属精确化**:git 管的是 **project**(workspace 里的文档 + 代码,跨设备同步的 artifact);**wiki 树的非叶节点(结构)在数据库**,不经 git。git 是 project artifact store + 变更信号,wiki 结构靠数据库同步。

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

### 2.14 zero:全局管理角色(对话式搭建 workflow)

zero 作为**全局管理角色**,通过对话创建和配置整个 workflow:

- 配 **agent/project/cron 管理工具**(封装 ProjectStore/AgentStore/CronStore/AgentToolStore):create/update/delete project、create/update/delete agent、create/update/delete cron(指定 agent + scope + schedule)、set toolPolicy、expose-as-tool
- 内置**角色预设模板**(§3),一键实例化全局角色 + 接好 toolPolicy + 配项目 cron
- 用户对话描述需求,zero 建 Project(绑 workspaceDir)+ 配全局角色(PM/lead/archivist + analyzer/planner/dev/review/qa)+ 为该 project 建 cron(把全局角色 + scope 绑到节奏)
- 工具层扩展,不改数据模型

### 2.15 Git 分支与合并

按分支划分 git 责任:**archivist 管 main,lead 管 feature 分支**(每条分支单一提交者,零 git 竞态):

- **workspace 必须是 git repo**:非 repo 时 archivist 自动 `git init`。
- **lead 管 feature 分支**:需求进 build 时 lead 创建 feature worktree(独立目录/沙盒,如 `{workspace}.worktrees/req-{id}/`,分支 `req-{requirementId}`);**lead 在实现每一步 commit**(增量,**commit 引用 reqId** 喂 traceability)。默认串行(lead 一次一个需求)。
- **archivist 管 main**:主 worktree 留 main —— PM 写需求文档,**由 archivist 统一 commit 到 main**(PM 不碰 git);**PM verify accept 后,archivist 把 feature 分支合并回 main** + 清理 feature worktree → 需求 `closed`。archivist 的 wiki 产出在数据库,不经 git。
- **archivist 只索引 main**:合并后 main 前进 → Project 通知 archivist 刷新 wiki/traceability(cron 兜底);feature 分支 WIP 不进 wiki。
- 生命周期:`verify`(accept)→ archivist merge main → `closed`。

> **N1**:git 同步的是 project artifact(workspace 里的文档+代码);wiki 树结构在数据库,不进 git。

### 2.16 wiki 树结构维护(archivist 的职责,v0.7 重构;v0.8 N2 精确化)

**核心转变:wiki 是项目文档的「结构本身」,不是「另一批文档」。** 代码文件、需求文档、ADR 等都是 wiki 树的**叶子节点**;archivist 管的是**叶子指向的指针 + 它们之间的关系**(结构),不是叶子内容本身。

**两层严格分离:**
- **实际项目文档**(workspace 里的代码文件、需求文档文件等)= archivist **只读**。它不写代码、不写需求文档内容(需求文档内容归 PM)。文件说明书不再是「代码文件头部的注释」—— 它现在是 **wiki 树里的 header 节点**,描述一个代码文件。
- **wiki 树**(在 zero-core 数据库,不在项目 workspace)= archivist **可读写,但仅限自己服务的 project 子树**。archivist 在该子树上建结构节点,节点带指针指向实际文档:`意图节点` → 指向需求文档,`header 节点` → 指向代码文档;并维护节点间关系(模块包含、依赖、需求↔实现 traceability)。

**N2 精确化 —— 两类写入者写不同子树,不冲突:**
- **archivist** 维护的是**自己 project 的 wiki 子树结构**(结构节点 + 指针 + 关系)。
- **提取者 A** 写的「记忆节点」是**全局 wiki 树的 memory 类节点(不绑 project,跨项目)**,**不写在任何 project 子树里**。
- 两者目标子树不相交 → 无写入冲突。这也澄清了 v0.7「archivist 是 wiki 唯一维护者」的精确边界:archivist 是 **project wiki 子树结构**的唯一维护者,不是整个记忆树的唯一写入者。

**作废 v0.5/v0.6 的设计:**
- ~~archivist 回写代码文件头注释、兜 doctor 标准化门禁~~ —— archivist 不碰代码文件了。文件说明书迁移为 wiki 树里的 header 节点(描述代码文件,但写在数据库 wiki 树上,不在代码文件里)。
- ~~docs/basic ↔ wiki 分歧信号~~ —— `docs/basic` 是 openprd 的产物,**本工作流砍掉**。

**archivist 怎么维护 wiki 结构:**
- **增量更新**:记 `lastScannedRef`(main commit sha,按 (archivist, project) 维度),合并后跑 `git log/diff <last>..main`,只重读变化的项目文档 → 更新对应的 wiki 结构节点。
- **provenance 标签**(见 §2.17a):每个结构断言标 `structure`(从代码推断)/`derived`(从 commit·ADR 聚合)/`confirmed`(从需求文档·用户 discuss),让 archivist 自己知道哪条该信、哪条该 flag。
- **分歧信号(保留但重定向基线)**:archivist 不再对齐 docs/basic(已砍),改为对齐 **wiki 意图节点(指向需求文档)↔ 代码结构(指向代码文档)** —— 需求文档是人写的「应该怎样」,代码结构是「实际怎样」,两者 diff 是高价值信号:需求未实现 → flag;代码有需求文档没覆盖的能力 → flag(可能是隐性需求或跑偏)。

**这跟「干净视角 + 全局 wiki 树」的关系:** archivist 写的 wiki 结构节点都在它服务的 project 子树下(§2.19);PM 读 wiki 时看到的是结构 + 叶子指针,可以顺着意图节点找到需求文档、顺着 header 节点找到代码 —— wiki 树是 PM/lead 访问项目知识的统一入口,而 archivist 是这棵 project 子树结构的唯一维护者。

### 2.17 wiki provenance + verify 证据清单 + 单流程(v0.6;v0.7/v0.8 修订)

本节把「干净视角 + 沉淀」的哲学落到三处具体机制。**刻意收窄范围**:只服务本工作流自身,不引入通用 harness 的复杂度。

**(a) wiki node provenance —— 给 archivist 自己用,不泛化。**
archivist 在 wiki node 上记每条断言的**出处标签**:
- `structure` —— 从代码结构推断(模块/类型/调用图),可靠但只描述 what。
- `derived` —— 从 commit message / ADR / 设计文档 / 注释聚合的意图,有依据但可能滞后。
- `confirmed` —— 从用户 discuss 或 PM 需求文档拿到的,人确认过的意图。

**目的不是给全工作流打标签,而是让 archivist 自己知道哪条该信、哪条该 flag**(§2.16 的分歧信号据此才有底气:「这条 `structure` 推断和意图节点冲突」比「这条和文档冲突」可操作得多)。PM/lead 读 wiki 时也能一眼看出哪些是事实、哪些是推断。这是 archivist 层内的工具,不外溢成通用 provenance 体系。

**(b) verify = Orchestrate 流程的自动产出 + PM 的覆盖判断(v0.7 修订 M4)。**
验收**不再让 PM 做技术判断**(那违反 PM 的产品颗粒度)。验收工作(单测、smoke、审查)**包含在 Orchestrate 流程里**,是 lead 执行流程的自动产出,沉淀成清单:**这个需求改了哪些文件、跑了哪些测试、审查结果如何**。PM 看这份清单,只判断一件事 —— **改动 + 测试是否覆盖了原需求意图**(产品视角的覆盖判断,不碰技术细节)。不通过则通知 lead 补;根本性问题退 `discuss`。**不引入 openprd `productionReady` 多门禁聚合**(通用 harness 复杂度,本工作流不需要)。

**(c) 本版单流程,不做入口分流。**
所有需求走同一条 发现→discuss→ready→plan→build→verify。**砍掉**「L0 小修直干 / L1 mini-plan / L2 完整流程」这种入口复杂度分流 —— 那要求 PM 在入口判断颗粒度,反而增加 PM 的判断负担、违反「每层视角固定」的哲学。颗粒度由层级固定(lead 该不该拆给 planner、planner 该不该派 dev),不由 PM 在入口预判。简化后 PM 的视角更干净。

### 2.18 记忆与上下文恢复(v0.8 定稿 —— 领域无关,无 checkpoint/无 transition 检测)

**目标:** **新 session 从记忆恢复 ≈ 续接。** session 历史不是状态真相之源,记忆才是。诚实的可达等价是**内容等价**(重要事实在 wiki),非逐字等价 —— 未固化进 wiki 的逐字 turn 细节在 session 死亡时丢失,这是可接受的(重要就该沉淀)。

**三个领域无关机制(不依赖任何 workflow 结构、不识别写/API/委托等外部事件):**

1. **原始 turn 持久化在 session 存储。** resume 直接拿到全量历史,零 LLM 成本;「当前焦点」就是最近的原始 turn(它们在 session 里活着,不需额外维护 checkpoint)。
2. **早期 + 增量式提取(低利用率多 checkpoint 触发)→ 全局 wiki memory 节点。** 参考 MiMo Code 的反直觉洞察:**不要拖到窗口快满才提取** —— 那恰好是反着的。原因:(a)「lost in the middle」—— 模型在高上下文利用率下能力衰减(中段注意力下降、结构化提取可靠性降低),要求它在压缩能力正在退化的时刻做最关键的压缩,是亏本交易;(b) 提取本身需要空间(读历史 + 维持解读 + 写结构化输出都在同一窗口),95% 利用率已无处思考,30% 则游刃有余。因此**提取在远低于上限处触发**(大致 20% / 45% / 70% 预算多个 checkpoint),每次触发是**对前一次的增量更新**——只处理提取 cursor 之后的增量(delta),不重新过整段 transcript;产出**合并进已有 memory 节点**(按 subject+type 演进,更新而非每次新建,对接现有 memory 节点设计)。没有任何一次是孤注一掷的总结;接近上限的最后一次 rebuild,不是仓促压缩,而是**把一路累积的结构化记录变现**。触发按 token 预算**低点**(非高点)、不按 turn(每 turn 压缩太贵)。一箭三雕:① 在模型还锐利时提取(质量优先,非单纯腾空间);② 产出跨 session 耐久事实;③ 每次提取 O(delta) 便宜。领域无关。
3. **关闭 flush(= 提取者 A)对尾批提取 → wiki。** session 结束时,对最后一次 checkpoint 之后未提取的尾批跑一次增量提取(机制 2 的最后一次 delta),内容合并进 wiki memory 节点。即「把累积结构化记录变现」的终点:session 死/关,尾批内容不丢。

**明确不要的东西(踩过的坑):**
- ~~活 checkpoint(当前工作态节点)~~ —— 多余。原始 turn 本就持久化,「当前焦点」从最近的原始 turn 读,不需额外维护。
- ~~transition / 任务变迁检测器~~ —— 耦合 workflow 结构(Orchestrate 节点 / requirement status),换场景就废,违反自组织原则(§2.1)。
- ~~外部事件锚点(写即锚点 / API 即锚点)~~ —— 每个候选都只覆盖一类场景(PM 写文档 / API / 委托),无通用锚点。提升靠「值得留吗」的判断,不靠事件类型。
- ~~每 turn 压缩~~ —— 太耗 token。

**恢复流程(诚实版):**
- **resume**:全量原始 turn(session 存储)+ 召回相关 wiki memory 节点。
- **new session**:只拿 wiki memory(含关闭 flush 的尾批)。丢「逐字原始 turn」,但内容已在 wiki(内容等价)。

**对齐现有实现(实现期需对当前代码核实,以下基于历史记忆):** zero-core 已有 L1/L2 渐进压缩,本就是**阈值触发**(context > 70% 才压缩最旧未压缩 turn)—— 即预算分批,方向一致;已有 memory 节点进 SQLite+FTS5;已有新问题匹配旧记忆节点召回注入。D-C 的实际工作量是:**① 把阈值分批提取对齐到全局 wiki 树**(memory 节点从散落 SQLite 迁到 §2.19 的全局 wiki 树)、**② 补关闭 flush**(提取者 A 对尾批)、**③ 修 prune/compress 顺序 bug**(大单 turn 被直接丢弃而无摘要 —— 这正是「单 turn 溢出」场景,Q-D1 的核心论据)。不引入新机制。

### 2.19 wiki 记忆树架构与访问权限(v0.7;v0.8 访问根搬到 session 级)

§2.16 讲了 archivist 在一棵 wiki 树上做结构维护。这棵树是**全局唯一**的、是 zero-core 全部知识/记忆的载体。本节定义它的结构与访问边界。

**一棵全局 wiki 记忆树:**
- 整个 zero-core 只有一棵 wiki 记忆树,存在**数据库**(不在任何项目 workspace)。
- 各类记忆都挂在这棵树上:**项目文档**(代码文件、需求文档、ADR)= 叶子节点;**各 project 的 wiki 子树**挂在 `project` 节点下(对某个具体项目的记忆);其他类型记忆(跨项目角色技能、工具使用心得、易失 session 归档总结等)挂在各自类型的节点下。
- 沉淀**不硬性按角色分割** —— 经验都写进这棵树,只是别的角色平时用不到所以不读(不是私有存储)。这正是 §2.1 沉淀哲学的物理载体。

**视角边界 = wiki 访问权限(读取根节点 wikiRootNodeId),v0.8 搬到 session 级:**
- **项目角色 session**(PM/lead/archivist 服务某 project 时):wiki 根 = 该 `project` 子树。看不到更大根 —— 看不到别的 project、看不到跨项目记忆的更上层结构。整个知识视野 = 「这一个项目」。
- **全局 session**(如 zero 观察、或某角色被配全局 scope 的 cron):根更高,可观测**所有 project 子树**及全局类型节点 → 能跨项目看到运行情况、做全局管理/观测。
- 同一角色(PM)在 project A 的 session 看到 A 子树、在 project B 的 session 看到 B 子树、在全局 session 看到全部 —— 完全自洽,因为访问根是 session 级,不是 agent 级。视角隔离因此是**结构上强制的**(读到哪棵子树由 session 上下文决定),而非「私有存储 + 自觉」。

**节点类型(结构层,archivist 维护;叶子内容各归其主):**
- `header 节点` —— 描述一个代码文件,指针指向该文件(archivist 从代码推断 + provenance 标)。
- `意图节点` —— 描述一个需求文档,指针指向该文件(PM 写内容,archivist 建节点 + 关系)。
- `结构节点`(模块/子系统/约定等)—— archivist 从代码 + artifact 聚合,带 provenance。
- `memory 节点` —— 提取者 A 写的跨项目角色技能 / 易失 session 归档(不绑 project,挂全局类型节点下)。
- 关系边:模块包含、依赖、需求↔实现 traceability、文档↔代码。

**archivist 的 scope:** 只在自己服务的 `project` 子树下读写结构节点(建/改节点 + 指针 + 关系);对实际项目文档只读;不碰别的 project 子树、不碰全局类型节点(memory 节点归提取者 A,见 §2.16 N2)。

---

## 3. 能力与预设

> v0.8:所有预设都是**全局角色**,不绑 project;「项目侧三角色」(lead/PM/archivist)经 session 上下文 + 项目 cron 服务具体 project。

| 预设 | 上下文来源 | 典型能力组合 | 说明 |
|------|------|------------|------|
| lead | 项目 cron/notification → session | toolPolicy 放行多个 planner/dev/review/qa + Orchestrate 工具 | 交付:pickup→planner 大纲→拆 Orchestrate DSL(指定各节点用哪个 agent)→用户确认门→run→验收产出 |
| PM | 项目 cron/notification → session | toolPolicy 放行多个 analyzer | 产品:发现→需求文档→discuss;读 wiki;验收时判覆盖 |
| archivist | 项目 cron/notification → session | 实际项目文档只读 / wiki 树读写(§2.16),toolPolicy 放行 analyzer(architecture lens) | 知识:wiki 树结构 + 需求↔设计 traceability + provenance + 意图↔结构分歧信号 |
| analyzer | 继承 caller session | 各 lens 的分析 prompt(UI/安全/性能/架构…) | caller 按维度选不同实例 |
| planner | 被 lead 调用(继承 caller) | 各领域规划 prompt(功能/bugfix/重构/调研…) | lead 按需求类型选不同实例 |
| developer | 被 lead 调用(继承 caller) | 写文件 prompt | 编码 |
| reviewer | 被 lead 调用(继承 caller) | 审查 prompt | 代码审查 |
| qa | 被 lead 调用(继承 caller) | 测试 prompt | 测试验证 |
| zero | 全局 cron/对话 → session(全局根) | agent/project/cron 管理工具 | 全局管理:对话式搭建 workflow |

预设只是起点,可任意组合。

---

## 4. 数据模型变化

### 4.1 AgentRecord(瘦身:角色全局化,v0.8)

v0.8:agent 全局化,从 AgentRecord 移除 `projectId` / `cronSchedule` / `cronPrompt` / `wikiRootNodeId` / `lastScannedRef`(后三者搬到 session/cron/project)。AgentRecord 回归纯角色定义:

```typescript
interface AgentRecord {
  // ... existing(prompt、model、toolPolicy 等不变)...
  roleTag?: string;   // 可选角色标签(PM/lead/archivist/zero/…),仅作预设入口与 UI 分组,非运行时类型
  workspaceDir?: string;  // 全局/独立 agent 的默认 workspace(项目角色 session 走 project.workspaceDir,忽略此项)
}
```

**不加** `workflowRole`、**不加** `subAgentChain`(调用图走 toolPolicy)。

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

原 `analysisInterval`/`status`/`analystCronId`/`analystSessionId` 等运行态废弃(cron 升为一等公民 §2.4,通知由 Project 在状态转移时发出)。

> archivist 扫描游标 `lastScannedRef` 按 (archivist, project) 维度记录,可挂在 ProjectRecord(单 archivist 场景)或独立 cursor 表(多 archivist 场景),实现期定。

### 4.3 CronRecord(新增,一等公民,v0.8)

```typescript
interface CronRecord {
  id: string;
  agentId: string;            // 执行者:全局角色 agent
  workingScope: {             // 工作范围 = session 上下文 bundle
    projectId?: string;
    workspaceDir: string;
    wikiRootNodeId: string;
  };
  schedule: "off" | "hourly" | "daily" | "weekly" | string;
  prompt?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### 4.4 SessionRecord(+ 上下文 bundle,v0.8)

```typescript
interface SessionRecord {
  // ... existing(id、agentId、messages 等)...
  context?: {                // v0.8:session 上下文 bundle(D-B)
    projectId?: string;
    workspaceDir: string;
    wikiRootNodeId: string;
  };
}
```

`{角色, projectId} → session` 映射由 `(agentId, context.projectId)` 查找;不存在则新建。discuss/通知/cron 都靠它路由。

### 4.5 RequirementRecord(改挂 projectId + 指派 + docPath + 覆盖判断)

```typescript
interface RequirementRecord {
  projectId: string;
  docPath: string;            // repo 内需求文档路径(wiki 树的一个意图叶子节点)
  createdByAgentId?: string; // 创建该需求的 PM(全局角色 agent id;discuss 路由靠 projectId + 角色)
  assignedAgentId?: string;  // 拉取该需求的 lead(全局角色 agent id)
  reviewerAgentId?: string;  // 覆盖判断方(默认 = createdByAgentId 的 PM);注意 v0.7 后这是"覆盖判断"而非"技术 accept",技术验收在 Orchestrate 流程内
  // ... 其余不变 ...
}
```

### 4.6 WikiNode(全局记忆树,v0.7 重构;v0.8 加 memory 节点归属)

**一棵全局 wiki 记忆树**(数据库,不在项目 workspace),节点类型按结构/叶子区分:

```typescript
interface WikiNode {
  id: string;
  parentId?: string;          // 树结构:挂哪个父节点下(project 子树 / 全局类型节点)
  type: "header" | "intent" | "structure" | "project" | "memory" | ...;
  // header → 代码文件;intent → 需求文档;structure → 模块/子系统;project → project 子树根;memory → 跨项目角色技能/易失 session 归档(挂全局类型节点,不绑 project)
  docPointer?: string;        // 叶子节点指向的实际文档路径(代码文件 / 需求文档 / ADR),实际文档不在 wiki 里
  provenance?: "structure" | "derived" | "confirmed";  // 结构断言出处(archivist 自用,§2.17a)
  requirementIds?: string[];  // traceability:此节点关联的需求
  summary: string;            // 节点摘要
  // ... 关系边、时间戳等 ...
}
```

`project` 子树 = 挂在某 `project` 节点下的全部节点(该 project 的记忆);archivist 只在自己服务的 project 子树下读写结构节点;`memory` 节点由提取者 A 写、挂全局类型节点下(不在 project 子树)。

### 4.7 TaskStepRecord

跟随所属 RequirementRecord;记录 `touchedFiles` + 测试执行结果(供 archivist 拼 traceability + 喂 PM 覆盖判断清单,见 §2.17b)。

---

## 5. 对 M1-M5 现有代码的影响清单

> 只列影响面。下文 `analyst-service.ts` 等为现有 M1-M5 文件名,实现期可重命名。

### 数据层
- `src/shared/types.ts` — AgentRecord **瘦身**(移除 projectId/cron/wikiRootNodeId/lastScannedRef,加 roleTag);ProjectRecord 精简;**新增 CronRecord**;**SessionRecord + context bundle**;RequirementRecord +docPath/指派/覆盖判断;WikiNode 重构为全局记忆树(+memory 节点归属)
- `src/server/db-migration.ts` — agents 表删列/加 roleTag(**同步 AGENT_COLUMNS**);projects 表精简;**新增 crons 表**;sessions 表加 context 列;requirements 表 projectId+docPath/指派;wiki_nodes 表重构(全局树,memory 节点)
- `src/server/agent-store.ts` / `project-store.ts`(精简)/ **新增 `cron-store.ts`** / `requirement-store.ts` / `wiki-node-store.ts`(全局树读写 + 按 session 上下文的 wikiRootNodeId 截断查询) — 对应字段与查询

### 服务层
- `src/server/analyst-service.ts`(对应 PM)— 重构为被自身 cron 驱动(发现/建需求),删 `ensureAnalystAgent`;**不依赖 project 绑定,靠 session 上下文**
- `src/server/lead-service.ts` — `ensureLeadAgent` → 读 `assignedAgentId`;pickup 逻辑保留;**plan 改为 planner 大纲 → lead 拆 Orchestrate DSL(指定各节点 agent)→ Orchestrate.confirm 门**
- **新增 `archivist-service.ts`** — git 增量扫描、**wiki 树结构维护**(建/改 header·intent·structure 节点 + 指针 + 关系,数据库内,不碰实际文档)、provenance 打标、traceability 拼接、意图↔结构分歧检测;对实际项目文档只读;扫描游标按 (archivist, project) 维度
- `src/server/cron-analysis.ts` — **调度源从 agentStore.cronSchedule 切到 cron 表**(多条 cron,各带 scope)
- **新增 project 通知分发** — requirement 状态转移时按 §2.9 表向 `{角色, projectId} → session` 发通知(找/建 session);cron 兜底;看板提醒 plan 门待确认
- **新增 `{角色, projectId} → session` 路由** — discuss/通知/cron 统一入口

### 归档层(v0.8 新)
- **提取者 A(内容记忆)** — 读易失 session transcript → 写全局 wiki memory 节点
- **提取者 B(工具遥测)** — 读 transcript → 抽工具调用(失败/无效)→ 写独立遥测存储

### 编排层
- `src/server/agent-service.ts` — **删 `createRoleLoopFactory`**;子 agent 走 `delegateTask` + toolPolicy + caller bundle 继承
- `src/runtime/tools/orchestrate-tool.ts` — **Orchestrate DSL 引擎**(parallel/pipeline/if/for/barrier);**内置 plan 门 = `Orchestrate.confirm`**;**验收工作(单测/smoke/审查)作为流程节点自动执行 + 产出清单**;不再造临时 role agent
- `src/runtime/tools/agent-tool.ts` + `delegateTask` — 扩展传目标 agent 全配置 + per-call 覆盖 + caller bundle 继承
- **角色预设模板(新)** — lead/PM/archivist/analyzer/planner/dev/review/qa(全局角色)
- **agent/project/cron 管理工具(新)** — 供 zero 调用

### 前端
- `AgentEditor.tsx` — roleTag、cron 区移到独立 cron 编辑器、「可调用 Agent」选择器;**移除 projectId 归属 / wikiRootNodeId**(搬到 session/cron)
- **新增 cron 编辑器** — 选 agent + scope(projectId/workspace/wikiRoot)+ schedule
- `KanbanPage.tsx` — 按 Project 分组;需求卡「讨论」跳 `{PM, projectId} → session`;plan 门待确认提醒
- **验收覆盖判断视图** — PM 验收时展示「改动文件 + 测试清单」,PM 判覆盖(§2.17b)
- **每 `{角色, project}` 的 chat 页面** — 复用现有文档+目录渲染
- `src/shared/ipc-api.ts` / `preload` / `ipc-proxy` — projects 精简 CRUD;**新增 crons CRUD**;保留 requirements;wiki 改为全局树查询(按 session 上下文的 wikiRootNodeId 截断)

---

## 6. 已确认的决策(基线)

**调用图与字段**
1. ✅ 复用 agent-as-tool + toolPolicy,不加 `workflowRole`/`subAgentChain`
2. ✅ toolPolicy 对 agent-tool 已 opt-in;且以 `AgentToolEntry.id`(稳定)为 key 存配置(UI 显示 name),改名不断引用、删工具才 orphan

**Project 实体**
3. ✅ 轻量 `Project` 绑定 workspace,是看板入口 + 并发单元 + 通知枢纽 + 归属键
4. ✅(v0.8 修订)**所有角色全局化**,不再「agent 绑定 project」;Project 不持有 agent 绑定关系,也不持有 cron 运行态
5. ✅ Project 生命周期:zero 对话创建(显式);workspace 唯一+不可改;删 Project 绝不碰文件,默认 archive / 硬删级联(含该 project 的 cron);删 cron 解绑不删全局 agent

**三角色分工 + cron(v0.8:cron 一等公民)**
6. ✅(v0.8 修订)cron 是一等公民(独立于 agent 和 project),PM/lead/archivist 经「项目 cron」服务 project;各管一块(产品/交付/知识)
7. ✅ PM 独立(项目 cron 驱动),不被 lead 调用;管发现 + 需求 + discuss;cron 只建新需求、wiki/代码 read-only
8. ✅ lead 收窄为交付:pipeline(pickup→plan→build)+ 门
9. ✅ archivist 专职 wiki 结构:**对实际项目文档只读,对 wiki 树读写(限自己 project 子树)**;维护 wiki 结构节点 + traceability + provenance

**通知与门**
10. ✅ 通知只在跨角色边界:ready(PM→lead)、verify/覆盖判断(lead→PM);通知目标 = `{角色, projectId} → session`;plan 门是工具调用级暂停,不跨角色通知;cron 兜底;pickup 幂等靠 assignedAgentId 已写则跳过
11. ✅ 门 = 工具调用本身(v0.7 具体化为 Orchestrate.confirm):lead 用 planner 出大纲 → **自己拆 Orchestrate DSL(指定各节点用哪个 agent)** → `Orchestrate.confirm` 等用户确认才 run,否则返回 false;审核暂停 = 工具未返回、不超时、不占资源;驳回回路:plan 驳回 lead 自重 Orchestrate 流程 / 覆盖判断未通过通知 lead 补 / 根本问题退 discuss

**需求与文档**
12. ✅ 需求 = 文档(repo 内,跨设备)+ 记录(DB);RequirementRecord +`docPath`
13. ✅ discuss 文档为中心:PM session 页面、需求文档入 repo、无 session 隔离(文档是 substrate)
14. ✅(v0.8 修订)**一个 project 一个 PM session 入口**(不是「一个 PM agent」—— PM agent 全局唯一);路由靠 `{角色=PM, projectId} → session`;多样化产品需求靠其他 agent tool
15. ✅ ready→pickup 用 pull 模型(通知为主 + cron 兜底)

**子 agent 与 session(v0.8:全局角色 + session 上下文)**
16. ✅(v0.8 修订)**所有角色全局化**:上下文由 session 携带(D-B bundle:projectId/workspaceDir/wikiRootNodeId);被同步调用 → 继承 caller bundle;被异步触发 → 来自 cron/notification scope;身份/toolPolicy/历史用目标 agent 自身
17. ✅(v0.8 修订)session 并行;**归档 = 两个独立提取者**(A 内容记忆 / B 工具遥测),可配置开关
18. ✅ 写隔离靠角色 scope(PM 写需求文档叶子内容;archivist 写 project wiki 子树结构;lead/dev 写 feature 代码;提取者 A 写全局 memory 节点;提取者 B 写遥测),目标不相交,无锁

**archivist 机制**
19. ✅ git 增量更新(`lastScannedRef` 按 (archivist, project) 维度 + log/diff)+ 周期全量 rescan
20. ✅ 意图从 artifact 聚合(代码结构 + commit/需求文档/ADR/注释);深度外包 analyzer
21. ✅ 需求↔设计 traceability:读需求文档 + 工作轨迹(task steps、commits 引用 reqId)+ 代码;约定 commit 引用 requirementId

**其他**
22. ✅ 角色 = prompt 预设 + 工具配置(toolPolicy)+ 写 scope 的组合,非运行时类型;**v0.8:角色全局化,roleTag 仅作预设入口/UI 分组**
23. ✅ 不改现有 agent,不写迁移脚本;M1-M5 数据破坏性重构(无真实数据)
24. ✅ zero 全局管理角色(对话式搭建 workflow,工具层扩展,含 cron 管理)

**Git 分支**
25. ✅ feature 分支由 lead 管(进 build 时建 worktree、每步 commit 引用 reqId);PM verify accept 后 **archivist** 合并 main → closed → 清理 worktree
26. ✅ archivist 只索引 main(合并后刷新 wiki/traceability),feature 分支 WIP 不进 wiki
27. ✅ git 按分支划分:archivist 管 main(统一 commit PM 文档、合并、非 repo 自动 init);lead 管 feature(建 worktree、commit);PM/dev 不碰 git
28. ✅ 默认串行(lead 一次一个需求);多需求并行留以后

**archivist 文档维护(v0.5 提出,v0.7 作废大部分)**
29. ✅(v0.7 作废)~~archivist「逻辑 read-only、文档注释可写」、回写代码头注释~~ —— v0.7 改为「实际项目文档只读、wiki 树读写」,archivist 不再碰任何项目文件(含代码头注释);文件说明书从「代码头注释」迁移为「wiki 树里的 header 节点」
30. ✅(v0.7 保留精神)archivist 增量维护 wiki 结构:扫到文件实质变化 → 更新对应 wiki 结构节点,**不改原文件**
31. ✅(v0.7 改基线)分歧信号从「docs/basic ↔ wiki」改为「wiki 意图节点 ↔ 代码结构」;**docs/basic 砍掉**;archivist 不擅自改代码,只 flag

**设计哲学与收窄(v0.6 新增,v0.7/v0.8 修订)**
32. ✅ 工作流目的 = 层级调用给每个 agent 一个干净视角;**沉淀 v0.8 三层**:角色技能记忆(全局 memory 节点)/ 项目知识(project wiki 子树)/ 平台遥测(独立存储);**视角边界 v0.8 搬到 session 级**(wikiRootNodeId 在 session 上下文,非 agent 字段)
33. ✅ wiki node provenance 只给 archivist 自己判断该信哪条 + PM/lead 读时参考,不泛化
34. ✅ 验收技术工作在 **Orchestrate 流程内自动执行 + 产出清单**;**PM 只判覆盖**(产品视角,不碰技术);reviewerAgentId 语义 = 覆盖判断方;不引入 productionReady 多门禁聚合
35. ✅ 本版单流程,不做 L0/L1/L2 入口分流;颗粒度由调用层级固定

**wiki 架构与门控(v0.7 新增)**
36. ✅ wiki = 项目文档的「结构本身」;代码/需求文档/ADR 都是叶子;archivist 管结构
37. ✅ 一棵全局 wiki 记忆树在数据库;project 子树挂 project 节点下;memory 节点挂全局类型节点(不绑 project)
38. ✅(v0.8 修订)视角边界 = wiki 访问权限(wikiRootNodeId),**搬到 session 级**:项目角色 session 根 = project 子树;全局 session 根 = 全局根。同一角色不同 session 不同视野,结构强制
39. ✅ archivist 写入守卫靠 prompt 自约束 + 工具能力(只对 wiki 树有写工具,对项目文档只读工具);scope = 自己 project 子树

**身份与上下文分离 + cron 一等公民(v0.8 新增)**
40. ✅ **取消「项目绑定 agent」,所有角色全局化** —— 「PM-for-A / PM-for-B 是同一 agent 的两个 session」,与 dev/review/qa「全局 + 继承 caller」模型统一;从根作废 M1-M5「自动造 project agent」
41. ✅ **cron 一等公民**:独立于 agent 和 project;`CronRecord = {agentId, workingScope, schedule}`;workingScope = session 上下文 bundle;触发即找/建 `{agentId, scope}` session
42. ✅ **session 上下文 bundle(D-B)**:`{projectId?, workspaceDir, wikiRootNodeId}`;被同步调用继承 caller,被异步触发来自 cron/notification scope
43. ✅ **`{角色, projectId} → session` 映射**:discuss/通知/cron 统一路由(找/建)
44. ✅ **归档 = 两个独立提取者**(参考 MiMo Writer 独立提取者身份):A 内容记忆(兜底易失 session,写全局 memory 节点)/ B 工具遥测(抽失败/无效调用,写独立存储);均为独立 agent、事后异步、可并行
45. ✅ **N1**:git 只管 project(workspace 文档+代码);wiki 树非叶节点在数据库,不经 git
46. ✅ **N2**:archivist 维护自己 project 的 wiki 子树结构;提取者 A 写全局 memory 节点(不在 project 子树);两类写入者目标子树不相交
47. ✅ **OQ6**:所有 session(含 dev/qa 子 session)归档;dev/qa 记忆可跨项目 → 全局 memory 节点
48. ✅ **OQ7/OQ9**:Orchestrate 是系统工具(按逻辑编排子 agent 执行的引擎);**lead 是 DSL 作者**,为各节点指定用哪个 agent(toolPolicy 放行);与 MiMo Dynamic Workflow 同(主 agent 写编排)异(我们 lead 撰写 + confirm 门控 + 走 toolPolicy)

**设计约束:自管理(v0.8 新增)**
49. ✅ **zero-core 自管理原则**:平台本身只是又一个 Project,不开后门特例 —— 平台自身的工具/agent-tool 优化、自身文档/记忆,走的跟任何项目一模一样的流程(全局角色 + project wiki 子树 + cron)。提取者 B 的遥测未来作为「zero-core 自管理项目」的数据源,由该项目自己的 dev/archivist 自回归更新。**v1 遥测先独立存储,自管理留作后续。**
50. ✅(v0.8 明确)**没有「单例 vs 多实例」的类型区别 —— agent 之间只有 prompt 和工具能力(toolPolicy)的差异**,没有运行时类型分类。planner/analyzer/dev/review/qa 等用途下用户可配多个不同 prompt/工具的实例,caller(lead/PM/archivist)按问题类型从自己 toolPolicy 放行的实例里挑一个调,不需额外字段(自然用法,非类型系统)。PM/lead/archivist/zero 也只是某些 prompt 预设的 agent,配几个完全由用户决定。「选哪个专家」的细分颗粒度由调用选择体现,不在 caller 视角展开(呼应 §2.1)。
51. ✅(v0.8 根本立场)**自组织原则**:工作流由背景(上下文/知识)、能力(prompt+工具)、关系(toolPolicy 调用图)自组织,非固定角色脚本。本 RFC 的 PM/lead/archivist/dev/... 是 **coding 默认场景的适配预设**,非架构内建角色类型;换领域配不同 agent 即涌现不同工作流,架构层零改动。

**记忆与上下文恢复(v0.8 D-C 定稿,领域无关)**
52. ✅ **新 session 从记忆恢复 ≈ 续接**(内容等价,非逐字):session 历史非状态真相之源,记忆才是;未固化进 wiki 的逐字细节在 session 死亡时丢失(可接受,重要就该沉淀)
53. ✅ **三机制**:① 原始 turn 持久化在 session 存储(resume 免费拿全量)② **早期 + 增量式提取**(在**低利用率**多 checkpoint 触发,非拖到快满 —— 反 lost-in-the-middle + 提取需 headroom;每次只处理 cursor 后 delta,合并进已有 memory 节点 subject+type 演进,不重新过整段、不按 turn)→ 全局 wiki memory 节点 ③ **关闭 flush**(提取者 A)对尾批增量提取 → wiki。现有 L1/L2 触发在 70%/50%(偏 MiMo 反模式高点),工作量是「**降触发点为低点多 checkpoint + 改增量更新(非整段)+ 迁到全局 wiki 树 + 补关闭 flush + 修 prune/compress 顺序 bug**」,不引入新机制
54. ✅ **明确不要**:活 checkpoint(原始 turn 已持久化,「当前焦点」= 最近原始 turn,不需额外维护)/ transition 检测器(耦合 workflow 结构,换场景废)/ 外部事件锚点(写·API·委托各只覆盖一类场景,无通用锚点;提升靠「值得留吗」判断不靠事件类型)。决策 44 提取者 A 推广为**所有 session 的统一关闭归档器**(不再易失 session 专用)

---

## 7. 开放问题(待讨论)

### ✅ 已收敛(记录决议)
- **Q1(workspaceDir 规范化)**:Project 创建时 `path.resolve + fs.realpath` 归一落库;`projectId` 是身份键(不靠路径字符串相等)。
- **Q2(并发领取)**:标准 1 PM + 1 lead(每 project),通知目标 `{角色, projectId}` 唯一,无竞争 → 消解。
- **Q3(看板入口)**:= Project(决策 3)。
- **Q4(暴露名稳定性)**:toolPolicy 对 agent-tool 以 `AgentToolEntry.id` 为 key(UI 显示 name),改名不断、删才 orphan(决策 2)。
- **Q5(cron/门交互)**:决策 10/11 —— 跨角色边界通知 + 门 session resume + cron 兜底。
- **Q6(PM→analyzer 子 session)**:analyzer 只读、不写文件,归属问题消解;**v0.8:所有 session 含 dev/qa 子 session 都归档**(决策 47)。
- **Q7(wiki/文档并发)**:决策 18 —— 角色 scope 写隔离,无锁。
- **Q-字段共存**:项目角色 session 走 project.workspaceDir;全局/独立 agent 保留 workspaceDir 作默认(见 §4.1)。
- **Project 生命周期 / workspace 唯一性 / discuss 路由**:决策 5/13/14。

### ✅ v0.7 收敛(矛盾/OQ 审计)
- **M1(plan 门审核方 + 恢复源)**:重构成 Orchestrate.confirm 门 —— lead 拆 Orchestrate DSL → 提交 → 停住等用户确认 → 确认才 run 否则 false。审核方 = 用户,看板提醒入口。决策 11。
- **M2(docs/basic 基线 自我消解)**:砍掉 docs/basic;分歧信号基线改为「wiki 意图节点 ↔ 代码结构」。决策 31/36。
- **M3(wiki 写入者归属)**:wiki 是结构本身,需求文档/代码都是叶子;PM 写需求文档叶子、archivist 写 wiki 树结构 —— 职责正交。决策 18/36。
- **M4(verify 颗粒度混给 PM)**:技术验收归 Orchestrate 流程内;PM 只判覆盖。决策 34。
- **OQ1(archivist 写入守卫)**:prompt 自约束 + 工具能力,不走 AST/hook。决策 39。
- **OQ2(archivist scope)**:只在自己 project 子树。决策 39。
- **OQ3(私有沉淀 vs 共用)**:沉淀不硬性按角色分割,落到全局 wiki 记忆树;project wiki 是子树;视角靠 wiki 访问权限做边界。决策 32/37/38。
- **OQ4(plan 门死锁)**:看板提醒 + 停着不占资源。决策 11。
- **OQ5(pickup 幂等)**:assignedAgentId 已写则跳过。决策 10。

### ✅ v0.8 收敛(身份分离 + cron + 提取者 + 归属精确化)
- **OQ8(项目绑定 agent 是否必要)**:**取消** —— 所有角色全局化,「PM-for-A / PM-for-B 是同一 agent 的两个 session」;上下文由 session bundle 携带。决策 40/42/43。
- **N1(git vs wiki 归属)**:git 管项目 artifact(workspace 文档+代码);wiki 树非叶节点在数据库。决策 45。
- **N2(archivist wiki 维护范围)**:archivist 维护自己 project 子树结构;提取者 A 写全局 memory 节点;目标子树不相交。决策 46。
- **OQ6(所有 session 归档)**:含 dev/qa;跨项目记忆 → 全局 memory 节点。决策 47。
- **OQ7/OQ9(Orchestrate 角色与 DSL 作者)**:Orchestrate 是系统编排引擎;lead 是 DSL 作者 + 指定各节点 agent。决策 48。
- **Q-C(双 API 归档拆解)**:两个独立提取者(A 内容记忆 / B 工具遥测),参考 MiMo Writer。决策 44。

### ✅ v0.8 D-C 收敛(记忆与上下文恢复)
- **D-C(§2.18,定稿)**:**新 session 从记忆恢复 ≈ 续接**(内容等价,非逐字)。三机制:① 原始 turn 持久化在 session 存储 ② **预算分批提取**(按 token 预算触发,不按 turn)→ 全局 wiki memory 节点 ③ 关闭 flush(提取者 A)对尾批提取。明确不要活 checkpoint / transition 检测器 / 外部事件锚点(均耦合场景或冗余)。决策 52/53/54。对齐现有 L1/L2 阈值压缩,工作量是「迁到全局 wiki 树 + 补关闭 flush + 修 prune/compress 顺序 bug」,不引入新机制。

### 🟡 仍 open(留专项设计)
- **D-D 远期 —— zero-core 自管理**:遥测从独立存储迁移为「zero-core 自管理项目」wiki,工具/agent-tool 自回归优化。决策 49 立原则,v1 不实现。

其余(Orchestrate DSL 语法定义、wiki 节点关系边 schema、`{角色,project}→session` 路由实现、cron 调度切换、子 session 双提取者开关、path 落库等)均为纯实现期细节,按决议执行即可。

---

## 8. 下一步

本 RFC 定稿后,再起独立 milestone 计划(plan/实现),按数据模型与影响清单执行。v0.8 完成身份与上下文分离(角色全局化 + cron 一等公民 + session 上下文 bundle + 双提取者)+ 归属精确化(N1/N2);实现期需重点设计:

- **记忆与上下文恢复(§2.18,已定稿)**:**早期 + 增量式提取**(低利用率多 checkpoint 触发,反 lost-in-the-middle;每次只提取 delta 并合并进已有 memory 节点)+ 关闭 flush(尾批)+ 修 prune/compress 顺序 bug。现有 L1/L2 触发点偏高(70%/50%),需降为低点多 checkpoint。不引入新机制
- **`{角色, projectId} → session` 路由 + session 上下文 bundle**:discuss/通知/cron 统一入口
- **CronRecord 一等公民**:cron 表 + CronAnalysisManager 调度源切换 + scope 解析
- **Orchestrate DSL 引擎**(parallel/pipeline/if/for/barrier)+ `Orchestrate.confirm` 门状态机 + lead 撰写 DSL(指定各节点 agent)
- **全局 wiki 记忆树**(WikiNode + memory 节点;按 session 上下文的 wikiRootNodeId 截断查询)
- **archivist-service**(实际文档只读 + project wiki 子树结构读写;git 增量 → wiki 结构更新;意图↔结构分歧检测)
- **两个提取者**(A 内容记忆 / B 工具遥测)+ 独立遥测存储
- **验收覆盖判断视图**(Orchestrate 产出「改动+测试清单」,PM 判覆盖)

其余(wiki 节点关系边 schema、cron 调度切换、双提取者开关、path 落库等)均为纯实现期细节,按决议执行即可。
