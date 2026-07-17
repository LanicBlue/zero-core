# Agent Eval Harness 与配置化 Flow：实施路线图

> 设计基线：[design.md](./design.md)
> 状态：计划已于 2026-07-17 经用户确认完成，**尚未实施**。
> 当前实施前置：[`wiki-system-redesign`](../wiki-system-redesign/README.md) 必须完成
> Acceptance Final、经用户同意合并到目标主分支；本 effort 不得与其并行修改 Runtime、
> CallerCtx、文件保护、Core DB 或 Project UI。
> Plan 04 另需等待
> [`session-turn-lifecycle`](../session-turn-lifecycle/README.md) Final Acceptance；Plan 01–03
> 可以先完成，但不得在 Plan 04 中并行发明另一套 Session/Turn 状态机。

这是本次计划的外部实施安排，不是 zero-core 当前已经建立或执行的 Flow 控制。Plan 00
只在开工时核对合并事实；它不创建 dependency、不改变 FlowInstance，也不是系统门禁。
Plan 02 完成后，用户或 Agent 可以在软件运行时显式注册未来任务的 FlowInstance
dependency；zero-core 不会从计划文字自动推导控制关系。

本目录是后续执行 Agent 的合同基线。执行中若发现接口变化、语义歧义或无法同时满足的
acceptance，应先记录证据并回到本设计讨论，不得自行弱化 D1–D28、不变量或验收条件。

## 1. 使用方式

本目录把配置化 Flow / Work、Project 控制目录、Context Management、VFS 与内置
`agent-eval-harness` Skill 拆成可独立实施和验收的阶段：

```text
plan-XX-*.md        实施范围、顺序、边界和测试要求
acceptance-XX-*.md  可判定验收项与证据要求
result-XX.md        实施后由执行/验收 Agent 创建，当前不存在
```

每个实施 Agent 必须依次阅读：

1. [design.md](./design.md)；
2. 本 README；
3. 当前阶段 plan；
4. 当前阶段 acceptance；
5. 所有已完成阶段的 result 与偏差记录；
6. 合并后的 `wiki-system-redesign` 最终设计、result 和当前源码。

不得按本计划中的旧文件名机械修改合并后的代码；Plan 00 专门负责把计划合同映射到合并后
的真实结构。

## 2. 阶段与依赖

下表“依赖”和顺序图只描述这份实施计划的交接次序，不代表 zero-core 中已经存在
FlowDependency、FlowInstance 或自动门禁。

| 阶段 | Plan | Acceptance | 依赖 | 主要产物 |
|---|---|---|---|---|
| 00 | [Post-Wiki Reconciliation](plan-00-post-wiki-reconciliation.md) | [Acceptance 00](acceptance-00-post-wiki-reconciliation.md) | wiki final + merge | baseline、冲突映射、实际接口冻结 |
| 01 | [Project Control Git](plan-01-project-control-git.md) | [Acceptance 01](acceptance-01-project-control-git.md) | 00 | `.zero-core` manifest、内层 Git、外层 exclude |
| 02 | [Flow Engine](plan-02-flow-engine.md) | [Acceptance 02](acceptance-02-flow-engine.md) | 01 | FlowDefinition、FlowInstance、dependency/composition graph、原子 transition |
| 03 | [Work & WorkRun](plan-03-work-and-workrun.md) | [Acceptance 03](acceptance-03-work-and-workrun.md) | 02 | WorkDefinition trigger、持久 WorkRun 队列 |
| 04 | [Invocation Context](plan-04-invocation-context.md) | [Acceptance 04](acceptance-04-invocation-context.md) | 03 + session-turn-lifecycle FINAL | Project Session + TurnInvocation + ToolCallContext |
| 05 | [VFS & URI Cutover](plan-05-vfs-uri-cutover.md) | [Acceptance 05](acceptance-05-vfs-uri-cutover.md) | 01–04 | `.zero-core` 隐藏、`skill://`、`flow://` |
| 06 | [Worktree Execution](plan-06-worktree-execution.md) | [Acceptance 06](acceptance-06-worktree-execution.md) | 01–05 | 内部 linked worktree、执行/清理策略 |
| 07 | [Flow API, UI & Importer](plan-07-flow-api-ui-importer.md) | [Acceptance 07](acceptance-07-flow-api-ui-importer.md) | 02–06 | 通用 Flow UI、WorkRun 观察、旧 Requirement importer |
| 08 | [Eval Skill & Archive Analyst](plan-08-eval-skill-archive-analyst.md) | [Acceptance 08](acceptance-08-eval-skill-archive-analyst.md) | 02–07 | bundled Eval Skill、profiles/scenarios、归档扫描 |
| 09 | [Cutover & Hardening](plan-09-cutover-hardening.md) | [Acceptance 09](acceptance-09-cutover-hardening.md) | 01–08 | 恢复、性能、旧 Flow action 清理、活动文档 |

所有阶段通过后执行 [Final Acceptance](acceptance-final.md)。

```text
wiki-system-redesign FINAL + merge
          ↓
00 → 01 → 02 → 03 ───────────────→ 04 → 05 → 06 → 07 → 08 → 09 → FINAL
                    ↑
       session-turn-lifecycle FINAL
```

阶段顺序是交接顺序，不表示一个 WorkRun 可以跨阶段留下编译失败。每阶段必须独立全绿。

## 3. 全程不可违反的不变量

### 3.1 Project 控制面

- `projectControlDir` 只能由注册 Project 的 `workspaceDir` 计算。
- 外层项目 Git 不跟踪 `.zero-core`；`.zero-core` 自身是独立 Git 仓库。
- 内层 Git 只跟踪 manifest、Flow/Work 定义、FlowInstance 状态、dependency、
  composition、事件和文档；不跟踪 worktrees/runs/cache/tmp。
- 未知非空 `.zero-core` 不得接管；已有 Project 初始化冲突不能导致整个应用无法启动，
  但必须禁用该 Project 的新 Flow/Work 并暴露稳定错误。
- 普通文件工具看不到物理 `.zero-core`；内部 worktree 作为 workspace 时必须正常工作。

### 3.2 Flow / Work

- Flow 不引用 Work，不直接 dispatch Agent，不创建 worktree。
- Work 自己声明 Flow event、manual 或 cron trigger。
- Project 的 FlowDefinition 版本不可变；FlowInstance 固定 version + digest。
- FlowInstance dependency 是有向无环图，引用目标 definition milestone，不写死目标
  state；无法证明无环时拒绝写入。
- 依赖只在 FlowDefinition 明确声明 gate 的 transition 上阻断；满足后发标准事件，不
  自动 transition。
- split/merge 是与 dependency 分离的同 Project composition；source 历史保留，
  lineage 无环，整次操作以一个内层 Git commit 原子提交。
- composition 只固定 source 文档 revision，不自动拼接或覆盖内容；跨 Project 组合首版
  使用 dependency 协调。
- Flow transition 只有在内层 Git commit 成功后才能更新索引和发出 event。
- WorkRun 成功不等于 Flow 自动迁移；Agent 通过通用 Flow tool 明确请求 transition。
- 新 Flow 不读写旧 Requirement 表作为运行事实源，也不与它双写。

### 3.3 Context

- 一个 `agentId + projectId` 保持长期 Project Session。
- Work 的 cwd、worktree、mount 和 workId 只存在于不可变 TurnInvocationContext。
- 同一 Session 的 turn 串行；busy WorkRun 持久排队，不得 skip 或覆盖当前 turn。
- Session 状态、Stop、Wait、handoff、普通 inbox 和跨 Turn task event 复用
  `session-turn-lifecycle` 的唯一 supervisor，不建立平行真相源。
- 每个工具调用读取当前 ToolCallContext；不能在 Loop 创建时永久闭包 cwd/mount。
- 用户 queued input、Wait 唤醒和 subagent 不能继承错误的前一 Work 上下文。

### 3.4 URI 与 Skill

- 对 Agent 公开的 Skill 规范路径只有 `skill://`；`[skills]/` 在切换后必须拒绝。
- `flow://project` 提供 Project 视野，`flow://current` 提供当前 invocation 的任务挂载。
- 所有 VFS scheme 必须在进入 `node:path` / OS API 前解析，并回映射工具结果。
- URI 是应用层路径，不宣称为任意 Shell 的 OS 沙盒。

### 3.5 Eval

- Eval 以自包含内置 Skill 交付，不写入 AgentLoop 固定业务逻辑。
- 启动不自动注册 Eval Project、不自动创建分析 Agent/Cron、不自动运行 Eval。
- Eval 诊断与报告问题，不直接修改被评估项目代码。
- 归档分析读取普通 archive JSON，不读取 zero-core 私有 DB。

## 4. 阶段执行协议

每阶段开始前：

1. 确认所有依赖阶段的 acceptance 和 result 已通过。
2. 从最新已验收 commit 建独立 worktree/分支。
3. 记录 `git status`、Node/npm/Git 版本。
4. 运行 baseline：

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run check:links
```

涉及 renderer/Electron 的阶段还要记录：

```bash
npm run build
npm run test:e2e
```

完成后：

1. 逐项执行对应 acceptance。
2. 新建 `result-XX.md`，记录 commit、修改文件、实际命令、测试数量、证据和偏差。
3. 失败回到当前阶段修复，不把临时 adapter 或 red test 留给下一阶段。
4. 推荐实现 Agent 与验收 Agent 不同；验收者只相信代码和证据。

## 5. 变更控制

如果合并后的 Wiki 架构或实施证据与本计划冲突：

1. 停止扩大代码改动；
2. 在 result 中记录事实、受影响阶段和候选方案；
3. 先更新 design、README 及所有受影响 plan/acceptance；
4. 由用户确认设计变化后再继续。

Plan 00 可以修正文件定位和接口名称，但不能静默改变本 README 的不变量。

## 6. 完成条件

只有 00–09 全部有通过的 result、[Final Acceptance](acceptance-final.md) 明确 PASS，并经
用户同意合并后，本 effort 才能移入 `docs/archive/`。在此之前，本目录描述的内容都只是
目标状态，不得写入当前架构文档作为已实现事实。
