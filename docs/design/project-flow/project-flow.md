# Design:Project Flow(需求→代码合并的统一流转)

> 状态:**Draft,模型已锁定,待分阶段实现**。
> 一句话:**Flow 工具只做状态迁移 + 发 hook 信号;下游动作(PM 判断、archivist 合并、交付执行)全靠 work 订阅对应 hook 反应——不在工具里硬编码。**
> 起源:project 类工具 = Project / Work / Flow 三个(见对话)。Flow 覆盖"需求→代码合并"整条交付链。Cron / Orchestrate 是通用工具,不在本类。

---

## 0. 设计原则(贯穿全程)

1. **工具与 agent 不相关**——工具按域分组,不绑角色。
2. **门控是配置的事**——某个 action 暴露给 agent 还是只给用户,是 toolPolicy/暴露面配置,不是结构差别。"用户确认"本质也是一个工具 action,只是没暴露给 agent(以后改暴露即可)。
3. **Flow 工具只迁态 + 发 hook**——不在工具里编排下游(PM 委派、合并等)。下游全靠 work 订阅 hook。
4. **每步流转带 hook 信号**——发什么、触发什么,纯看 work 的 hooks 配置。

## 1. 背景:现状的问题

现在"需求→代码合并"散在多个工具 + 隐藏的 service 自动逻辑:
- 工具:`CreateRequirement`(建 found)、`CreateRequirementWithDoc`(建 discuss+doc)、`verify`(复合阻塞:Build→Verify + delegateTask 唤醒 PM 判断 + APPROVED 自动 archivist 合并)。
- 隐藏自动:`verify` 工具内串了 PM 委派 + 合并;`LeadService.pickupRequirement`;retired 的 requirement-hooks;交付 work hook 在 `requirements.create`(一建建议就 fire 交付)。

问题:
- agent 没法 `list`/`get` 需求(看不见,没法主动驱动)。
- `verify` 是复合阻塞,把"提交 / PM 判断 / 合并"三件事耦在一个工具里,违反原则 3。
- 交付 work 在 `create` 触发(agent 一提建议就跑交付,绕过用户把关)。
- 流转操作没统一成一类工具,分散。

## 2. 状态机 + action + hook(定稿)

action 按操作语义命名;hook 是该步发的信号(下游 work 订阅用)。每个 action = 状态迁移 + 副作用 + 发 hook。

状态序列:Found → Discuss → Ready → Plan → Build → Verify → Closed。

| action | 迁移 | 现在驱动 | 副作用 | 发的 hook | 以后可 agent? |
|---|---|---|---|---|---|
| `create` | →Found | agent | 轻量建议,不建文档 | `created` | — |
| `pick` | Found→Discuss | 用户 | 选中建议 + 建需求文档 + 绑 docPath | `picked` | 可 |
| `ready` | Discuss→Ready | 用户 | 讨论定型 | `ready`(**fire 交付 work**) | 可 |
| `plan` | Ready→Plan | agent | 领取 + 建 feature worktree | `planned` | — |
| `startBuild` | Plan→Build | 用户 | 批计划开工(现 Orchestrate confirm 门) | `buildStarted` | 可 |
| `finishBuild` | Build→Verify | agent | 做完提交 | `buildFinished`(**fire PM 判断 work**) | — |
| `verify`(通过) | Verify→Closed | 用户 | 合并 | `verified`(**fire 合并 work**) | 可 |
| `verify`(打回) | Verify→返工 | 用户 | 意见回灌,退回 Discuss/Build | `rejected`(**回灌原执行 work**) | 可 |

外加只读:`list` / `get`(观察——agent 现在缺,要补)。

> 命名规范(定稿):
> - `pick` = Found→Discuss(用户选中建议 promote),`plan` = Ready→Plan(agent 领取)——两个不同动作,不混。
> - Build 相关两步:`startBuild`(Plan→Build,发 `buildStarted`,开工)vs `finishBuild`(Build→Verify,发 `buildFinished`,做完)——Started/Finished 不撞。
> - 出 Verify(Verify→Closed/返工)才叫 `verify`,发 `verified`/`rejected`。

## 3. hook 信号词表(权威)

8 个信号,走 data-change-hub,事件名 `requirements.<signal>`:

| 信号 | 触发时机(action) | 默认订阅者(示例,纯看 work 配置) |
|---|---|---|
| `requirements.created` | create(→Found) | (可订阅做去重/通知) |
| `requirements.picked` | pick(Found→Discuss) | — |
| `requirements.ready` | ready(→Ready) | **需求管理 work**(交付执行) |
| `requirements.planned` | plan(Ready→Plan) | — |
| `requirements.buildStarted` | startBuild(Plan→Build) | — |
| `requirements.buildFinished` | finishBuild(→Verify) | **PM 覆盖判断 work** |
| `requirements.verified` | verify 通过(→Closed) | **archivist 合并 work** |
| `requirements.rejected` | verify 打回(→返工) | (回灌意见给原执行 work) |

机制:`ProjectWorkHookManager` 现按 `${collection}.${op}`(op=create/update/delete)匹配。本设计扩展为支持**命名迁移信号**(`requirements.ready` / `buildFinished` / `verified` 等)——Flow action 在迁态后显式发对应命名事件,hook manager 按事件名匹配 work.hooks[].event。

## 4. 关键架构变更

1. **新建 Flow 工具**(7 迁移 action + `list`/`get`),每个 action = `transitionStatus` + 副作用 + 发 hook。**工具内不做 PM 委派 / 不做合并。**
2. **拆现 `verify` 工具**:去掉其 `delegateTask`(PM)+ `submitCoverageVerdict` + `mergeFeatureToMain` 逻辑。Build→Verify 降级为 `finishBuild`(只迁态 + 发 `buildFinished`);PM 判断 + 合并变成订阅 hook 的 work。
3. **work 重配 hook 订阅**(默认 work 模板 `builtin-work-templates.ts`):
   - 需求管理(交付)work:hook 从 `requirements.create` → **`requirements.ready`**。
   - 新增/明确 PM 覆盖判断 work:订阅 **`requirements.buildFinished`**(读 manifest → 判断 → 通过调 `verify` action / 打回)。
   - 新增/明确 archivist 合并 work:订阅 **`requirements.verified`**(mergeFeatureToMain + 清 worktree + 置 closed)。
4. **UI 看板走同一套 action 后端**:用户拖卡 / modal 建 = 调对应 Flow action 的 REST 后端(同一 `transitionStatus` + 副作用 + hook)。用户操作 = 未暴露给 agent 的工具 action(原则 2)。
5. **替换旧工具**:`CreateRequirement` / `CreateRequirementWithDoc` / `verify` → Flow 工具的 `create` / `pick`(+doc) / `finishBuild`+`verify`。RENAMED_TOOLS 加 back-compat 映射。

## 5. 责任矩阵(谁驱动哪段——理清楚)

| 阶段 | 驱动 | 机制 |
|---|---|---|
| 建(Found) | agent 工具 | Flow.create → `created` |
| 选中(Discuss) | 用户(工具,未暴露) | Flow.pick(UI,+doc) → `picked` |
| 定型(Ready) | 用户(工具) | Flow.ready(UI) → `ready` |
| 启动交付 | **hook 自动** | `ready` → fire 需求管理 work |
| 领取(Plan) | agent 工具 | Flow.plan(+worktree) → `planned` |
| 批计划(Build) | 用户(工具) | Flow.startBuild(UI confirm 门) → `buildStarted` |
| 实现 | agent 工具 | work 内调 Orchestrate |
| 提交(Verify) | agent 工具 | Flow.finishBuild → `buildFinished` |
| PM 判断 | **hook 自动** | `buildFinished` → fire PM work |
| 出 Verify(Closed) | 用户(工具,未暴露) | Flow.verify(UI)→ 通过 `verified` / 打回 `rejected` |
| 合并 | **hook 自动** | `verified` → fire archivist 合并 work |
| 返工 | **hook 自动** | `rejected` → 意见回灌原执行 work |

三类驱动:① agent 工具(建/领取/实现/提交)② 用户工具(未暴露给 agent 的 action:选中/定型/批计划/出 Verify)③ hook 自动(启动交付、PM 判断、合并、返工回灌)。**本质全是工具 action,差别只在暴露面(配置)。** hook 只负责"事件 → fire work"。

## 6. 不变 / 不动

- **Cron / Orchestrate** 通用,不动。Orchestrate 仍负责 plan 的多 agent 编排执行(Build 阶段)。
- **Wiki / AgentRegistry** 其它域,不动。
- 状态机本身(requirement-state-machine.ts)的合法迁移规则不变,只是触发者改成 Flow action。
- 数据模型(RequirementRecord 字段)基本不变。

## 7. 风险 / 决策

- **返工回路**:`rejected` 后,意见要回到"原执行 work"让它改了重提。现 verify 工具是同步 delegate 拿 PM 结论返 lead;改 hook 驱动后是异步——`rejected` hook fire 原 work(带意见),work 再走 plan→...→finishBuild。意见注入走 requirement message + work contextPolicy.injectRequirementDetail(已有)。
- **PM work / 合并 work 是否新 seed**:默认 work 模板要加 PM 判断 work + 合并 work(订阅对应 hook),否则 buildFinished/verified 后无人反应。这是 F3 的一部分。
- **hook 事件机制扩展**:hook manager 现只认 create/update/delete op;要支持命名迁移信号。方案:Flow action 发一个带 `signal` 字段的 data-change(或专用 emitTransition),hook manager 按 `requirements.<signal>` 匹配。实现时定。
- **back-compat**:旧 `CreateRequirement`/`CreateRequirementWithDoc`/`verify` 工具名 → Flow(RENAMED_TOOLS);既有 agent toolPolicy 引用这些名的配置自动迁移。
- **暴露面(原则 2)**:Flow 各 action 默认暴露给谁——`create`/`plan`/`finishBuild` 暴露 agent;`pick`/`ready`/`startBuild`/`verify` 现仅用户(UI)。这通过 CONDITIONAL_TOOLS / toolPolicy 表达,不硬绑角色。

## 8. 分阶段实现计划

每阶段独立可测可提交,三层 tsc + build:lib + vitest + 越界。

- **F1 — Flow 工具骨架 + 读**:`create`(→Found,发 `created`)+ `list`/`get`。新建 `flow-tool.ts`,接 RequirementStore。此刻不接旧工具替换(并行存在)。
- **F2 — 迁移 action + hook 信号**:`pick`/`ready`/`plan`/`startBuild`/`finishBuild`/`verify`(通过/打回)action,每个 = transitionStatus + 副作用 + 发对应 hook。扩展 hook manager 支持命名迁移信号。
- **F3 — 拆 verify + work 重配 + 替换旧工具**:删现 `verify` 工具的 PM 委派/合并逻辑;默认 work 模板加 PM 判断 work(订 `buildFinished`)+ archivist 合并 work(订 `verified`);交付 work hook 改 `ready`。替换 `CreateRequirement`/`CreateRequirementWithDoc`/`verify` → Flow,RENAMED_TOOLS back-compat。返工回路验证。
- **F4 — UI 接入**:看板拖卡 / modal / REST 走 Flow action 同一后端;用户操作 = 未暴露 agent 的 action。
- **F5 — 清理**:删旧 requirement-tools / verify-tool 文件、更新注释、code-graph、回归。

各阶段 acceptance 在实现时按本设计 §2/§3/§5 逐条细化。

## 9. 相关

- 现状代码权威:[requirement-store.ts](../../../src/server/requirement-store.ts)、[requirement-state-machine](../../../src/server/)、[project-work-hook-manager.ts](../../../src/server/project-work-hook-manager.ts)、[builtin-work-templates.ts](../../../src/server/builtin-work-templates.ts)、[verify-tool.ts](../../../src/runtime/tools/verify-tool.ts)、[pm-service.ts](../../../src/server/pm-service.ts)。
- 关联设计:[agent-context-fields](../agent-context-fields/agent-context-fields.md)(project 域字段)、[runtime-push-ui-sync](../runtime-push-ui-sync/runtime-push-ui-sync.md)(hook/数据推送基建)。
