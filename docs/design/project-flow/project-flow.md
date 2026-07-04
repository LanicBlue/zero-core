# Design:Project Flow(需求→代码合并的统一流转)

> 状态:**Draft,模型已锁定,待分阶段实现**。
> 一句话:**Flow 工具只做状态迁移 + 发 hook 信号;下游动作(PM 判断、archivist 合并、交付执行)全靠 work 订阅对应 hook 反应——不在工具里硬编码。需求文档(DB 真源)是唯一权威上下文,work/verify/用户判断都注入它。**
> 起源:project 类工具 = Project / Work / Flow 三个。Flow 覆盖"需求→代码合并"整条交付链。Cron / Orchestrate 是通用工具,不在本类。

---

## 0. 设计原则(贯穿全程)

1. **工具与 agent 不相关**——工具按域分组,不绑角色。
2. **门控是配置的事**——某个 action 暴露给 agent 还是只给用户,是 toolPolicy/暴露面配置,不是结构差别。"用户确认"本质也是一个工具 action,只是没暴露给 agent(以后改暴露即可)。
3. **Flow 工具只迁态 + 发 hook**——不在工具里编排下游(PM 委派、合并等)。下游全靠 work 订阅 hook。
4. **每步流转带 hook 信号**——发什么、触发什么,纯看 work 的 hooks 配置。
5. **需求文档是唯一权威上下文**——DB 存正文(结构化),文件是投影;讨论/决策写进文档,不写消息流。

## 1. 背景:现状的问题

现在"需求→代码合并"散在多个工具 + 隐藏的 service 自动逻辑:
- 工具:`CreateRequirement`(建 found)、`CreateRequirementWithDoc`(建 discuss+doc)、`verify`(复合阻塞:Build→Verify + delegateTask 唤醒 PM 判断 + APPROVED 自动 archivist 合并)。
- 隐藏自动:`verify` 工具内串了 PM 委派 + 合并;`LeadService.pickupRequirement`;retired 的 requirement-hooks;交付 work hook 在 `requirements.create`。
- 上下文散在 messages + 文件 doc;worktree 在 `{workspace}.worktrees/`(workspace 旁,易误改)。

问题:
- agent 没法 `list`/`get` 需求(看不见)。
- `verify` 复合阻塞,耦了三件事,违反原则 3。
- 交付 work 在 `create` 触发(绕过用户把关)。
- 上下文不统一(messages vs 文件 doc),worktree 跨边界传文档没机制。

## 2. 状态机 + action + hook(定稿)

action 按操作语义命名;hook 是该步发的信号。每个 action = 状态迁移 + 副作用 + 发 hook。

状态序列:Found → Discuss → Ready → Plan → Build → Verify → Closed。

| action | 迁移 | 现在驱动 | 副作用 | 发的 hook | 以后可 agent? |
|---|---|---|---|---|---|
| `create` | →Found | agent | 轻量建议(文档 Intent 段) | `created` | — |
| `pick` | Found→Discuss | 用户 | 选中 + 建文档 + 绑 docPath(Summary 段) | `picked` | 可 |
| `ready` | Discuss→Ready | 用户 | 讨论文档定型 | `ready`(**fire 交付 work**) | 可 |
| `plan` | Ready→Plan | agent | 领取 + 建 worktree(Plan 段) | `planned` | — |
| `startBuild` | Plan→Build | 用户 | 批计划开工 | `buildStarted` | 可 |
| `finishBuild` | Build→Verify | agent | 做完提交(Coverage 段) | `buildFinished`(**fire PM 判断 work**) | — |
| `verify`(通过) | Verify→Closed | 用户 | 合并(Decision Log 段) | `verified`(**fire 合并 work**) | 可 |
| `verify`(打回) | Verify→返工 | 用户 | 意见回灌(Decision Log 段) | `rejected`(**回灌原执行 work**) | 可 |

外加只读:`list` / `get`(观察)。

> 命名规范:`pick`=Found→Discuss(用户选中),`plan`=Ready→Plan(agent 领取),不混。`startBuild`(发 buildStarted,开工)vs `finishBuild`(发 buildFinished,做完),不撞。出 Verify 才叫 `verify`(verified/rejected)。

## 3. hook 信号词表(权威)

8 个信号,走 data-change-hub,事件名 `requirements.<signal>`:

| 信号 | 触发 action | 默认订阅者(看 work 配置) |
|---|---|---|
| `requirements.created` | create | (去重/通知) |
| `requirements.picked` | pick | — |
| `requirements.ready` | ready | **需求管理 work**(交付) |
| `requirements.planned` | plan | — |
| `requirements.buildStarted` | startBuild | — |
| `requirements.buildFinished` | finishBuild | **PM 覆盖判断 work** |
| `requirements.verified` | verify 通过 | **archivist 合并 work** |
| `requirements.rejected` | verify 打回 | (回灌原执行 work) |

机制:扩展现 `ProjectWorkHookManager`(只认 create/update/delete op)支持命名迁移信号——Flow action 迁态后显式发 `requirements.<signal>`,hook manager 按事件名匹配 work.hooks[].event。

## 4. 文档与 worktree 模型(上下文怎么传)

### 4.1 需求文档 = 唯一权威上下文(DB 真源 + 文件投影)
- **正文存 RequirementRecord**(DB,location-independent):新增结构化文档字段(markdown,固定段)。这是真源。
- **投影到 `{workspace}/.zero/requirements/{id}.md`**:给用户看 / 可选 git。**不是真源**。
- **注入源是 DB**:work 执行、verify 判断、用户确认 chat —— 全从 DB 注入文档(替代/augment 现 contextPolicy.injectRequirementDetail),**与在哪个 worktree 无关**。
- **讨论结果 / 决策 → 写进文档(DB)**,不写消息流。messages 仅留瞬时轻量来回(可选)。

### 4.2 文档结构(先试,后续调)
```
# {title}
## Intent        (create 时的建议全文)
## Summary       (pick 定型一句话)
## Plan          (plan 阶段的 Orchestrate flow / 计划)
## Coverage      (finishBuild 后的覆盖证据 manifest)
## Decision Log  (每次 verify 通过/打回 + 理由,追加)
```
每个 action 产出/维护对应段(create→Intent,pick→Summary,plan→Plan,finishBuild→Coverage,verify→Decision Log)。

### 4.3 Worktree 模型
- **位置**:`~/.zero-core/projects/{project}/{req-shortId}/`(集中放全局,避免在 workspace 旁被意外改动;替换现 `{workspace}.worktrees/`)。
- **生命周期**:Ready→Plan(pickup)在此建 worktree → 干活 + verify 都在 worktree(lead agent 经 DB 注入文档;代码改在 feature 分支)→ verify 通过 merge feature→main 回原项目 → 清理 worktree。
- **文档不随 worktree 走**:文档一直在 DB;worktree 只承载代码变更。merge 回去的是代码,文档无需"传递"(DB 全程共享)。

> 这解了"worktree 跨边界传文档"问题:DB 真源 → 任意 worktree/session 注入即得,不存在文件搬运。

## 5. 关键架构变更

1. **新建 Flow 工具**(7 迁移 action + `list`/`get`),每个 = transitionStatus + 写文档段 + 发 hook。**工具内不做 PM 委派 / 不做合并。**
2. **拆现 `verify` 工具**:去 delegateTask(PM)+ submitCoverageVerdict + mergeFeatureToMain。Build→Verify 降级为 `finishBuild`;PM 判断 + 合并变 work。
3. **work 重配 hook 订阅**([builtin-work-templates.ts](../../../src/server/builtin-work-templates.ts)):交付 work → `ready`;新增 PM 判断 work → `buildFinished`;新增 archivist 合并 work → `verified`。
4. **需求文档 DB 化**:RequirementRecord 加结构化文档字段(真源);`.zero/requirements/{id}.md` 改为投影(渲染)。各 Flow action 写对应文档段。注入源切到 DB。
5. **worktree 集中化**:[LeadService.pickupRequirement](../../../src/server/lead-service.ts) / GitIntegration 的 worktree 路径从 `{workspace}.worktrees/` → `~/.zero-core/projects/{project}/{req-shortId}/`。
6. **UI(用户操作=未暴露 agent 的 action)**:卡片=入口(基本信息,不放确认按钮——太小不足以判断);确认动作在能展开完整上下文的**详情/chat 视图**里(注入需求文档 DB 内容)。看板无 drag-and-drop。详见 [plan-F4.md](plan-F4.md)。
7. **替换旧工具**:`CreateRequirement`/`CreateRequirementWithDoc`/`verify` → Flow(`create`/`pick`/`finishBuild`+`verify`)。RENAMED_TOOLS back-compat。

## 6. 责任矩阵(谁驱动哪段)

| 阶段 | 驱动 | 机制 |
|---|---|---|
| 建(Found) | agent 工具 | Flow.create(写 Intent)→ `created` |
| 选中(Discuss) | 用户(工具,未暴露) | Flow.pick(建文档+Summary)→ `picked` |
| 定型(Ready) | 用户(工具) | Flow.ready(文档定型)→ `ready` |
| 启动交付 | **hook 自动** | `ready` → fire 交付 work |
| 领取(Plan) | agent 工具 | Flow.plan(建 worktree + 写 Plan)→ `planned` |
| 批计划(Build) | 用户(工具) | Flow.startBuild → `buildStarted` |
| 实现 | agent 工具 | work 内调 Orchestrate(在 worktree,注入 DB 文档) |
| 提交(Verify) | agent 工具 | Flow.finishBuild(写 Coverage)→ `buildFinished` |
| PM 判断 | **hook 自动** | `buildFinished` → fire PM work(注入 DB 文档+manifest) |
| 出 Verify(Closed) | 用户(工具,未暴露) | Flow.verify(写 Decision Log)→ `verified`/`rejected` |
| 合并 | **hook 自动** | `verified` → fire archivist 合并 work(merge 回原项目) |
| 返工 | **hook 自动** | `rejected` → 回灌原执行 work |

三类驱动:① agent 工具(建/领取/实现/提交)② 用户工具未暴露(选中/定型/批计划/出 Verify)③ hook 自动(启动交付/PM 判断/合并/返工)。**本质全是 action,差别只在暴露面。** hook 只 fire work。

## 7. 不变 / 不动

- **Cron / Orchestrate** 通用,不动(Orchestrate 管 Build 阶段多 agent 编排)。
- **Wiki / AgentRegistry** 其它域,不动。
- 状态机合法迁移规则不变,触发者改 Flow action。
- 数据模型:RequirementRecord 加文档字段(不删既有字段)。

## 8. 风险 / 决策

- **返工回路**:`rejected` → 回灌原执行 work;意见写 Decision Log(DB),work 下次被 fire 经注入读到,重走 plan→...→finishBuild。
- **PM work / 合并 work 新 seed**:既有 project 要补 seed,否则 buildFinished/verified 后断链(F3 处理)。
- **hook 事件机制扩展**:hook manager 支持命名信号(方案:emitTransition 或 signal 字段,F2 定)。
- **文档 DB 化迁移**:既有 `.zero/requirements/{id}.md` 文件内容需回填到 DB(一次性 migration,F4/F5 处理);docPath 保留指向投影文件。
- **back-compat**:旧工具名 → Flow(RENAMED_TOOLS)。
- **暴露面**:`create`/`plan`/`finishBuild` 给 agent;`pick`/`ready`/`startBuild`/`verify` 现仅用户(UI)。CONDITIONAL_TOOLS / toolPolicy 表达,不绑角色。
- **文档结构先试**:Intent/Summary/Plan/Coverage/Decision Log 五段为初版,实现后据用感调。

## 9. 分阶段实现计划

每阶段独立可测可提交,三层 tsc + build:lib + vitest + 越界。详见 [plan-Fx.md](.)。

- **F1** — Flow 骨架 + 读(create/list/get;created 走现成 op=create)。
- **F2** — 迁移 action(pick/ready/plan/startBuild/finishBuild/verify)+ 命名 hook 信号机制。**含文档 DB 字段 + 各 action 写对应段。**
- **F3** — 拆 verify + work 重配 + 替换旧工具 + **worktree 集中化(~/.zero-core/projects/...)** + 返工回路。
- **F4** — UI 接入(卡片=入口,确认在详情/chat,注入 DB 文档)+ **文档 DB 化迁移(回填既有文件)**。
- **F5** — 清理(删旧文件 + 注释 + code-graph + 全回归)。

## 10. 相关

- 现状代码权威:[requirement-store.ts](../../../src/server/requirement-store.ts)、[requirement-state-machine](../../../src/server/)、[project-work-hook-manager.ts](../../../src/server/project-work-hook-manager.ts)、[builtin-work-templates.ts](../../../src/server/builtin-work-templates.ts)、[verify-tool.ts](../../../src/runtime/tools/verify-tool.ts)、[pm-service.ts](../../../src/server/pm-service.ts)、[lead-service.ts](../../../src/server/lead-service.ts)。
- 关联设计:[agent-context-fields](../agent-context-fields/agent-context-fields.md)、[runtime-push-ui-sync](../runtime-push-ui-sync/runtime-push-ui-sync.md)。
