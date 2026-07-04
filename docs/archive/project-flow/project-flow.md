# Design:Project Flow(需求→代码合并的统一流转)

> 状态:**Draft,模型已锁定,待分阶段实现**。
> 一句话:**Flow 工具做状态迁移 + 写文档段 + 发命名 hook 信号;`verify` 是 verdict-driven 复合动作(消费覆盖率 verdict → 合并/返工,谁出 verdict 由外部决定——用户直供,或 work 配置的复盘 agent 自带 verdict 调用)。需求文档是 `docs/` 下的文件(agent 直接读,不入 DB)。交付靠 hook fire work(ready → 交付 work)。**
> 起源:project 类工具 = Project / Work / Flow 三个。Flow 覆盖"需求→代码合并"。Cron / Orchestrate 通用,不在本类。
> **去-role**:工具不绑角色。状态机 actor 词表 = `{agent, user, system}`(退役的 analyst/lead 已 collapse 成 agent);谁来执行某 action 由 work/toolPolicy 配置,工具不挑角色、不委派。

---

## 0. 设计原则

1. **工具与 agent 不相关**——按域分组,不绑角色。
2. **门控是配置的事**——某 action 暴露给 agent 还是只给用户,是 toolPolicy 配置,不是结构差别。"用户确认"本质也是工具 action,只是没暴露给 agent(改配置即可开放,如 verify 可配给 agent)。
3. **Flow action = 迁态 + 写文档段 + 发命名信号**。`verify` 是 verdict-driven 复合动作(消费覆盖率 verdict → 合并/返工);**工具不挑复盘者、不委派**——verdict 由调用方外部供入。
4. **每步流转发命名 hook 信号**(显式 emit),触发什么看 work 配置。
5. **需求文档是文件**(`docs/requirements/{id}.md`),agent 直接用文件工具读;**不入 DB**。work/工具 prompt 约定路径。

## 1. 背景:现状的问题

- 工具散:`CreateRequirement` / `CreateRequirementWithDoc` / `verify`(复合阻塞)。
- 交付 work hook 在 `requirements.create`(一建建议就跑,绕过用户)。
- agent 没法 list/get 需求。
- 上下文散在 messages + 文件 doc;worktree 在 `{workspace}.worktrees/`(旁,易误改)。

## 2. 状态机 + action + hook(定稿)

状态序列:Found → Discuss → Ready → Plan → Build → Verify → Closed。

| action | 迁移 | 驱动(可配) | 副作用 | 发的 hook |
|---|---|---|---|---|
| `create` | →Found | agent | 写文档 Intent 段 | `created` |
| `pick` | Found→Discuss | 用户(可 agent) | 建/续文档 + 写 Summary | `picked` |
| `ready` | Discuss→Ready | 用户(可 agent) | 文档定型 | `ready`(**fire 交付 work**) |
| `plan` | Ready→Plan | agent | 建 worktree + 写 Plan 段 | `planned` |
| `startBuild` | Plan→Build | 用户(可 agent) | 批计划(Orchestrate confirm 门) | `buildStarted` |
| `finishBuild` | Build→Verify | agent | 写 Coverage 段 | `buildFinished` |
| `verify` | Verify→Closed/返工 | **用户 或 agent(配置)** | **复合(消费 verdict):调用方供 covered/reason → APPROVED 则 mergeFeatureToMain + closed + 写 Decision Log,发 `verified`;REJECTED 则返工 build + 写 Decision Log,发 `rejected`** | `verified` / `rejected` |

外加只读:`list` / `get`。

> **`verify` 是 verdict-driven 复合动作**:工具消费一个覆盖率 verdict(由调用方供入),驱动合并/返工的机械后果。**谁出 verdict 与工具无关**——用户经 UI 直供,或 work 配置的复盘 agent 自行分析后带 verdict 调用。工具不挑复盘者、不委派、不解析"VERDICT:"行。mergeFeatureToMain 仍是 verify 内部的机械步骤(不拆成独立 work)。

## 3. hook 信号词表(显式 emit)

显式发命名信号(Flow action 迁态后调 `emitTransition` 发 `requirements.<signal>`),hook manager 按事件名匹配 work.hooks[].event。

| 信号 | action | 默认订阅 |
|---|---|---|
| `requirements.created` | create | (观察) |
| `requirements.picked` | pick | — |
| `requirements.ready` | ready | **交付 work**(需求管理) |
| `requirements.planned` | plan | — |
| `requirements.buildStarted` | startBuild | — |
| `requirements.buildFinished` | finishBuild | — (信息性;"等待 verify") |
| `requirements.verified` | verify 通过 | (观察;合并在 verify 内已做) |
| `requirements.rejected` | verify 打回 | (信息性;意见回灌) |

> 只有 `ready → 交付 work` 是必需订阅;其余信号为观察/可选(verdict 由外部供入,合并在 verify 内,不需独立 work)。

## 4. 文档与 worktree 模型

### 4.1 需求文档 = 文件(agent 直读,不入 DB)
- 路径:`{workspace}/docs/requirements/{id}.md`(非隐藏,文件树可见,可 commit=方便传递)。
- **agent 直接用文件工具(Read)读**;work/工具 prompt 约定该路径。**不存 DB**。
- 各 Flow action **写对应段到文件**(create→Intent,pick→Summary,plan→Plan,finishBuild→Coverage,verify→Decision Log)——服务端写文件(action handler 直接 fs 写)。
- 文档结构(先试):Intent / Summary / Plan / Coverage / Decision Log。

### 4.2 Worktree 模型
- 位置:`~/.zero-core/projects/{project}/{req-shortId}/`(集中,避免 workspace 旁误改)。
- **串行**:一次一个 plan/worktree(多个 Discuss→Ready 只排队)。
- 生命周期:Ready→Plan 建 worktree → 干活(feature 分支)+ verify → 通过 merge feature→main 回原项目 → 清理。
- **文档 Ready 前不 commit → 不进 worktree**。worktree 里的 agent(执行 build 的 agent)读文档走**原项目绝对路径**(plan action 把 doc 路径注入其上下文);复盘 agent(若 work 配置)在项目 session 自带 verdict 调 verify,直接读。
- 文件树根跟活动 session workspace(FileTreePanel 现状):build 期显 worktree(代码),文档不在其中——可接受(agent 经绝对路径读);项目上下文(Discuss/idle/合回)显项目 → 文档可见可重选。

## 5. 关键架构变更

1. **新建 Flow 工具**(7 action + list/get),每个 = transitionStatus + 写文档段 + 发命名信号。`verify` 是 verdict-driven 复合(消费 verdict + merge + 发 verified/rejected;不挑复盘者、不委派)。
2. **`verify` 不拆**:沿用复合语义,改成 Flow action + 发命名信号 + verdict-driven(调用方供 verdict)。**不新增复盘 work / 合并 work**。
3. **交付 work hook 改 `create`→`ready`**([builtin-work-templates.ts](../../../src/server/builtin-work-templates.ts));actionPrompt 按新流程重写(finishBuild 提交、verify 复合判断)。
4. **文档 = 文件**(docs/requirements/{id}.md),不入 DB;Flow action 写段,agent 文件工具读。**不做 requirement-doc-store DB 化、不做投影同步**。
5. **worktree 集中化**:`~/.zero-core/projects/{project}/{req-shortId}/`,串行。
6. **UI**:文档走 workspace 文件方案(复用文件树 → DocViewerPanel),**不加导航**;文件树跟活动 session worktree。确认动作放文档面板段旁。看板无 drag。
7. **替换旧工具**:CreateRequirement / CreateRequirementWithDoc / verify → Flow。RENAMED_TOOLS back-compat。
8. **hook 信号机制**:data-change-hub 加 `emitTransition(collection, signal, id, record)`;hook manager 匹配命名信号。

## 6. 责任矩阵

| 阶段 | 驱动 | 机制 |
|---|---|---|
| 建(Found) | agent | Flow.create(写 Intent)→ `created` |
| 选中(Discuss) | 用户/agent | Flow.pick(写 Summary)→ `picked` |
| 定型(Ready) | 用户/agent | Flow.ready → `ready` |
| 启动交付 | **hook 自动** | `ready` → fire 交付 work |
| 领取(Plan) | agent | Flow.plan(建 worktree + 写 Plan)→ `planned` |
| 批计划(Build) | 用户/agent | Flow.startBuild → `buildStarted` |
| 实现 | agent | work 内 Orchestrate(worktree;读文档走原项目路径) |
| 提交(Verify) | agent | Flow.finishBuild(写 Coverage)→ `buildFinished` |
| 判覆盖 + 合并(Closed) | **用户 或 agent** | Flow.verify(verdict-driven 复合:消费调用方供的 verdict + merge + 写 Decision Log)→ `verified`/`rejected` |

verdict 由调用方供入(用户或复盘 agent),合并在 `verify` 内(复合),无独立 work。

## 7. 不变 / 不动

- Cron / Orchestrate 通用(Build 阶段编排);Wiki / AgentRegistry 其它域。
- 状态机合法迁移规则不变。
- verify 的 merge 语义不变;改成 verdict-driven(消费调用方供的 verdict,不再内部 delegate 复盘者)+ Flow action + 命名信号 + 配置化暴露。

## 8. 风险 / 决策

- **worktree agent 读文档**:文档不进 worktree(不 commit),build agent 在 worktree 经**原项目绝对路径**读(plan action 注入路径)。需保证 Read 工具允许该绝对路径(readScope 等)。
- **既有交付 work hook 改 ready**:既有项目的交付 work hook 仍是 create → 要么 migration 改,要么 hook manager 同时认 create/ready 过渡期。
- **verify 配置化暴露**:默认用户;配给 agent 时该 agent toolPolicy 开 Flow.verify。配置驱动,不绑角色。
- **返工**:`rejected` 后意见写 Decision Log(文件);交付 work 下次 fire 读到(读文件)。build agent 重走 plan→finishBuild→verify。
- **back-compat**:旧工具名 → Flow(RENAMED_TOOLS)。
- **文档结构先试**:五段初版,后续调。
- **既有 .zero/requirements/ 旧文档**:迁移到 docs/requirements/ + 更新 docPath(或留旧路径兼容)。

## 9. 分阶段实现计划

每阶段三层 tsc + build:lib + vitest + 越界。

- **F1** — Flow 骨架 + 读(create/list/get;create 写 Intent 段到文件 + 发 created)。
- **F2** — 迁移 action + 显式命名信号(emitTransition;hook manager 匹配)。各 action 写文档段。
- **F3** — verify 接入(复合,沿用现语义,发 verified/rejected)+ 交付 work hook 改 ready + 替换旧工具(CreateRequirement/CreateRequirementWithDoc/verify → Flow)+ RENAMED_TOOLS + worktree 集中化。
- **F4** — UI(文档走文件树 → DocViewerPanel,不加导航;确认动作接 Flow 后端)+ 既有 work hook / 旧文档迁移。
- **F5** — 清理(删旧文件 + 注释 + code-graph + 全回归)。

## 10. 相关

- 代码权威:[requirement-store.ts](../../../src/server/requirement-store.ts)、[requirement-state-machine](../../../src/server/)、[project-work-hook-manager.ts](../../../src/server/project-work-hook-manager.ts)、[builtin-work-templates.ts](../../../src/server/builtin-work-templates.ts)、[verify-tool.ts](../../../src/runtime/tools/verify-tool.ts)、[pm-service.ts](../../../src/server/pm-service.ts)、[lead-service.ts](../../../src/server/lead-service.ts)、[data-change-hub.ts](../../../src/server/data-change-hub.ts)。
- 关联设计:[agent-context-fields](../agent-context-fields/agent-context-fields.md)、[runtime-push-ui-sync](../runtime-push-ui-sync/runtime-push-ui-sync.md)。
