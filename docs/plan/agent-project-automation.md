# Agent Project Automation：跨 Effort 架构合同

> **状态**：设计已确认；2026-07-18 拆为四个独立 effort，均尚未实施。
> **实施入口**：
> [`project-flow-system`](project-flow-system/README.md)、
> [`agent-work-runtime`](agent-work-runtime/README.md)、
> [`project-management-ui`](project-management-ui/README.md)、
> [`agent-eval-harness`](agent-eval-harness/README.md)。
> 本文件是共同架构合同，不是第五个实施 effort。

## 0. 结论

本设计由七个相互配合、但职责独立的部分组成：

1. zero-core 随包提供两个内置 Skill：现有 `skill-creator` 和新增
   `agent-eval-harness`。
2. 每个注册 Project 在根目录下拥有由软件定位和管理的 `.zero-core/`。它整体排除出
   项目 Git，同时自身是一个轻量嵌套 Git 仓库，用来版本化 FlowDefinition、Flow 文档、
   WorkDefinition 和事件历史。
3. Flow 只验证和提交状态、依赖与组合关系的合法变更并发出标准事件；Work 在自己的
   配置中声明 trigger，决定何时、由哪个 Agent、在什么 workspace 中执行什么工作。
   Flow 不引用 Work。
4. FlowInstance 可以声明同 Project 或跨 Project 的有向依赖；目标 FlowDefinition 用
   稳定 milestone 暴露完成条件，来源 transition 可声明只有依赖满足后才能流转。
5. 同 Project 的 FlowInstance 可以按 FlowDefinition policy 拆分或合并；composition
   lineage 与 dependency 分离，保留 source 历史并以单个内层 Git commit 原子提交。
6. 同一个 Agent 在同一个 Project 上保持长期 Project Session，可以看到和讨论多个
   Flow item、Plan 和 WorkRun。每次用户消息或 Work 执行使用独立、不可变的
   TurnInvocationContext，临时决定本 turn 的 worktree、`flow://` 挂载和工具工作目录。
7. Agent 通过 `skill://` 使用 Skill，通过 `flow://` 使用软件映射的 Flow 文档。普通
   文件工具从项目根遍历时忽略 `.zero-core/`；当 workspace 本身是内部 linked worktree
   时，它作为正常源码根工作，不受父目录忽略规则影响。

实施所有权分为四块：Project Flow System 管控制仓库和 Flow 事实；Agent Work Runtime
管 WorkRun、Turn context、VFS 与 worktree；Project Management UI 管 Project 页面壳层、
Overview、Definition Studio、关系/进度可视化、Work/WorkRun presentation 和 importer；
Agent Eval Harness 只交付内置 Skill。每个 effort 独立验收和归档，最终再执行一次跨 effort
[Integration Acceptance](agent-project-automation-acceptance.md)。

Eval 的实现位于 Skill 自身，不进入 AgentLoop 或固定业务状态机。FlowDefinition、
WorkDefinition、文档挂载和 Eval 是否参与门禁都来自项目配置。归档分析通过一个以
`~/.zero-core/archives` 为 workspace 的 Agent 定时运行 Eval Work 完成，不需要核心增加
专用 Eval 服务或把归档复制进目标 Project。

```text
Project Session（长期）
├── Project 全局视野：Flow items / Work / WorkRuns / 历史讨论
└── Turn Invocation（一次执行）
    ├── workspaceRoot：主项目、linked worktree 或 Agent workspace
    ├── flow://project：项目 Flow 文档视图
    ├── flow://current：当前任务的短路径挂载
    └── workId / workRunId / 配置快照

Flow transition
    └── 标准 Transition Event
            └── Work 自己的 trigger 命中
                    └── WorkRun 排队并驱动 Agent turn
                            └── Agent 可通过 Flow 工具请求下一次 transition
```

## 1. 目标与非目标

### 1.1 目标

- 给 Agent 一套可直接运行、可自行维护的通用 Eval 设施。
- 支持 zero-core 和任意注册 Project，不在脚本中写死 zero-core 的目录或状态机。
- 让 Flow 由项目配置表达，不由 TypeScript union 或固定 action 分支表达。
- 让 Flow 只负责合法状态、依赖与组合关系，让 Work 负责订阅事件和触发 Agent 执行。
- 让 FlowInstance 之间可以建立可审计依赖，并在配置指定的 transition 上阻止未满足
  前置条件的流转。
- 让 FlowInstance 能按项目 policy 原子 split/merge，并以独立 lineage 保留来源和汇合
  关系。
- 让同一个 Agent 在一个长期 Project Session 中理解多个任务，同时保证每次执行使用
  正确的 workspace、Flow 文档和工具上下文。
- 让软件掌握 Flow 文档的定位、修订、流转和写入范围。
- 把源码工作区与过程文档控制面分开，避免过程文件污染项目 Git 历史。
- 用 `.zero-core` 内层 Git 提供本地历史、diff、回滚以及对普通 `git clean -fdx` 的
  轻量保护。
- 默认信任被分配的 Agent，减少逐次审批和上下文切换摩擦。

### 1.2 非目标

- 不在 zero-core 核心实现固定 Eval runner、grader 或场景格式。
- 不要求所有 Project 使用同一套 Found → Discuss → Ready → Plan → Build → Verify
  状态机。
- 不把旧 Requirement 系统作为新 Flow Engine 的底层或长期兼容投影。
- 不默认把 Eval 结果接成 CI 或 Flow 阻断门禁。
- 不自动把 `agent-eval-harness` 注册成 Project；注册是软件运行后的显式操作。
- 首版不做跨 Project split/merge 分布式事务；跨 Project 工作用 dependency 协调。
- 不因注册 Project 而初始化或改写目标项目的外层 Git 仓库；`.zero-core` 的内层 Git
  是独立的软件控制面。
- Eval 发现目标项目代码问题时，不自动修改目标代码；修复必须进入该 Project 自己的
  Flow。
- `flow://` 权限不是针对恶意 Shell 进程的 OS 沙盒；强进程隔离不在本设计范围。
- 内层 Git 不是远程灾备，不能承诺抵御 `git clean -ffdx`、磁盘损坏或手工递归删除。

## 2. 已核实的当前事实

设计以源码和最小实验为准，不把旧文档当作现状：

- [`project-store.ts`](../../src/server/project-store.ts) 只对 `workspaceDir` 做
  `resolve + realpath` 归一、唯一约束和创建后不可变约束，没有要求 Project 位于某个
  固定父目录。Project 可以注册到任意本机目录。
- [`builtin-skills.ts`](../../src/server/builtin-skills.ts) 当前只列出
  `skill-creator`。内置 Skill 在启动时仅当目标 `SKILL.md` 不存在才 seed 到
  `~/.zero-core/skills/<id>/`，已有的 Agent/用户修改不会被升级覆盖。
- [`copy-bundled-skills.cjs`](../../scripts/copy-bundled-skills.cjs) 已递归复制 Skill
  目录，因此 Skill 可以随包携带脚本、profiles、scenarios 和测试。
- [`skill-paths.ts`](../../src/tools/skill-paths.ts) 已证明基础文件工具可以通过当前
  `[skills]/` 虚拟前缀访问真实文件并回映射结果。目标协议把它迁为 `skill://`，并让
  `skill://` 与 `flow://` 复用通用 VFS 接线。
- 当前 [`flow-tool.ts`](../../src/tools/flow-tool.ts)、
  [`flow-actions.ts`](../../src/server/flow-actions.ts) 和
  [`requirement-state-machine.ts`](../../src/server/requirement-state-machine.ts) 把
  Requirement 状态、action、文档段和副作用写死在代码里；renderer 的 Kanban 列也依赖
  固定 `RequirementStatus`。这些属于旧 Requirement 系统，不是新 Flow Engine 的实现
  基础。
- 当前 Project Work 已包含 prompt、Agent、required tools、context policy 和 hooks，
  但没有持久化 WorkRun。Session busy 时
  [`sendProjectPrompt`](../../src/server/agent-service.ts) 返回 `skipped: "busy"`，
  ProjectWorkRunner 不会可靠排队。
- 当前 [`session-context-router.ts`](../../src/server/session-context-router.ts) 按
  `agentId + projectId` 复用 Project Session，这符合长期项目上下文目标；问题在于
  workspace、workId 和工具上下文仍主要固化在 SessionConfig / AgentLoop，而不是随每次
  turn 注入。
- 当前归档由 [`archive-service.ts`](../../src/server/archive-service.ts) 写为普通
  JSON：`~/.zero-core/archives/<agentId>/<sessionId>.json`，内容包括完整
  `SessionRecord`、steps、summaries 等，可直接作为 Eval Agent 的文件输入。
- 当前 [`archivist-git.ts`](../../src/server/archivist-git.ts) 把新 worktree 放在
  `~/.zero-core/projects/...`，旧路径则在 `<workspace>.worktrees/...`；两者都不是本
  设计确定的项目级控制目录。
- 2026-07-17 使用临时 Git 仓库验证：
  - 主 checkout 可以把 linked worktree 建到
    `<project>/.zero-core/worktrees/<id>`；
  - `.zero-core` 自身初始化为 Git 仓库并忽略 `worktrees/` 后，外层
    `git clean -fdx` 保留该嵌套仓库；
  - 外层 `git clean -ffdx` 会删除整个 `.zero-core/`；
  - 以上实验没有修改本仓库。

## 3. 核心原则

1. **Flow 管流程事实，Work 才触发。** Flow 只验证状态、依赖与组合关系，不知道哪个
   Work、Agent、prompt 或 worktree 会响应一次事件。
2. **配置描述业务，核心执行通用原语。** 核心不认识 `ready`、`verify` 或 Eval 等
   业务词。
3. **长期知识与当前执行分离。** Project Session 保存项目记忆；Turn Invocation 决定
   当前 cwd、挂载和执行身份。
4. **文档和定义项目化。** 每个 Project 默认拥有稳定、可版本化的
   FlowDefinition / WorkDefinition。
5. **源码与过程分离。** 外层 Git 管项目成果；`.zero-core` 的内层 Git 管 Flow 控制面
   和过程历史。
6. **授权即执行，不逐次确认。** Work 已分配给 Agent 后，其声明的输出默认可写。
7. **失败不偷偷降级。** 要求 worktree 的 Work 创建失败时，不回退到主 checkout。
8. **软件提供地址。** Agent 不搜索 Skill 或 Flow 文档的物理路径，只使用 checkout、
   `skill://` 和 `flow://`。
9. **Requirement 是旧系统。** 新 Flow 独立实现；旧数据以后显式导入，不维持双向同步。
10. **依赖与组合分离。** dependency 控制流转 gate；composition 记录 split/merge
    lineage，不把一种关系的副作用偷渡给另一种。

## 4. Project 控制目录与内层 Git

### 4.1 唯一定位规则

```text
projectRoot       = Project.workspaceDir
projectControlDir = <projectRoot>/.zero-core
```

`projectControlDir` 永远从已注册 Project 的 `workspaceDir` 计算，不能从当前进程 cwd、
Session cwd 或 linked worktree 路径反推。linked worktree 是该 Project 的执行位置，不是
另一个 Project，因此不会在其内部递归创建新的控制根。

### 4.2 目标布局

```text
<projectRoot>/.zero-core/
├── .git/                         # 软件维护的轻量内层 Git
├── .gitignore                    # 忽略 worktrees/runs/cache/tmp
├── manifest.json                 # owner、projectId、formatVersion
├── flow/
│   ├── definitions/
│   │   └── <definition-id>/
│   │       └── <version>.yaml
│   ├── active.json                 # definitionId→version/digest bindings + optional default
│   ├── drafts/                     # 显式保存的非运行态 Definition draft
│   ├── views/                      # 独立 FlowView revision 与 active binding
│   ├── instances/
│   │   └── <flow-instance-id>/
│   │       ├── state.json
│   │       ├── dependencies.json
│   │       ├── relations.json      # 非阻塞 related relation
│   │       ├── documents/
│   │       └── artifacts/
│   ├── compositions/
│   │   └── <operation-id>.json  # append-only split/merge manifest
│   └── events/                   # append-only transition event
├── work/
│   ├── definitions/
│   │   └── <work-id>/
│   │       └── <version>.yaml
│   └── active.json                 # Work 当前启用版本
├── runs/                         # 运行导出、日志和可恢复附件；内层 Git 忽略
├── cache/                        # 可重建索引；内层 Git 忽略
├── tmp/                          # 原子写、事务和工具临时文件；内层 Git 忽略
└── worktrees/
    └── <worktree-id>/            # 外层项目的 Git linked worktree；内层 Git 忽略
```

一级目录是稳定的软件定位点；Flow 文档有哪些、叫什么、怎样映射给 Work，仍由
FlowDefinition / WorkDefinition 决定。核心不得硬编码 `intent.md`、`plan.md` 等业务
文件名。

### 4.3 初始化与所有权

- 注册 Project 后，软件从注册根创建或校验 `.zero-core/`，不要求 Agent 查找目录。
- 新建控制目录时写入 `manifest.json`，至少包含 `owner: "zero-core"`、`projectId`、
  `formatVersion` 和 `createdAt`。
- 已存在的空目录可以初始化；已存在且非空、没有合法 manifest 的 `.zero-core/` 不得
  静默接管。
- Project 根不存在、不可写或 manifest 指向其他 Project 时，注册/启用控制面失败，不
  创建半套目录。
- 删除 Project 注册只删除 zero-core 中的注册关系，不递归删除 `.zero-core/`；清理是
  独立、显式操作。

### 4.4 外层 Git 与内层 Git

- 对 Git Project，软件幂等地把精确规则 `/.zero-core/` 写入外层仓库本地 exclude，
  不修改项目 `.gitignore`。Git dir 必须通过 Git 命令解析，不能假定
  `<project>/.git` 一定是目录。
- `.zero-core` 自身执行 `git init`，只版本化 manifest、FlowDefinition、
  FlowInstance 状态/文档/dependency/composition/event 和 WorkDefinition。
- 内层 `.gitignore` 至少忽略：

```gitignore
worktrees/
runs/
cache/
tmp/
```

- Flow transition、Flow 文档 Write/Edit 和配置变更都以一次逻辑写操作为单位，在
  per-project lock 内立即生成内层 Git commit。不得把多个 Agent 的未提交修改留在共享
  内层 working tree 等到 turn 结束再聚合。
- 同一次 Flow transaction 涉及的 state/event/文档元数据可以合并为一个 commit。
- commit metadata 记录相关 `flowInstanceId`、`transitionId`、`workRunId` 和 actor。
- 无变化不创建空 commit；提交失败必须保留可恢复事务并报告，不能假装快照成功。
- 普通外层 `git clean -fdx` 会把 `.zero-core` 当作嵌套仓库保留；
  `git clean -ffdx` 仍会删除它。内层 Git 是本机轻量恢复，不是安全或远程备份。
- 非 Git Project 也可以使用 `.zero-core` 内层 Git 和不需要 linked worktree 的 Work。
- 如果未来需要跨机器或更强灾备，可显式导出、推送内层仓库或创建 `git bundle`；首个
  版本不自动配置远端。

## 5. Project 级 Flow 模型

### 5.1 FlowDefinition 的归属与稳定性

FlowDefinition 默认归一个 Project 所有：

```text
ProjectFlowCatalog
├── defaultDefinitionId?
├── activeBindings
│   ├── delivery            → version + digest
│   ├── implementation-task → version + digest
│   └── incident            → version + digest
└── 每个 definition 的不可变历史版本
```

项目注册或启用 Flow 时可以从内置/用户模板复制一份，但复制后由该 Project 自主管理，
不与模板保持实时链接。一个 Project 可以同时使用多个 Definition 表达 delivery、
implementation task、incident 或其他流程。每个 definition 自身一般稳定；只有状态、
transition、milestone、gate 或 actor 语义改变时才增加版本。

- 新 FlowInstance 显式指定 definitionId；省略时才使用 `defaultDefinitionId`。
- active version 按 definitionId 独立绑定；切换一个 binding 不影响其他 Definition。
- 已存在 FlowInstance 固定引用创建时的 definition version + digest。
- 每个语义版本保存为独立、不可变的 `<definition-id>/<version>.yaml`；`active.json`
  保存 binding map 和可选 default，运行时不需要临时 checkout 内层 Git 历史。
- 修改某个 active binding 不改变在途 FlowInstance 的解释。
- 如需让在途实例升级，必须运行显式 migration 并记录前后版本。

### 5.2 FlowDefinition

FlowDefinition 是配置，不是 TypeScript union：

```yaml
id: project-delivery
version: 1
initialState: found

states:
  - found
  - discuss
  - ready
  - plan
  - build
  - verify
  - closed
  - { id: merged, terminal: true }
  - { id: abandoned, terminal: true }

documents:
  requirement:  { mediaType: text/markdown }
  discussion:   { mediaType: text/markdown }
  plan:         { mediaType: text/markdown }
  verification: { mediaType: text/markdown }

milestones:
  plan-accepted:
    when: { type: transition-reached, transition: begin-build }
  final-accepted:
    when: { type: transition-reached, transition: final-accept }
  merged:
    when: { type: state-in, states: [merged] }

compositionPolicies:
  split-implementation:
    operation: split
    actors: [user, agent]
    sourceMilestones: [plan-accepted]
    documentInputs: [plan]
    targets:
      definitionIds: [implementation-task]
      min: 1
      max: 8
    parentDependencies:
      milestones: [completed]

  combine-results:
    operation: merge
    actors: [user, agent]
    sources:
      definitionIds: [implementation-task]
      milestones: [completed]
      min: 2
      max: 8
    documentInputs:
      - { from: sources, document: result }
    target:
      definitionIds: [project-delivery]
      allowCreate: true
      allowExisting: true

transitions:
  - id: begin-discussion
    from: found
    to: discuss

  - id: accept
    from: discuss
    to: ready
    actors: [user]

  - id: return-to-discuss
    from: ready
    to: discuss
    actors: [agent, user]
    input:
      required: [reason]
      properties:
        reason: { type: string, minLength: 1, maxLength: 4000 }

  - id: plan-complete
    from: ready
    to: plan
    actors: [agent]

  - id: begin-build
    from: plan
    to: build
    actors: [user, agent]
    gates:
      dependencies: all-satisfied

  - id: return-to-plan
    from: build
    to: plan
    actors: [agent, user]
    input:
      required: [reason]
      properties:
        reason: { type: string, minLength: 1, maxLength: 4000 }

  - id: begin-verify
    from: build
    to: verify
    actors: [agent]

  - id: return-to-build
    from: verify
    to: build
    actors: [agent, user]
    input:
      required: [reason]
      properties:
        reason: { type: string, minLength: 1, maxLength: 4000 }

  - id: abandon
    from: [found, discuss, ready, plan, build, verify, closed]
    to: abandoned
    actors: [agent, user]
    input:
      required: [reason]
      properties:
        reason: { type: string, minLength: 1, maxLength: 4000 }

  - id: final-accept
    from: verify
    to: closed
    actors: [agent]

  - id: merge
    from: closed
    to: merged
    actors: [user, agent]
```

这些状态和 milestone 名只是默认模板示例，不是核心保留词。`actors` 是可选的简单声明；
未配置时，
拥有该 Project Flow 能力的用户或 Agent 可以请求 transition。复杂审批仍应通过文档、
Agent 判断和 Work 表达，不在核心写死 proposer/implementer/verifier 角色。

FlowDefinition 的 transition 构成**有向图而不是单向流水线**。图可以包含回边和循环；
只有 dependency graph 与 composition lineage 必须保持 DAG。核心不理解“前进”“打回”
或“返工”等固定业务含义，只校验当前 state 是否存在匹配的配置 transition。

state 可以使用字符串简写，也可以声明 `{ id, terminal: true }`。terminal state 是
FlowInstance 的最终结果，不能出现在任何 transition 的 `from` 中；definition validator
必须拒绝终态出边。transition 的 `from` 接受单个 state 或非空 state 列表；列表只是同一
transition id 的多条合法来源边，不是通配符。默认模板用这一能力让任意非终态阶段都能
进入 `abandoned`，并把 `merged` 与 `abandoned` 都显式标成终态。

transition 可以声明有限、纯数据的 `input` contract，约束必填字段、基础类型、长度和数量；
不能执行任意 JSON Schema extension 或代码。默认模板的返工 transition 要求非空
`reason`，该 input 随 transition event 和内层 Git history 持久化。Project 也可以定义
其他字段或不要求 reason。

这使接棒 Agent 能在进入下一阶段后先审核输入，再决定继续或打回：

```text
Discuss --accept----------> Ready  --return-to-discuss--> Discuss
Ready   --plan-complete---> Plan
Plan    --begin-build-----> Build  --return-to-plan------> Plan
Build   --begin-verify----> Verify --return-to-build-----> Build
Verify  --final-accept----> Closed
任意活动状态 --abandon----> Abandoned
```

每条正向或反向 transition 都走完全相同的原子提交、event/outbox 和恢复路径。反向
transition 不是修改或撤销旧 event，而是追加一个新的、可审计的事实。

### 5.3 FlowInstance

FlowInstance 是某个实际 issue/change 在 FlowDefinition 上的实例：

```text
flowInstanceId
projectId
flowDefinitionId
flowDefinitionVersion
flowDefinitionDigest
currentState
revision
createdBy
createdAt / updatedAt
```

它的权威状态位于
`.zero-core/flow/instances/<id>/state.json`，相关过程文档位于同一实例的
`documents/`，实例依赖位于 `dependencies.json`，transition 历史以 append-only event
保存并由内层 Git 版本化。

#### FlowInstance 废案

`abandoned` 是默认模板的 terminal state，但名称不是核心保留词；核心只读取 definition
中的 `terminal: true`。废案使用普通 `Flow.transition`，必须满足 actor、from、
expectedRevision 和 input contract：

```text
任意配置允许的活动 state
  → abandon transition（reason 必填）
  → abandoned terminal state
  → inner Git commit + flow.transitioned
```

废案保留 FlowInstance、文档、event 和 Git history，不物理删除，也不改写已经发生的
milestone。terminal state 没有出边；首版不提供 reopen、definition migration 绕过或
“取消废案”专用 action。若以后确有恢复需求，应作为独立设计处理，不能让新的 active
definition 追溯改变已经固定旧 definition version 的实例。

进入 terminal state 后，Work 子系统先取消该 FlowInstance 在该 terminal revision
之前创建的 queued/deferred WorkRun，并向 running WorkRun 请求 cooperative
cancellation；发起本次 terminal transition 的当前 WorkRun允许正常收尾。随后
`flow.transitioned` 仍正常投递，因 terminal event 新创建的通知/清理 WorkRun不被前述
历史清理误杀。

依赖该实例尚未达到的 live milestone 显示 `terminal-blocked`，并发出幂等 dependency
变化事件；已经发生的 `transition-reached` milestone 保持成立。废案本身不级联废弃
dependent FlowInstance。

### 5.4 Transition

Flow 核心只执行：

1. 读取 FlowInstance 和它固定的 FlowDefinition；
2. 校验 expected revision、from/to、transition id 和可选 actor；
3. 在 per-project lock 内原子更新 state、event 和必要文档元数据；
4. 创建内层 Git commit；
5. 更新 zero-core DB 中的查询索引/outbox；
6. 发出标准 `flow.transitioned` event 并记录 consumer delivery。

内层 commit 是 transition 的提交点。若进程在 commit 后、index/event publish 前中断，
启动和后台 reconcile 必须扫描已提交 event 文件、补索引并重新发布；WorkRun 的
`workId + workVersion + eventId` 幂等键吸收重复投递。commit 已成功时不能尝试回滚
权威 transition，也不能把它当成“完全失败”诱导调用者重复提交；API 应返回可识别的
`committed_pending_delivery` 状态，直到 reconcile 完成。

标准事件至少包含：

```text
eventId
projectId
flowInstanceId
flowDefinitionId / version
transitionId
from / to
actor
revision
createdAt
input metadata
```

Flow 不在 transition 中引用或直接调用 Work，也不创建 worktree。

`flow.transitioned` 不区分正向与反向投递：所有已提交 transition 都使用同一标准事件。
WorkDefinition 可以按 `transitionId`、`from`、`to` 和可选 input 条件匹配，因此被打回的
Flow 会像向前流转一样触发配置的返工/讨论 Work。event reconcile 重发仍由
`workId + workVersion + eventId` 去重。

返回不会自动撤销 latched `transition-reached` milestone。例如 Build→Plan 后，历史上的
`begin-build` 仍然发生过；若依赖需要随返工失效，应使用 `state-in` milestone，或在
FlowDefinition 中声明另一个 live milestone，而不能把 transition history 改写掉。

### 5.5 FlowInstance dependency

FlowInstance 之间可以建立同 Project 或跨 Project 的有向依赖：

```text
FlowDependency =
  dependencyId
  dependentProjectId + dependentFlowInstanceId
  prerequisiteProjectId + prerequisiteFlowInstanceId
  requiredMilestones[]
  expectedRevision
  createdBy / createdAt
```

依赖边的权威记录保存在 dependent FlowInstance 的 `dependencies.json` 并由其 Project
内层 Git 版本化；prerequisite Project 不被反向写入。Core DB 保存跨 Project 反向索引，
用于图查询和目标事件到 dependent 的重算，索引可从各 Project 控制面重建。

milestone 由 prerequisite 的 FlowDefinition 定义，而不是核心写死 `closed`、`merged`
等状态。首版提供两个通用判定原语：

- `transition-reached`：一旦指定 transition 的 event 已提交即持续满足；
- `state-in`：仅当 prerequisite 当前 state 位于配置集合时满足，离开后重新变为未满足。

来源 FlowDefinition 可以只在特定 transition 上声明
`gates.dependencies: all-satisfied`。因此依赖不会阻止 Found/Discuss/Plan 等前期工作，
只在项目配置选定的执行边界阻止流转。`all-satisfied` 在没有 dependency edge 时为真。
依赖满足本身不自动 transition；Flow 发出 `flow.dependencies.changed` /
`flow.dependencies.satisfied` 标准事件，是否触发 Work 仍由 WorkDefinition 决定。

`state-in` 是 live milestone：目标离开匹配 state 后，依赖变为未满足并发出
`flow.dependencies.regressed`。这不会自动回滚已经通过 gate 的 dependent FlowInstance；
它只影响后续 gated transition，并允许 Work/Agent 根据 regression event 决定暂停、
返工或保持现状。

图规则：

- self dependency 和任何直接/间接 cycle 都拒绝；
- add/remove 先取得全局 dependency-graph lock，再取得 dependent Project lock，使用
  dependent expected revision、actor 审计和内层 Git transaction；固定锁顺序避免死锁，
  并保证并发 `A→B` / `B→A` 只有一个能提交；
- 新增依赖时 prerequisite 必须是已注册、可读取的 FlowInstance，且可达图索引必须能
  reconcile 到当前 revisions；无法证明无环时返回 `DEPENDENCY_GRAPH_UNAVAILABLE`，
  不能乐观写入；
- prerequisite Project/instance/definition version 不可用时状态为 `unknown`，在 gated
  transition 上按未满足处理，但不阻止其他 Project 和应用启动；
- prerequisite FlowInstance 做 definition migration 时，必须校验所有 inbound dependency
  引用的 milestone 在目标版本仍存在；缺失时拒绝 migration，除非同一审计事务显式
  remap 这些 dependency；
- 删除 Project 注册不级联删除其他 Project 的 dependency edge；
- 已越过 dependency-gated transition 的 instance，不能普通添加会追溯性破坏该 gate
  的未满足依赖；必须先按其 FlowDefinition 回到允许状态，或使用显式、审计的管理迁移；
- prerequisite transition 后由反向索引重算 dependent 并幂等发事件；漏发使用与
  transition event 相同的 reconcile/outbox 机制。

这组 effort 当前先等待 `wiki-system-redesign` 的顺序只是外部工作安排，并不存在于
zero-core 的 dependency graph 中。Project Flow System Plan 00 只在实施开始时核对该
事实，不是 Flow 门禁，
也不创建控制状态。引擎落地后，用户或 Agent 可以在软件运行时显式创建未来任务的
FlowDependency；系统不会自动把计划文字导入为依赖。

### 5.6 FlowInstance split、merge 与 lineage

split/merge 是 FlowInstance 的组合原语，和 dependency graph 分开：

- dependency 表达“某次 transition 是否可以继续”；
- composition 表达“实例从哪里拆出、由哪些实例汇合而来”；
- split/merge 可以按 policy 同时创建 dependency edge，但组合关系本身不参与
  transition gate 判定。

首版只允许同一 Project 内的组合操作。跨 Project 协作使用 FlowDependency；不在首版
引入跨多个 `.zero-core` 内层仓库的分布式事务。

Project 的不可变 FlowDefinition version 用命名 `compositionPolicies` 声明允许的操作，
而不是核心写死状态。split 默认使用 source 实例固定的 definition version；merge 请求
必须显式提供 policy definition id/version/digest，不能在执行时读取可能已切换的 active
definition。policy 至少声明：

- operation、actors 和允许的 source milestone；
- 哪些 source document revision 作为目标 Work 的只读输入；
- split 可创建的目标 definition、数量上下限，以及可选 parent dependency template；
- merge 的 source definition/milestone、数量上下限；
- merge 可创建新 target，也可显式汇入已有 target；已有 target 必须提供
  expected revision，且 policy 必须允许；
- 未被 policy 允许的组合一律拒绝；
- 每个新 child/target 允许的 definition id。

operation 请求固定每个新 child/target 的 definition id/version/digest；active
definition 在 operation 期间切换不改变创建结果或幂等重试。

每次成功操作创建不可变的 composition manifest：

```text
FlowComposition =
  operationId + idempotencyKey
  operation: split | merge
  projectId + policyDefinitionRef + policyId + policySnapshotDigest
  sources[]: flowInstanceId + expectedRevision + resultingRevision
  targets[]: flowInstanceId + created | existing + expectedRevision? + resultingRevision
  documentInputs[]: source document + content revision / inner Git commit
  dependencyEdgesCreated[]
  createdBy / createdAt
```

split 以一个 source 创建多个 child；merge 以多个 source 创建一个新 target，或显式汇入
一个已有 target。两种操作都遵守：

- source 实例及既有 transition 历史保留，不删除、不改写，也不隐式改变
  source/parent currentState；参与实例的 revision 会因新增 composition 事实而推进；
- target/child 拥有自己的状态、文档和后续历史；
- source 文档只以固定 revision 的只读输入暴露，不自动复制、拼接或覆盖 target 文档；
  需要综合内容时由配置触发的 Work/Agent 读取输入并写入目标文档；
- operation idempotency key 必填；同 key 同参数重试返回同一结果，不同参数冲突；
- 所有参与实例都使用 expected revision；同一 source/target 的并发 composition 最多一个
  以旧 revision 提交，其他调用重新读取后再决定；
- lineage 是独立的有向无环图，拒绝 self edge 和任何直接/间接 cycle；
- composition 与 policy 校验、全部 instance 文件、manifest、可选 dependency edge 在
  per-project lock 内连同 operation event 以一个内层 Git commit 原子提交；
- 任一 expected revision、milestone、definition、actor 或文档 revision 不符合时，
  整个操作失败，不留下部分 child、target、edge 或 event；
- commit 后发出 `flow.instance.split` 或 `flow.instance.merged` 标准事件，DB 保存可
  重建的正反向 lineage 索引；Flow 核心不因事件自动 dispatch Agent 或 transition。

source 是否随后进入 `superseded`、parent 是否等待 children、merge 后是否继续流转，都由
项目自己的 FlowDefinition、dependency template 与监听事件的 WorkDefinition 决定，
不是 split/merge 的固定副作用。

监听 composition event 的 Work 可以从 manifest 选择已固定 revision 的
`documentInputs`，把它们映射为 `flow://current` 下的只读 mount，再把 child/target 文档
映射为独立输出。固定输入由 VFS 从内层 Git commit/blob 读取，不回退到控制目录当前
working tree；Agent 不需要搜索物理控制目录。

### 5.7 Related relation

FlowInstance 还可以建立非阻塞 `related` 关系，用于表示同一主题、参考实现、重复发现或
其他上下文联系。related 与 dependency/composition 分库存储、分类型查询：

```text
FlowRelation =
  relationId
  kind: related
  sourceProjectId + sourceFlowInstanceId
  targetProjectId + targetFlowInstanceId
  label?
  createdBy / createdAt
```

related 不参与 milestone、gate、cycle 检查或进度判断，也不自动触发 Work；Project 可以
通过监听显式 relation event 的 WorkDefinition 选择响应。跨 Project related 服从目标
可见性，未授权调用者不能借关系枚举目标标题、Definition 或文档。

### 5.8 FlowView 与进度 projection

FlowDefinition 只保存执行语义。状态 label/color/group/order、画布布局和进度显示保存在
独立 FlowView 中，不进入 FlowInstance 的 semantic digest：

```text
FlowView =
  viewId + flowDefinitionId + revision
  statePresentation
  graphLayoutHints
  progressProjection?
```

激活新 FlowView 可以立即改变既有实例的展示，但不能改变 allowed transition、milestone、
gate、event 或 Work trigger。没有 FlowView 时，前端使用通用稳定布局。

因为 transition graph 可包含回边和循环，系统默认不计算通用百分比。前端从 current
state、allowed transitions、milestone、dependency blocker、WorkRun、composition child
summary 和 last activity 派生进度摘要。只有 FlowView 显式配置 ordered stage 或
milestone weight 时才显示 percentage，并必须标注为 presentation projection；该值不写回
FlowInstance、不参与 gate，也不成为 API 的权威事实。

## 6. WorkDefinition 与 WorkRun

### 6.1 WorkDefinition

Work 自己声明 trigger 和执行方式：

```yaml
id: create-plan

trigger:
  event: flow.transitioned
  where:
    flowDefinition: project-delivery
    transition: accept

run:
  agentId: planner
  prompt: |
    阅读讨论结论并编写实施计划。
    完成判断后，通过 Flow 工具请求下一次合适的 transition。
  requiredTools: [Read, Write, Edit, Flow, Work]

workspace:
  kind: project

flowMounts:
  - document: requirement
    at: flow://current/requirement.md
    access: read
  - document: discussion
    at: flow://current/discussion.md
    access: read
  - document: plan
    at: flow://current/plan.md
    access: read-write

retry:
  maxAttempts: 2
```

Work trigger 首个版本至少支持：

- 标准 Flow event + 条件；
- 手动触发；
- Cron / schedule。

`workspace.kind` 首个版本支持 `project`、`worktree` 和 `agent`。`agent` 使用
AgentContext.defaultWorkspace，适合归档扫描等不以目标 Project 源码为工作目录的任务。
WorkDefinition 的语义版本同样保存为不可变文件；更新只切换未来 WorkRun 使用的 active
version，已经创建的 WorkRun 固定自己的配置 snapshot + digest。

依赖方向固定为：

```text
Flow emits event → Work trigger matches event
```

FlowDefinition 不保存 Work id。Work 可以在 Agent 执行过程中通过通用 Flow 工具请求
transition；WorkRun 成功本身不会自动推动 Flow。

典型项目可以用纯配置组成双向交接：

| Flow event | 触发的 Work | 接棒 Agent 可做的 transition |
|---|---|---|
| `accept`（Discuss→Ready） | 创建/审核 Plan | `plan-complete` 或 `return-to-discuss` |
| `return-to-discuss` | 补充讨论 | 再次 `accept` |
| `begin-build`（Plan→Build） | 实施/审核计划可执行性 | `begin-verify` 或 `return-to-plan` |
| `return-to-plan` | 修订 Plan | 再次 `begin-build` |
| `begin-verify`（Build→Verify） | 验收实现 | `final-accept` 或 `return-to-build` |
| `return-to-build` | 修复实现 | 再次 `begin-verify` |

表格只是默认模板示例。Work 是否存在、由哪个 Agent 执行、匹配正向还是反向 event，全部
由 Project 的 WorkDefinition 决定。一次返工产生新的 event 和 WorkRun；它不是原
WorkRun 的 retry。Agent 必须显式请求 transition，WorkRun succeeded 不会自动前进或打回。

### 6.2 WorkRun

WorkRun 是某个 WorkDefinition 被触发后由软件自动创建的轻量执行记录，不是第二套 Flow：

```text
queued → running → succeeded
   ↕         ├──→ failed
deferred ←───┤
             └──→ cancelled
```

Agent 使用 Wait 时 WorkRun 仍属于 `running`，UI 可以额外显示 `waiting` 运行态，但它
不是业务状态。

WorkRun 至少保存：

```text
id
projectId
workId
triggerEventId
originFlowInstanceId? / originFlowRevision?
agentId
sessionId
turnId
status
revision
attempt
priority / queueOrder
notBefore / deferReason / deferCount
workDefinitionSnapshot + digest
turnInvocationContext
createdAt / startedAt / finishedAt
result outcome / summary / error
```

规则：

- 同一 `triggerEventId + workId` 只创建一个 WorkRun，保证事件重放幂等。
- 手动触发每次创建新的 WorkRun。
- WorkDefinition 修改只影响未来 WorkRun；已创建 run 使用自己的配置快照。
- 同一 Project Session busy 时，WorkRun 保持 `queued`，不能像当前实现一样直接 skip。
- FIFO + WorkDefinition priority 是默认建议顺序，不是不可改变的业务门禁。拥有 `Work`
  工具的 Project Agent 可以审计地 defer、prioritize 或 switch 自己 Project Session 中的
  eligible WorkRun。
- `defer` 把 queued/running run 转为 deferred，保存 reason 和可选 notBefore；到期或
  Agent 显式恢复后重新 eligible。
- `switch` 使用 CAS 原子 defer 当前 running run、预约目标 queued/deferred run，并请求
  SessionRuntimeSupervisor 在安全 Turn 边界 handoff；不能在当前 Loop 中热改 cwd/mount。
- Agent turn 正常结束时 WorkRun 为 `succeeded`；运行异常为 `failed`。
- Agent 审核后通过 Flow 工具打回或废案，仍可使本次审核 WorkRun `succeeded`，并在
  result 中记录 `outcome: returned|abandoned`；业务未前进不等于执行失败。
- `succeeded` 只表示本次 Agent 执行完成，不代表 Flow 必须迁移。
- 重启时，遗留 `running` 按 Work 的 retry policy 重新排队或转为 failed，并增加 attempt。
- WorkRun 的 terminal 状态仍由软件根据 Turn 结果维护；Agent不能任意把 run 标成
  succeeded/failed，也不能修改固定 snapshot。

### 6.3 工具级权限与控制面/运行面

zero-core 当前按**工具名**授予 Agent 能力，不按 action 分配权限。新系统保留这个模型，
不为了 Flow/Work 增加 action-level tool policy。三个工具边界固定为：

| 工具 | 默认持有者 | 目标职责 |
|---|---|---|
| `Project` | 管理 Agent | Project 注册，以及 FlowDefinition/WorkDefinition 配置 |
| `Flow` | Project Agent | FlowInstance 查询、transition、dependency、split/merge、lineage |
| `Work` | Project Agent | 当前 Project 的 WorkRun 查询、defer、priority、switch、cancel/retry |

`Project` 不为每个 definition 字段增加 action。它只增加小型通用配置原语：

```text
Project({ action: "config.validate", projectId, kind: "flow"|"work", definition })
Project({ action: "config.publish", projectId, kind: "flow"|"work", definition })
Project({ action: "config.activate", projectId, kind: "flow"|"work",
          definitionId, version, digest })
Project({ action: "config.list", projectId, kind: "flow"|"work" })
Project({ action: "config.get", projectId, kind: "flow"|"work",
          definitionId, version? })
Project({ action: "work.fire", projectId, workDefinitionId })
```

publish 创建不可变新版本，不原地 update；activate 只改变未来实例/run 的默认版本。
`work.fire` 是管理动作，只创建 durable WorkRun，不直接调用 AgentLoop。服务端按 `kind`
调用独立 Flow/Work validator 和 repository，Project 工具不吞并领域实现。

`Flow` 向普通 Project Agent开放，但不包含 FlowDefinition 配置 action。FlowInstance
操作仍由 CallerCtx project scope、definition actor、from/state、expectedRevision、
dependency gate 和 composition policy 校验；这属于领域授权，不是 action-level 工具权限。

通用 Flow 工具采用类似：

```text
Flow({ action: "list", projectId?, state? })
Flow({ action: "get", flowInstanceId })
Flow({ action: "create", definitionId?, input? })
Flow({ action: "transition", flowInstanceId, transitionId, expectedRevision, input? })
Flow({ action: "dependencies.list", flowInstanceId })
Flow({ action: "dependencies.add", flowInstanceId, prerequisite, milestones, expectedRevision })
Flow({ action: "dependencies.remove", flowInstanceId, dependencyId, expectedRevision })
Flow({ action: "split", flowInstanceId, policyId, children, expectedRevision, idempotencyKey })
Flow({ action: "merge", sourceFlowInstanceIds, policyDefinitionRef, policyId, target?, expectedRevisions, idempotencyKey })
Flow({ action: "lineage", flowInstanceId, direction? })
```

废案也是普通配置 transition，例如
`Flow({ action:"transition", transitionId:"abandon", input:{reason} })`。核心不包含
`ready`、`startBuild`、`reject` 或 `abandon` 等固定业务 action。

`Work` 在 cutover 后不再创建/修改 WorkDefinition，而成为 WorkRun 运行工具：

```text
Work({ action: "current" })
Work({ action: "list", status? })
Work({ action: "get", workRunId })
Work({ action: "defer", workRunId, reason, notBefore?, expectedRevision })
Work({ action: "prioritize", workRunId, priority?, beforeWorkRunId?, reason,
       expectedRevision })
Work({ action: "switch", fromWorkRunId, toWorkRunId, reason,
       expectedFromRevision, expectedToRevision })
Work({ action: "cancel", workRunId, reason, expectedRevision })
Work({ action: "retry", workRunId, reason, expectedRevision })
```

CallerCtx 注入 projectId、sessionId、agentId 和 currentWorkRunId；模型不能用参数扩大到其他
Project/Agent Session。`list/get` 只返回当前 Project 中调用者被允许观察的 run；
defer/prioritize/switch/cancel/retry 只作用于分配给当前 Agent Session 的 run，且
`switch` 两端必须属于同一 Project Session。持有 `Work` 的 Agent拥有整组运行 action，
因此该工具不包含 definition mutation 或 manual fire。没有 `Work` 工具的 Agent仍能被
dispatcher 执行，只是按默认 scheduler 顺序工作，不能自主调整 queue。

### 6.4 核心通用原语

核心只提供：

- 注册、读取和版本化 Project FlowDefinition / WorkDefinition；
- 创建、查询和迁移 FlowInstance；
- 建立、查询和验证 FlowInstance dependency graph；
- 按 FlowDefinition policy 原子 split/merge FlowInstance 并查询 lineage；
- 追加 transition event；
- 根据 event、manual、cron 匹配 Work trigger；
- 创建、排队、执行和恢复 WorkRun；
- 创建和回收 linked worktree；
- 建立 TurnInvocationContext 和 `flow://` mount table；
- 持久化审计、查询索引和恢复信息。

## 7. Context Management

### 7.1 要解决的边界

上下文必须区分四件事：

1. Agent 的长期身份和能力；
2. Project Session 长期属于哪个项目、记得哪些讨论；
3. 当前 turn 实际在什么 workspace、执行哪个 Work；
4. 本次工具调用能访问哪些物理/虚拟路径。

同一个 Agent 可以在一个 Project Session 中看到多个 issue、正在执行的 Plan 和 WorkRun；
执行上下文只限制当前 turn 的默认工作位置和映射，不抹掉 Agent 的项目知识。

Flow event 创建 WorkRun 只表示“项目产生了一项可执行工作”，不会把长期 Session 绑定到
该 FlowInstance，也不意味着它必须抢在所有其他事项之前执行。Session 可以知道
originFlowInstanceId/triggerEventId/currentWorkRunId，同时通过 `flow://project` 查看其他
Flow。Agent 若决定先做别的 eligible WorkRun，必须用 Work.defer/prioritize/switch 显式
改变队列并留下原因，不能让当前 run 保持 running 后静默漂移到其他任务。

```text
AgentContext
    └── ProjectSessionContext（长期、稳定）
            └── TurnInvocationContext（每次 turn、不可变）
                    └── ToolCallContext（从当前 invocation 派生）
```

### 7.2 AgentContext

AgentContext 来自 Agent 配置：

```text
agentId
systemPrompt
model / provider
toolPolicy
defaultWorkspace
skills
```

`defaultWorkspace` 仅在没有 ProjectContext，或 Work 显式声明使用 Agent workspace 时生效。
归档分析 Agent 就可以把 `~/.zero-core/archives` 作为 defaultWorkspace。

### 7.3 ProjectSessionContext

一个 `agentId + projectId` 默认对应一个长期 Project Session：

```ts
interface ProjectSessionContext {
  projectId: string;
  projectRoot: string;
  flowDefinitionRef: {
    id: string;
    version: number;
    digest: string;
  };
}
```

它用于长期项目记忆、Project/Flow/Work 全局视野和 UI 路由，不保存当前 `workId`、
`workRunId` 或临时 worktree。ProjectSessionContext 不能因某次 Work 执行而被热改成另一
个 workspace。

### 7.4 TurnInvocationContext

每条用户消息、Work、Cron 或子 Agent 调用在进入队列前解析成不可变 invocation：

```ts
interface TurnInvocationContext {
  invocationId: string;
  source: "user" | "work" | "cron" | "subagent";

  projectId?: string;
  projectRoot?: string;
  workspaceRoot: string;

  activeFlowInstanceId?: string;
  workId?: string;
  workRunId?: string;

  flowMounts: FlowMount[];
  workSnapshotDigest?: string;
}
```

解析优先级是：

```text
WorkRun snapshot / explicit invocation
    > ProjectSessionContext defaults
    > AgentContext.defaultWorkspace
    > zero-core global workspace
```

解析完成后，下游工具不再自行回退或重新猜 cwd。

| Invocation 来源 | projectRoot | workspaceRoot |
|---|---|---|
| 用户在 Project Session 中讨论 | Project 根 | Project 根 |
| Work，`workspace.kind: project` | Project 根 | Project 根 |
| Work，`workspace.kind: worktree` | Project 根 | 内部 linked worktree |
| 归档分析 Agent | 未注册时为空；注册后为归档 Project 根 | Agent 的归档 workspace |
| 子 Agent | 继承父 invocation | 默认继承，可显式缩小/覆盖 |

### 7.5 队列与生命周期

Session/Turn 状态、Stop、Wait、普通 inbox、atomic handoff 和跨 Turn task event 由
[`session-turn-lifecycle`](session-turn-lifecycle/design.md) 提供。本节只定义
invocation 中的 Project/Work context 以及 WorkRun dispatcher 如何消费该契约。

队列项必须保存完整 invocation envelope，而不只保存 prompt：

```text
prompt
source
TurnInvocationContext
WorkRun reference（如有）
enqueue time / priority
```

AgentLoop 的执行顺序：

1. 从 Session 队列取一个 invocation；
2. 安装为当前不可变执行上下文；
3. 按 invocation 重建本 turn 的 environment、Work 和 `flow://` 提示；
4. 执行 Agent turn；
5. 持久化 turn、tool audit 和 WorkRun 结果；
6. 在 `finally` 中清除当前 invocation；
7. 执行下一项。

用户消息在 Work 运行中到达时，也以自己的 invocation 排队。它不能继承当前 Work 的
worktree 或 mount。waiting/barrier 收到新的用户、Work 或 Cron invocation 时，使用统一
supervisor 原子 supersede 旧 Turn 并 handoff；running Turn 不被硬抢占。

同一个 Project Session 默认串行执行 turn。不同 Session 可以并行；需要并行实现时应
分配其他 Agent / subagent，而不是让同一个 AgentLoop 同时持有两套当前上下文。

### 7.6 ToolCallContext

工具从当前 invocation 派生上下文：

```ts
interface ToolCallContext {
  invocationId: string;
  agentId: string;
  sessionId: string;
  projectId?: string;
  projectRoot?: string;
  workingDir: string;
  flowMounts: FlowMount[];
  workRunId?: string;
}
```

Read/Write/Edit/Glob/Grep/Shell/Flow 和子 Agent 委派都必须读取同一份当前上下文。不能在
AgentLoop 创建时把 `workingDir` 永久闭包进工具，也不能依靠更新全局
`SessionContextBundle` 来切换 Work。

每个 turn 和 tool audit 保存 `invocationId`；恢复和 Eval 因而能知道某次工具调用属于
哪个 WorkRun、workspace 和 mount snapshot。

### 7.7 项目全局视野与当前任务

`flow://` 同时提供两层视图：

```text
flow://project/...    # Project 默认 Flow 视图，可查看多个 Flow item
flow://current/...    # 当前 Work / active Flow item 的稳定短路径
```

- ProjectSessionContext 提供 `flow://project` 基线 mount。
- WorkDefinition 为本次 invocation 增加 `flow://current` mount，或收窄具体写入范围。
- 同一虚拟路径不能由两个 mount 隐式覆盖；冲突在 WorkRun 创建时失败。
- Agent 可以通过 Flow 工具列出所有 Flow item / Work / WorkRun；当前 mount 不等于
  Agent 只能知道当前 issue。

### 7.8 子 Agent 继承

子 Agent 默认继承父 invocation 的：

- projectId / projectRoot；
- workspaceRoot；
- active FlowInstance；
- `flow://` mounts；
- parent invocationId / workRunId 审计链。

调用方可以显式缩小 mount 或指定子 workspace；不能在没有授权的情况下隐式扩大到其他
Project。每个子 Agent 使用自己的 Session/Loop 和不可变 invocation，不共享父 Loop 的
可变当前指针。

## 8. 文件工具与虚拟文档目录

### 8.1 普通文件工具忽略 `.zero-core`

普通文件工具采用与 `.gitignore` 相似的可见性规则：

- 当遍历根是 Project 根时，文件树、Glob、Grep 和上下文扫描忽略其直接子目录
  `.zero-core/`。
- 显式 Read/Write/Edit 外层 Project 的 `.zero-core/...` 时返回路径不可用；Write 不能
  静默成功。
- 当本次 `workspaceRoot` 已经是
  `<project>/.zero-core/worktrees/<id>` 时，该目录是正常源码根，内部文件不因父目录名
  含 `.zero-core` 而被忽略。
- 从 worktree 使用 `..` 或绝对路径访问父级 `.zero-core/flow` 仍不可用。
- `flow://` Provider 是软件控制面入口，直接访问物理 Flow 文件，不经过普通 workspace
  遍历规则。

这套规则的目标是避免 Agent 偶然读取软件控制目录和跨 Work 串写，不把它描述成对任意
Shell 的强安全边界。

### 8.2 `flow://` 绑定粒度

mount table 绑定到 TurnInvocationContext；Work turn 的 mount snapshot 同时持久化在
WorkRun 中：

```text
FlowAccessContext =
  invocationId + agentId + sessionId + projectId
  + optional flowInstanceId + optional workId/workRunId
  + mount table
```

这允许用户 turn 和 Work turn 使用不同视图，也避免永久按 agentId 授权。

### 8.3 路径解析

`flow://` 是 zero-core 自定义虚拟前缀，不按网络 URL 解析。解析器执行：

1. 读取当前 invocation 的 mount table；
2. 最长前缀匹配一个逻辑 mount；
3. 校验操作类型与 access；
4. 解析到 Project 控制目录中的真实文件；
5. 校验 normalize/realpath 后仍在该 mount 的物理根内；
6. 工具结果中的真实路径回映射成 `flow://`。

禁止 `..`、绝对路径注入、驱动器切换和符号链接逃逸。未映射路径表现为不存在，不能从
错误信息枚举其他 Project 的 Flow 文档。

### 8.4 `skill://` 命名统一

Agent 可见的稳定虚拟目录统一使用：

```text
skill://<skill-id>/<relative-path>
flow://<relative-path>
```

`skill://` 取代当前 `[skills]/`：

- system prompt、Skill 列表、`${SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 替换、工具输出和
  错误提示只产生 `skill://`；
- Read/Write/Edit/Glob/Grep/Shell 只识别 `skill://`，删除旧 `[skills]/` 解析；
- bundled Skill 和 zero-core 自有文档全部迁为 `skill://`；
- 已安装的内置 `skill-creator` 使用版本化、可回滚的精确迁移，不覆盖其他用户修改；
- 外部 Skill 不自动改写，scanner/validator 报告残留的旧虚拟前缀；
- `[skills]/` 切换后是非法路径，测试必须断言它被拒绝。

`skill://` 和 `flow://` 共享 VFS provider 接线、路径沙箱与结果回映射框架，但权限来源
不同：Skill 来自启用与作者权限；Flow 来自当前 invocation 的 mount table。

### 8.5 文件工具支持

| 工具 | 行为 |
|---|---|
| Read | 读取具有 `read` 能力的虚拟文件 |
| Write | `read-write` 覆盖或 `create` 新建 |
| Edit | 只允许 `read-write` |
| Glob | 只枚举当前 invocation 已挂载的虚拟子树 |
| Grep | 只检索当前 invocation 已挂载的虚拟子树 |

写入使用临时文件 + atomic replace，并在同一 per-project lock 中立即创建内层 Git
commit。commit 成功才返回 Write/Edit 成功；失败则恢复原文件或留下可恢复 transaction。
每次成功写入更新内容 revision 和审计信息；同一 Project 的多个 Agent 并发编辑使用
expected revision 乐观检查，冲突时让 Agent 重新 Read，不增加逐次用户审批。

文档流转不需要物理复制：下一项 Work 用新的 mount 把上一阶段输出映射成只读输入，把
新文档映射成可写输出。需要冻结时绑定到明确 content revision / inner Git commit。

### 8.6 Shell 边界

`flow://` 的强制范围首先覆盖 zero-core 文件工具。Skill 脚本需要 Flow 输入时，由 Work
runner 显式传参、stdin 或受控 manifest，不要求脚本搜索 `.zero-core/`。

拥有任意 Shell 的受信 Agent 理论上仍可直接访问物理目录；没有 OS 沙盒就不能把应用层
mount 宣称为恶意进程隔离。未来如提高威胁模型，应另立 Shell/进程沙盒 effort。

## 9. Worktree 模型

### 9.1 路径与身份

```text
worktreeRoot = <Project.workspaceDir>/.zero-core/worktrees/<worktree-id>
```

WorkRun 的 TurnInvocationContext 同时持有：

- `projectRoot`：注册 Project 的主目录，用于控制目录和最终合并；
- `workspaceRoot`：本次源码工具实际工作的 checkout；
- `flowMounts`：本次虚拟 Flow 文档映射。

不能把 `workspaceRoot` 当成新的 Project root，也不能在 worktree 内递归初始化
`.zero-core`。

### 9.2 创建与失败语义

- 只有 Work 配置声明 `workspace.kind: worktree` 时才创建 linked worktree。
- 非 Git Project 或创建失败时，WorkRun 明确失败并保持 Flow 可重试。
- 禁止失败后返回主 workspace 继续执行。
- 分支名、worktree id、base ref 和清理策略由通用 worktree manager 生成并持久化。
- WorkRun 完成后由软件按配置合并、保留或清理；Agent 不手动查找 worktree。
- `.zero-core` 内层 Git 忽略整个 `worktrees/`，不会把外层项目 checkout 纳入自己的
  history。

### 9.3 `agent-eval-harness` 自身作为 Project

内置 Skill 启动后只 seed 到 `~/.zero-core/skills/agent-eval-harness/`。用户或 Zero
Agent 可以随后显式把该目录注册成普通 Project；注册不是启动副作用。

该目录如需源码 worktree，仍要显式初始化或连接自己的外层 Git 仓库。Project 注册、
目标源码 Git 初始化和 Flow 启用是不同操作；`.zero-core` 内层 Git 只管理控制面，不能
代替目标源码仓库。

## 10. 内置 `agent-eval-harness` Skill

### 10.1 发行形态

完成后内置 Skill 清单应恰好包含：

```text
skill-creator
agent-eval-harness
```

目标目录：

```text
src/server/bundled-skills/agent-eval-harness/
├── SKILL.md
├── scripts/
│   ├── run-eval.mjs
│   ├── analyze-session.mjs
│   └── validate-profile.mjs
├── profiles/
│   ├── default.yaml
│   └── retrospective.yaml
├── scenarios/
│   ├── schema.json
│   └── examples/
├── tests/
└── package.json
```

文件名可在 plan 中微调，但五类职责必须保留：使用说明、执行脚本、评估策略、场景和
自测。实现优先使用 Node 标准库和 zero-core 已有 Node 基线。

### 10.2 Skill 职责

- 读取 profile，选择 scenario 和 grader；
- 准备隔离的临时环境或使用 profile 指定的项目命令；
- 运行确定性断言、目标项目测试或可选模型评审；
- 分析归档 session JSON，生成带证据的发现；
- 输出稳定 JSON 和人类可读 Markdown 报告；
- 由 Agent 调用目标 Project 的 Flow 工具创建 Found item 或更新本次
  `flow://current` 文档。

Skill 不负责：

- 选择目标项目的固定 Flow；
- 直接修改被评估项目代码；
- 自动把发现移到 Ready/Build；
- 决定用户是否必须阻断合并；
- 直接读取 zero-core 私有数据库。

### 10.3 Profile 与 scenario

Profile 至少能配置：

- 项目准备、测试和清理命令；
- scenario 选择；
- outcome grader、trajectory grader 和可选 judge；
- 超时、trial 数和成本预算；
- 报告格式和退出码策略。

Scenario 采用 outcome-first 模型，至少包含：

- instruction；
- 初始环境/fixture；
- 期望 outcome 或断言；
- 可选 trajectory 约束；
- 可选 oracle/reference；
- tag 和适用 profile。

精确 tool-call 序列不是默认成功条件。只要最终状态满足需求，Agent 可以采用不同合法
路径；trajectory grader 主要诊断违规、无效循环和工具契约问题。

### 10.4 归档分析 Agent

归档分析不需要核心增加“导出到 Flow”的专用通道。当前归档已经是普通 JSON：

```text
~/.zero-core/archives/<agentId>/<sessionId>.json
```

可以配置一个独立 Agent：

```text
Archive Analyst Agent
├── defaultWorkspace: ~/.zero-core/archives
├── skill: agent-eval-harness
└── trigger: cron
```

最简单的方式是现有全局 Cron 直接驱动该 Agent turn；如果希望扫描任务也使用
WorkDefinition / WorkRun 管理，则把归档根注册成一个独立 Project，并配置
`workspace.kind: agent` 的 Cron Work。两种方式都读取同一批普通 JSON，不需要核心增加
专用归档 adapter。

定时 Work：

1. 增量扫描尚未分析的 archive；
2. 从 archive 的 SessionRecord 识别来源 Project；
3. 按 profile/scenario 分析工具、代码上下文与行为合理性；
4. 对有价值的发现，通过通用 Flow 工具在对应已注册 Project 创建 Found item；
5. 保存处理 checkpoint 和去重信息。

checkpoint 可以保存在归档分析 Project 自己的 `.zero-core` 或 zero-core Work 状态中，
不修改原始 archive JSON。目标 Project 不存在或未注册时，结果保留在分析报告中等待
路由，不自动创建 Project。

### 10.5 执行结果与门禁

runner 同时产出：

- 稳定 JSON：scenario、trial、grader、pass/fail/score、证据、耗时和错误；
- Markdown 摘要；
- 有意义的进程退出码。

退出码只表达脚本运行结果。是否触发返工、阻断 transition 或只记录观察，由调用它的
Work 和项目 FlowDefinition 决定，zero-core 不设置全局 Eval gate。

### 10.6 自主演进与发行副本

现有 seed 语义保持：

- bundled 目录是新安装的 bootstrap 副本；
- `~/.zero-core/skills/agent-eval-harness/` 是该安装上的 Agent-owned 副本；
- Agent 可以在其注册为 Project 后走正常 Flow 演进；
- 本地演进不自动回写 zero-core 仓库中的 bundled 副本；
- 向新安装发布时，通过明确的 zero-core 发行 Work 审核、同步并提交。

## 11. 状态、真相源与恢复

### 11.1 真相源

| 数据 | 真相源 |
|---|---|
| Project 根目录 | Project `workspaceDir` |
| Project 控制面身份 | `.zero-core/manifest.json` |
| FlowDefinition / WorkDefinition | `.zero-core` 内层 Git 中的配置文件 |
| FlowInstance 当前状态、依赖、composition、事件、文档 | `.zero-core` 内层 Git 中的实例文件和 composition manifest |
| Project/Flow 查询索引 | zero-core DB，可从项目控制面重建 |
| WorkRun 状态与队列 | zero-core DB |
| WorkRun 配置和 invocation | 创建时的持久化 snapshot |
| 运行日志和 Eval 产物 | `.zero-core/runs` / Flow artifacts |
| linked worktree | `.zero-core/worktrees` + 外层项目 Git 元数据 |
| Agent 当前工具上下文 | 正在执行的 TurnInvocationContext |

DB 不复制 Markdown 正文。内层 Git 不承担实时 WorkRun queue；两者职责不能互相冒充。

### 11.2 Flow 写事务

Flow transition 需要 per-project 串行锁和 expected revision：

1. 校验 definition、instance revision 和 actor；
2. 在 `.zero-core/tmp` 准备 state/event/doc 变更；
3. atomic replace 到权威路径；
4. 创建内层 Git commit；
5. 成功后更新 DB index/outbox 并发出 event。

如果 commit 失败，软件必须用事务备份恢复原文件，或留下可识别的 pending transaction
供启动恢复；不能发出 transition event，也不能返回成功。普通 Flow 文档编辑同样在
每次逻辑 Write/Edit 内立即 commit，不能跨 turn 留下共享 dirty tree。

commit 成功后若 DB index/outbox publish 失败，权威状态已经成立：软件返回
`committed_pending_delivery`，由后台/启动 reconcile 根据已提交 event 补索引和重发。
消费者以 eventId 幂等，不能因重发产生第二个 WorkRun。

### 11.3 WorkRun 与上下文恢复

- 应用重启后，从持久化 WorkRun 恢复 queue、Work snapshot 和 invocation。
- 从各 Project `dependencies.json` 重建 dependency 正向/反向索引，重算 milestone；
  对已提交但未投递的 dependency event 幂等补发。
- 从 `flow/compositions/*.json` 重建 lineage 正向/反向索引和 idempotency key →
  operation 映射，对已提交但未投递的 split/merge event 幂等补发。
- 遗留 running run 按 retry policy 决定重新排队或失败。
- 恢复前校验 Project 根、FlowDefinition digest、worktree 和 mount 目标。
- `read` mount 目标不存在是错误；`create` mount 目标不存在是正常初态。
- WorkRun 完成或撤销后，新 invocation 不继承其 workspace 或 mount。
- 清理 worktree 失败只生成可重试清理任务，不删除 Flow 文档。
- `.zero-core` 文件缺失但内层 `.git` 仍在时允许软件恢复工作树；整个嵌套仓库被删除时
  明确报告控制面丢失，不用 DB 摘要伪造正文。

## 12. 从当前实现迁移

### 12.1 新 Flow 独立于旧 Requirement

- 新建独立 FlowDefinition、FlowInstance、FlowDependency、FlowComposition、
  TransitionEvent 和 WorkRun 模型。
- 不复用 `RequirementStatus`、`requirement-state-machine.ts` 或旧
  `FLOW_TRANSITIONS` 作为新 Flow 核心。
- 旧 Requirement 系统在迁移期间保持原样运行，不与新 Flow 双写。
- 提供一次性显式 importer，把选择的 Requirement 和文档转换为指定 Project 的
  FlowInstance。
- import 成功并校验后，用户再决定何时把旧 Requirement UI/API 设为只读并最终删除。
- 不为长期兼容构建“Requirement projection of Flow”或“Flow projection of
  Requirement”。

### 12.2 控制目录与文档

- Project 启用新 Flow 时初始化/校验 `.zero-core`、manifest、内层 Git 和外层 exclude。
- 现有 `docs/requirements/*.md` 与 `.zero/requirements/...` 不在启动时删除或移动。
- importer 显式复制内容、记录来源和校验 hash；所有新 Flow 文档只写入
  `.zero-core/flow/instances/...`。
- 已存在且不属于 zero-core 的 `.zero-core` 必须先由用户处理冲突。

### 12.3 Session 与 Context

- 保留 `agentId + projectId` 的长期 Project Session 路由。
- 把 `SessionContextBundle.workspaceDir` 拆成稳定 `projectRoot` 与逐 turn
  `workspaceRoot`。
- Work/Cron/用户输入队列改为保存完整 TurnInvocationContext。
- AgentLoop 与 ToolFactory 从当前 invocation 取动态 ToolCallContext。
- 当前 busy skip 改为持久化 WorkRun queue。
- 复用 session-turn-lifecycle 的 TurnRun、snapshot、queue pause 和 handoff，不建立第二套
  Session busy/waiting 状态。
- prompt cache、environment block、Work context 和 VFS mounts 每个 turn 按
  invocation 重建。

### 12.4 Worktree

- 新 Work 只使用 `<project>/.zero-core/worktrees/`。
- 已在 `~/.zero-core/projects/...` 或 `<workspace>.worktrees/...` 运行的 worktree 保持
  原 locator 直到完成。
- 新 worktree 创建失败不回退主 checkout。

### 12.5 Skill

- 在 `BUILTIN_SKILL_IDS` 增加 `agent-eval-harness`。
- 让现有递归复制流程携带全部资源。
- 把公开虚拟路径从 `[skills]/` 硬切为 `skill://`。
- 删除旧 `[skills]/` 解析，增加版本化的内置 Skill token migration。
- 添加 bundled 资产、脚本、profile/scenario、seed 和打包产物测试。
- 启动只 seed Skill，不注册 Project、不创建 Flow、不运行 Eval。

## 13. 被否决的替代方案

- **把 Eval 写成 zero-core 固定服务/工具**：演进必须修改核心并发布，与 Eval 高频变化
  和 Agent 自主管理冲突。
- **只有一个脚本目录，没有 Skill**：Agent 缺少渐进式说明、选择规则和统一入口。
- **只有 Skill，没有 profiles/scenarios/tests**：无法形成可复用设施。
- **启动时自动注册 Eval Project**：发行与用户运行时配置耦合。
- **Flow 文档提交进目标外层 Git**：污染项目历史。
- **只用外层 `.gitignore` / `.git/info/exclude` 保护 Flow 文档**：
  `git clean -fdx` 可删除普通 ignored 文件，不能提供历史和恢复。
- **默认建立外部第二份文档真相源**：引入同步冲突；内层 Git 已满足本机轻量历史。
- **把文档复制到每个 worktree**：形成多份真相源。
- **FlowDefinition 直接引用 Work**：把状态图与执行部署耦合，难以替换 Work。
- **依赖直接写死目标 state 名**：跨 FlowDefinition 耦合内部状态，改版后无法稳定解释；
  应引用 prerequisite definition 暴露的 milestone。
- **允许 dependency cycle**：会产生无可执行出口的隐式死锁，首版直接拒绝。
- **依赖满足后核心自动 transition**：把状态判断和业务决策混在一起；核心只发标准
  dependency event，Work/Agent 决定后续动作。
- **split 时自动关闭 parent，merge 时删除 source**：会破坏独立历史并把业务状态写死；
  source 生命周期由项目 Flow/Work 决定。
- **merge 自动拼接或覆盖文档**：不同文档没有通用冲突语义；composition 只固定输入
  revision，由 Work/Agent 生成目标内容。
- **首版支持跨 Project split/merge**：需要多个内层 Git 仓库的分布式原子事务；跨
  Project 协作首版使用 dependency。
- **WorkRun 成功自动等价于 Flow 迁移**：Agent 完成一次执行不代表业务判断已经通过。
- **同一个 Work 工具同时管理 WorkDefinition 和 WorkRun**：当前权限按工具名分配，会让
  普通 Project Agent同时获得配置删除/修改权。
- **为 Work/Flow 增加 action-level tool policy**：扩大整个授权模型且增加每次调用解释
  成本；使用 Project/Flow/Work 三个工具级能力边界即可。
- **把每个 Flow/Work 配置字段做成 Project action**：会让扁平 schema 和 prompt 失控；
  Project 只接收通用、完整、可验证的 definition version。
- **每个 WorkRun 创建独立 Project Session**：割裂同一 Agent 对项目多个任务的连续理解。
- **在长期 SessionConfig 上热切换 cwd 和 mount**：容易留下旧 Work 上下文。
- **按 agentId 永久映射 `flow://`**：同一 Agent 的不同 turn 会串用上下文。
- **worktree 创建失败回退主目录**：隔离承诺失效。
- **把新 Flow 建在旧 Requirement 状态机上**：继承硬编码状态、文档路径和 UI schema。
- **把 `flow://` 宣称为 Shell 沙盒**：没有 OS 隔离时不成立。

## 14. 已定决策

| # | 决策 |
|---|---|
| D1 | Eval 以自包含内置 Skill 交付，不作为 zero-core 固定业务代码。 |
| D2 | 完成后的内置 Skill 为 `skill-creator` 与 `agent-eval-harness` 两个。 |
| D3 | Eval Skill 包含脚本、profiles、scenarios 和测试。 |
| D4 | Skill seed 后是否注册成 Project 是显式运行时操作，启动不自动触发。 |
| D5 | Project 可绑定任意目录；控制根固定为 `<workspaceDir>/.zero-core/`。 |
| D6 | `.zero-core` 整体排除出项目外层 Git，同时自身是软件维护的轻量 Git 仓库。 |
| D7 | Flow 定义、显式 draft、FlowView、实例、文档、事件和 Work 定义由内层 Git 版本化；runs/worktrees/cache/tmp 不跟踪。 |
| D8 | `projectControlDir` 从注册 Project 根计算，不从 worktree/cwd 反推。 |
| D9 | 普通文件工具从 Project 根遍历时忽略 `.zero-core`；内部 worktree 作为 workspace 时正常访问。 |
| D10 | FlowDefinition 默认归 Project 所有；同一 Project 可有多个 definitionId，各自维护 active version，并可选一个 default。 |
| D11 | Flow 只验证并提交 transition、dependency、composition 和事件；Flow 不引用 Work。 |
| D12 | Work 自己声明 Flow event/manual/cron trigger 和 Agent 执行配置。 |
| D13 | WorkRun 是软件自动维护的轻量队列/执行记录，不是第二套 Flow。 |
| D14 | 同一 Agent + Project 保持长期 Project Session；WorkRun 不另建隔离 Session。 |
| D15 | workspace、worktree、Work 和 mounts 属于不可变 TurnInvocationContext。 |
| D16 | busy Work 进入持久队列，不再直接 skip。 |
| D17 | `flow://project` 提供项目视野，`flow://current` 提供当前任务挂载。 |
| D18 | 文档流转通过 mount/revision/access 完成，不由 Agent 查找或复制。 |
| D19 | 权限采用 trust-first 默认，不增加逐次用户审批。 |
| D20 | Eval 结果是否门禁由 Project 的 Flow/Work 配置决定。 |
| D21 | Eval 只诊断和报告；目标代码修复进入目标 Project 的独立 Flow。 |
| D22 | 归档分析 Agent 直接以归档目录为 workspace，通过全局 Cron 或归档 Project 的 Cron Work 增量分析 JSON。 |
| D23 | Skill 的唯一虚拟目录为 `skill://`；旧 `[skills]/` 不兼容。 |
| D24 | 新 Flow 独立于旧 Requirement；旧数据只通过一次性显式 importer 迁移。 |
| D25 | FlowInstance 支持同/跨 Project 有向依赖；依赖引用 prerequisite milestone，cycle 拒绝。 |
| D26 | dependency gate 只作用于 FlowDefinition 明确声明的 transition；满足后只发事件，不自动流转。 |
| D27 | split/merge 是与 dependency 分离的同 Project composition；以不可变 manifest 保存 lineage，source 历史始终保留。 |
| D28 | composition 只固定 source 文档 revision，不自动拼接内容；综合工作由 Work/Agent 完成。 |
| D29 | Flow transition graph 允许配置回边/循环；正向与反向 transition 使用同一原子 event/outbox 协议。 |
| D30 | 被打回 event 由 WorkDefinition 正常消费并创建新 WorkRun；返工不是旧 WorkRun retry，核心不硬编码阶段角色。 |
| D31 | FlowInstance 可经配置 transition 进入 terminal abandoned；废案保留历史、取消既有活动 WorkRun，不物理删除。 |
| D32 | 工具权限仍按工具名：Project 管 Flow/Work 配置，Flow 管 FlowInstance，Work 管 WorkRun。 |
| D33 | WorkRun 默认队列顺序可由持有 Work 工具的 Project Agent 审计地 defer、prioritize、switch。 |
| D34 | Project 通过通用 config.validate/publish/activate/list/get 管理不可变定义版本，不吸收 Flow/Work 领域实现。 |
| D35 | semantic FlowDefinition 不保存颜色、画布布局或进度权重；展示由独立 FlowView 管理。 |
| D36 | dependency、composition lineage 与 related relation 是三种独立关系；只有 dependency 可参与 gate。 |
| D37 | Flow 可回边/循环，默认进度不使用通用百分比；UI 从 state、milestone、blocker、WorkRun 与 lineage 派生。 |
| D38 | 只有 FlowView 显式声明 stage/weight 时显示百分比，且该 projection 不写回 FlowInstance 或参与 gate。 |
| D39 | 原单一 effort 拆为 Project Flow、Work Runtime、Project Management UI 与 Eval Skill 四个独立 effort。 |
| D40 | Definition Studio 使用持久 draft；draft 不进入 active runtime，publish 后才形成不可变 semantic version。 |
| D41 | Project Management UI 拥有 Project 页面壳层、Overview 与模块编排；Wiki/Flow/Work/Session 仍拥有各自 API、状态和领域组件行为。 |
| D42 | Project 页面一级区域为 Overview、Flows、Work、Wiki、Settings；旧 Requirement 只保留明确的 Legacy/Importer 边界。 |

## 15. 进入 plan 前的验收边界

后续 plan 必须覆盖并分别验收：

1. Project 控制目录 manifest、外层 exclude、内层 Git 初始化、commit、rollback 和恢复。
2. Project 级 FlowDefinition 版本/digest、FlowInstance、原子 transition 和标准 event。
   必须覆盖正向/反向/废案 transition、返工 input contract、回边循环、terminal 清理和
   同一事件投递协议。
3. milestone、同/跨 Project dependency、cycle 检测、gated transition 和依赖事件恢复。
4. 同 Project split/merge、policy、幂等、原子提交、不可变 lineage、固定文档输入和
   composition event 恢复。
5. 正向/反向 Work trigger、WorkDefinition snapshot、WorkRun 幂等/队列/重试/重启恢复，
   以及 deferred/priority/switch 和 Agent 自主选择。
6. Project/Flow/Work 三工具的工具级授权边界、Project config 原语和旧工具原子切换。
7. ProjectSessionContext、TurnInvocationContext、ToolCallContext 和每 turn cache 重建。
8. 用户输入、Work、Cron、Wait 唤醒和 subagent 的上下文继承/清除测试。
9. 项目内 linked worktree 创建/失败/合并/清理，无主目录 fallback。
10. 普通文件工具忽略物理 `.zero-core`，同时内部 worktree 正常工作。
11. 通用 VFS provider、`skill://` 硬迁移、`flow://project/current` mount 和
   Read/Write/Edit/Glob/Grep 一致行为。
12. content revision、路径逃逸、mount 冲突和多个 Agent 并发编辑。
13. 多 FlowDefinition catalog、独立 active binding、持久 draft 与 semantic/view 分离。
14. dependency/lineage/related 分层可视化，以及不写回核心的进度 projection。
15. 新 Flow 与旧 Requirement 完全解耦，以及显式 importer 的无损校验。
16. `agent-eval-harness` bundled、seed、脚本、profile/scenario、归档扫描和自测。
17. 启动无自动 Eval Project 注册、无自动目标源码 Git 初始化、无自动 Flow、无自动
    Eval 执行。

profile 的最终序列化格式、Eval CLI 的精确参数名、默认 Flow 模板内容和具体视觉样式
可以由所属 effort 的 plan 确定；不得改变上述职责边界和已定决策。
