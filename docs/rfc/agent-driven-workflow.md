# RFC: Agent 驱动的工作流 — 从配置涌现

> **Status**: Draft v0.5 — 讨论中
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

workflow 不是预设的角色脚本,而是 agent 配置形成的**有向图** + 一个归属实体:

- **节点** = agent(各有 projectId/全局、prompt、model、tools)
- **边** = 「A 能调用 B」(A 的 toolPolicy 放行了 B 暴露的工具名)
- **能力** = cron(哪些 agent 定时跑)、requirement 指派(哪个 agent 驱动某需求)
- **归属实体** = 轻量 `Project`(绑定 workspace、看板入口、并发单元、**通知枢纽**)

「角色」(lead/PM/archivist/analyzer/planner/dev/review/qa)不是类型字段,是**可选的 prompt 预设**。

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

### 2.7 archivist 侧:专职 wiki + 需求↔设计 traceability

archivist 是**项目绑定 agent**,自带 cron,管**知识侧 + main 分支 git**,**专职维护项目 wiki**:

- **逻辑 read-only,文档注释可写**(见 §2.16):**严禁改任何可执行逻辑**,但可写「文档性产物」—— 文件说明书 header、folder README、docs/basic、wiki。这让它能**反向维护**这些说明书:扫到某文件实质变了,顺手把 header/README 同步成现实,使 doctor 标准化门禁由 archivist 持续兜住,而非靠人记得补。
- 周期扫描代码库 → 更新 wiki 知识图谱(架构、模块、依赖、约定);文件说明书 header 是它建 wiki 的**廉价种子**(header 的 6 段 ≈ 文件级 wiki node schema,见 §2.16)
- **兼管 main 分支 git**:统一 commit PM 文档/自己 wiki/自己回写的 header·README·docs、verify 后合并 feature→main、清理 worktree(见 §2.15);feature 分支 git 归 lead
- **PM 和 lead 都读它**:PM 读 wiki 写好需求,lead 读 wiki 做好 plan
- 有自己的 chat 页面,**可与用户直接对话**(解释架构、澄清设计),但 PM 是默认入口,一般不直接打扰用户
- 详见 §2.13 archivist 的更新与意图理解机制、§2.16 文档说明书维护与分歧信号

### 2.8 planner 侧:按需拆解任务队列

planner 是**全局专业 agent**(无 projectId、无 cron),暴露为工具、在 lead 的 toolPolicy 中。lead 依据需求类型选不同 planner(后端功能/bugfix/重构/调研/…),planner 读需求 + 上下文产出 TaskStepRecord 队列(软件项目 = 编码→审核→测试循环)。可配多个 planner 覆盖不同领域。

### 2.9 通知与门

**通知只在跨 agent 边界(领域交接)发生;同一 agent 自己管线内的门是 session 级 pause/resume,不走通知。**

| 时刻 | 方向 | Project 通知 |
|------|------|------------|
| 进 `ready` | PM → lead | → lead(pickup) |
| 进 `verify` | lead → PM | → PM(验收) |
| verify accept → 合并 main | lead → archivist | → archivist(刷新 wiki) |
| plan 门 approve | lead 自己续跑 | 不通知(plan 在 lead 上下文) |

- **cron 兜底**:ready/verify 两个交接点若通知漏掉,lead/PM 的 cron 扫到就补上。
- **门 = 状态停顿**:requirement 停 `plan` 等 approve → `build`;自治 agent 不在 pending 空转。
- **审核方**:plan 门默认 = 用户;验收门默认 = PM(`reviewerAgentId` 默认 = `createdByAgentId`)。
- **驳回回路**:
  - plan 门驳回 → lead 拿反馈**自重 plan**(同 agent);仅当需求本身有问题才退 `discuss`、通知 PM 重谈。
  - verify 驳回(PM 拒)→ PM→lead 交接、通知 lead 修;根本性问题 → 退 `discuss`,PM 重新找用户谈。

### 2.10 discuss:文档为中心

discuss 不靠 session 隔离,**需求文档是持久 substrate**:

- **入口**:看板需求卡「讨论」→ **跳转到该 PM 的 chat 页面**(每 agent 有自己的 chat 页面)。
- **PM chat 页面** = 跟 PM 的持久对话 + 文档/目录面板(复用现有 chat 页面的文档+目录渲染),展示该 PM 管理的所有需求文档(`createdByAgentId` = 此 PM)。跨 session、跨日期都在这一处。
- **需求 = 文档 + 记录**:
  - **RequirementRecord**(DB,喂看板):名称、摘要、属性、status、指派字段 + `docPath`(指向 repo 内文档)。
  - **需求文档**(文件,markdown):完整内容 + 讨论沉淀。
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
  - PM cron:**只建新需求文档**,wiki/代码逻辑 read-only
  - PM discuss:**只改已有需求文档**(可能写 wiki)
  - archivist:**只写 wiki + 文档性产物(header/folder README/docs-basic)**,逻辑 read-only(§2.16)
  - → 写入者目标相交区只在「文档」(wiki/archivist 的 header·README·docs 与 PM 的需求文档不重叠),无逻辑冲突;偶发 wiki 重叠 last-write-wins + git 兜底

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

### 2.16 文档说明书维护与分歧信号(archivist 的反向闭环)

补文档债的实践暴露一个事实:**文件说明书 / folder README / docs/basic 是靠人纪律维护的脆性产物,开发一快就会漂移**(本 repo 就从「239/239 全绿」漂回残废)。archivist 既然在 incremental 扫 diff、又管 main 的 git,它正是**唯一能持续兜住文档完整性的角色**。这要求对它的「read-only」约束做一次精确收敛。

**约束收敛:逻辑 read-only,文档注释可写。**
- archivist 对 main 分支的写入范围**严格限定为文档性产物**:文件说明书 header(`// # 文件说明书` 注释块)、folder README(`zero-core_*_README.md`)、`docs/basic/*`、wiki。
- **严禁改任何可执行逻辑**:`.ts`/`.tsx`/`.cjs` 等文件只允许在文件头部注释区或文档区写入,绝不触碰 import、函数体、类型、配置值。写前用 AST/正则圈定「仅注释区」边界,越界即拒绝。
- 与 §2.15 一致:这些文档写入都走 archivist 的 main commit。

**为什么划算(header 是廉价的 wiki 种子):**
- 文件说明书的 6 段(核心功能/输入/输出/定位/依赖/维护规则)≈ 文件级 wiki node 该有的字段 —— **schema 天然同构**。
- archivist 建文件级 node 时可直接拿 header 做种子,**不必整文件 re-read**(降 build 成本)。
- header 是 wiki node 的**版本指纹**:增量扫到文件变了,先比 header 与 node 存的摘要,不一致才触发 re-read 重建。

**反向闭环:**
- archivist 扫到某文件实质变化 → 不仅更新 wiki node,还**顺手回写该文件的 header + 所在目录的 folder README** → doctor 的「标准化/工作区验证」门禁由 archivist 持续兜住,而非靠人补。
- 这把「补文档债」从一次性人工活(本次 105 文件那种)变成 archivist 的常态化职责,以后不再需要人做第二次。

**主动产出:docs/basic ↔ wiki 分歧信号。**
- `docs/basic` 是人维护的「系统应该是什么样」(意图基线,archivist 也维护),wiki 是从代码长出来的「系统现在是什么样」(现实)。两者 diff 是高价值信号:
  - **文档过时**(代码演进、docs/basic 没跟上)→ archivist 顺手更新 docs/basic 对应章节(它有写权限)。
  - **代码跑偏意图**(实现与设计文档不符)→ archivist **不擅自改逻辑**,而是 flag 给 PM/lead(经 Project 通知),由人决定是改代码还是修意图。
- 这个能力把 archivist 从「被动建 wiki」升级为「主动对齐意图与现实」,产出可追溯的分歧清单。

---

## 3. 能力与预设

| 预设 | 归属 | 典型能力组合 | 说明 |
|------|------|------------|------|
| lead | 项目绑定 | 持 cron,toolPolicy 放行 planner/dev/review/qa | 交付:pickup→plan→build→门 |
| PM | 项目绑定 | 持 cron,toolPolicy 放行 analyzer 及其他专项 agent tool | 产品:发现→需求文档→discuss;读 wiki |
| archivist | 项目绑定 | 持 cron,逻辑 read-only(文档注释可写,§2.16),toolPolicy 放行 analyzer(architecture lens) | 知识:wiki + 需求↔设计 traceability + 兜住文档说明书门禁 + docs/basic↔wiki 分歧信号 |
| analyzer | 全局 | 被调用 + 专项分析 prompt(UI/安全/性能/架构) | 按问题维度深度分析(可多个) |
| planner | 全局 | 被 lead 调用 + 规划 prompt | 按需求类型拆任务队列(可多个) |
| developer | 全局 | 被 lead 调用 + 写文件 prompt | 编码 |
| reviewer | 全局 | 被 lead 调用 + 审查 prompt | 代码审查 |
| qa | 全局 | 被 lead 调用 + 测试 prompt | 测试验证 |

预设只是起点,可任意组合。

---

## 4. 数据模型变化

### 4.1 AgentRecord(+projectId +cron +archivist 游标)

```typescript
interface AgentRecord {
  // ... existing(prompt、model、toolPolicy 等不变)...
  projectId?: string;        // 项目绑定 agent 指向 Project;缺省 = 全局
  cronSchedule?: "off" | "hourly" | "daily" | "weekly";
  cronPrompt?: string;       // 定时触发的提示词
  lastScannedRef?: string;   // archivist 专用:上次扫描到的 commit sha
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

### 4.3 RequirementRecord(改挂 projectId + 指派 + docPath)

```typescript
interface RequirementRecord {
  projectId: string;
  docPath: string;            // repo 内需求文档路径
  createdByAgentId?: string; // 创建该需求的 PM(discuss 对话方 + 验收回调默认值)
  assignedAgentId?: string;  // 拉取该需求的 lead
  reviewerAgentId?: string;  // 验证 agent(默认 = createdByAgentId)
  // ... 其余不变 ...
}
```

### 4.4 ProjectWikiNode(改挂 projectId + traceability)

`projectId` 指向 Project;新增 `requirementIds: string[]`(该节点关联的需求,archivist 维护)。

### 4.5 TaskStepRecord

跟随所属 RequirementRecord;建议记录 `touchedFiles`(供 archivist 拼 traceability)。

---

## 5. 对 M1-M5 现有代码的影响清单

> 只列影响面。下文 `analyst-service.ts` 等为现有 M1-M5 文件名,实现期可重命名。

### 数据层
- `src/shared/types.ts` — AgentRecord +`projectId`/`cron`/`lastScannedRef`;`ProjectRecord` 精简;RequirementRecord +`docPath`/指派;ProjectWikiNode +`requirementIds`
- `src/server/db-migration.ts` — agents 表加列(**同步 AGENT_COLUMNS**);projects 表精简;requirements/wiki 表 `projectId`+docPath/traceability
- `src/server/agent-store.ts` / `project-store.ts`(精简保留)/ `requirement-store.ts` / `project-wiki-store.ts` — 对应字段与查询

### 服务层
- `src/server/analyst-service.ts`(对应 PM)— 重构为被自身 cron 驱动(发现/建需求),删 `ensureAnalystAgent`
- `src/server/lead-service.ts` — `ensureLeadAgent` → 读 `assignedAgentId`;pickup/plan/build 逻辑保留
- **新增 `archivist-service.ts`** — git 增量扫描、wiki 维护、traceability 拼接、**文档说明书反向维护**(扫到文件实质变化时回写 header/folder README/docs-basic,仅注释区,逻辑 read-only 守卫)、**docs/basic↔wiki 分歧检测**
- `src/server/cron-analysis.ts` — 调度源切 agentStore(多个 cron agent)
- **新增 project 通知分发** — requirement 状态转移时按 §2.9 表向目标 agent 发通知(触发 session);cron 兜底

### 编排层
- `src/server/agent-service.ts` — **删 `createRoleLoopFactory`**;子 agent 走 `delegateTask` + toolPolicy
- `src/runtime/tools/orchestrate-tool.ts` — plan/execute 分离,不再造临时 role agent
- `src/runtime/tools/agent-tool.ts` + `delegateTask` — 扩展传目标 agent 全配置 + per-call 覆盖
- **session 归档钩子(新)** — 双 API call 后归档
- **agent/project 管理工具(新)** — 供 zero 调用
- **角色预设模板(新)** — lead/PM/archivist/analyzer/planner/dev/review/qa

### 前端
- `AgentEditor.tsx` — cron 区、projectId 归属、`lastScannedRef`(archivist)、「可调用 Agent」选择器
- `KanbanPage.tsx` — 按 Project 分组;需求卡显示摘要/属性 + 「讨论」跳 PM chat 页面
- **每 agent 的 chat 页面** — 复用现有文档+目录渲染,展示该 agent(尤其 PM)管理的需求文档
- `src/shared/ipc-api.ts` / `preload` / `ipc-proxy` — projects 精简 CRUD+绑定;保留 requirements/wiki

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
9. ✅ archivist 专职 wiki:**逻辑 read-only、文档注释可写**(header/folder README/docs-basic/wiki),维护知识图谱 + traceability;可直连用户但 PM 默认入口(修订 v0.4「代码 read-only」)

**通知与门**
10. ✅ 通知只在跨 agent 边界:ready(PM→lead)、verify(lead→PM);plan 门是 lead session 内 resume,不通知;cron 兜底
11. ✅ 门 = 状态停顿;驳回:plan 驳回 lead 自重 plan(必要时退 discuss 通知 PM);verify 驳回通知 lead 修(根本问题退 discuss)

**需求与文档**
12. ✅ 需求 = 文档(repo 内,跨设备)+ 记录(DB);RequirementRecord +`docPath`
13. ✅ discuss 文档为中心:PM chat 页面、需求文档入 repo、无 session 隔离(文档是 substrate)
14. ✅ 一个 project 一个 PM 入口;多样化产品需求靠其他 agent tool
15. ✅ ready→pickup 用 pull 模型(通知为主 + cron 兜底)

**子 agent 与 session**
16. ✅ 子 agent 上下文:项目绑定(PM/lead/archivist)用 project workspace;全局 tool-agent 继承 caller(可 per-call 覆盖);身份/toolPolicy/历史用目标 agent 自身
17. ✅ session 并行;cron/子 agent session 归档前双 API call(可配置)
18. ✅ 写隔离靠角色 scope(PM cron 只建新/wiki RO;discuss 改现有需求文档;archivist 管 wiki),无锁;git 兜底

**archivist 机制**
19. ✅ git 增量更新(`lastScannedRef` + log/diff)+ 周期全量 rescan
20. ✅ 意图从 artifact 聚合(代码结构 + commit/需求文档/ADR/注释);深度外包 analyzer
21. ✅ 需求↔设计 traceability:读需求文档 + 工作轨迹(task steps、commits 引用 reqId)+ 代码;约定 commit 引用 requirementId

**其他**
22. ✅ 角色降级为 prompt 预设,非运行时类型
23. ✅ 不改现有 agent,不写迁移脚本;M1-M5 数据破坏性重构(无真实数据)
24. ✅ zero 全局管理 agent(对话式搭建 workflow,工具层扩展)

**Git 分支**
25. ✅ feature 分支由 lead 管(进 build 时建 worktree、每步 commit 引用 reqId);PM verify accept 后 **archivist** 合并 main → closed → 清理 worktree
26. ✅ archivist 只索引 main(合并后刷新 wiki/traceability),feature 分支 WIP 不进 wiki
27. ✅ git 按分支划分:archivist 管 main(统一 commit PM 文档/wiki、合并、非 repo 自动 init);lead 管 feature(建 worktree、commit);PM/dev 不碰 git
28. ✅ 默认串行(lead 一次一个需求);多需求并行留以后

**archivist 文档维护(v0.5 新增)**
29. ✅ archivist「read-only」收敛为「逻辑 read-only、文档注释可写」:写入范围严格限定 header/folder README/docs-basic/wiki;严禁改可执行逻辑(仅文件头部注释区,AST/正则圈边界,越界拒绝);文档写入走 archivist 的 main commit
30. ✅ archivist 反向兜住 doctor 标准化门禁:扫到文件实质变化时回写 header/README;文件说明书 header = wiki node 廉价种子(6 段 schema 同构) + 版本指纹(不一致才 re-read)
31. ✅ docs/basic(意图基线)↔ wiki(现实)diff 作为主动产出:文档过时→archivist 顺手更新;代码跑偏→flag 给 PM/lead(经 Project 通知),不擅自改逻辑

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

### 仍 open
无实质 open 问题。上述全部收敛为决议,剩余(`path.resolve+realpath` 落库、子 session 双 API 开关等)均为纯实现期细节,按决议执行即可。

---

## 8. 下一步

本 RFC 定稿后,再起独立 milestone 计划(plan/实现),按数据模型与影响清单执行。v0.5 把 archivist 的文档维护职责收敛进 §2.16(决策 29-31),实现期需重点设计「仅注释区写入守卫」与「docs/basic↔wiki diff 检测器」两块;其余(`path.resolve+realpath` 落库、子 session 双 API 开关等)均为纯实现期细节,按决议执行即可。
