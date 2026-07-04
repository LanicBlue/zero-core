# plan-F2 — 迁移 action + hook 信号机制

> 节点 F2(依赖 F1)。目标:Flow 补全 7 个迁移 action(每步 transitionStatus + 副作用 + 发命名 hook 信号);扩展 ProjectWorkHookManager 支持命名迁移信号。对应 [project-flow.md](project-flow.md) §2/§3/§8。

## 范围
- Flow 加 action:`pick` / `ready` / `plan` / `startBuild` / `finishBuild` / `verify`(通过/打回)。
- 命名 hook 信号机制:`requirements.{picked|ready|planned|buildStarted|buildFinished|verified|rejected}`。
- ProjectWorkHookManager 扩展:按命名信号匹配 work.hooks[].event。
- **不拆 verify 工具、不替旧工具、不重配 work**(F3)——本阶段只让 Flow 能迁态+发信号+hook manager 能匹配。

## 实现步骤
1. **核实状态机**:读 [requirement-state-machine](../../../src/server/) 拿全状态串(found/discuss/ready/plan/build/verify/closed)与合法迁移;Flow action 的 `transitionStatus(to)` 必须只走合法迁移(非法 → 友好错误)。
2. **hook 信号机制**(关键设计点):状态迁移是 `op=update`,data-change-hub 只发 `requirements.update`,无法区分 picked/ready/... 。方案二选一(实现时定,倾向 A):
   - **A 专用 emit**:在 data-change-hub 加 `emitTransition(collection, signal, id, record)`(或复用 emitDataChange 用虚拟 op=`<signal>`),Flow action 迁态后调它。hub 把 `requirements.<signal>` 当事件名广播。
   - **B 状态映射**:hook manager 收到 `requirements.update` 后读 record.status,按 status→signal 表发派。
   - 选定后,ProjectWorkHookManager 的 `handleDataChange` 扩展:事件名既可能是 `${collection}.${op}`(create/update/delete),也可能是 `${collection}.${signal}`(命名迁移)——按 work.hooks[].event 匹配两者。
3. **Flow 迁移 action**(每个 = transitionStatus + 副作用 + 发信号):
   - `pick`(Found→Discuss):transitionStatus("discuss") + 建需求文档 + 绑 docPath(复用 PmService.createRequirementWithDoc 的文档逻辑,或抽一个 buildReqDoc)。发 `picked`。
   - `ready`(Discuss→Ready):transitionStatus("ready")。发 `ready`。
   - `plan`(Ready→Plan):transitionStatus("plan") + 建 feature worktree(复用 LeadService.pickupRequirement 的 worktree 部分)。发 `planned`。
   - `startBuild`(Plan→Build):transitionStatus("build")。发 `buildStarted`。
   - `finishBuild`(Build→Verify):transitionStatus("verify")。发 `buildFinished`。
   - `verify` 通过(Verify→Closed):transitionStatus("closed")。发 `verified`。
   - `verify` 打回(Verify→返工):transitionStatus 退回 discuss/build。发 `rejected`。
4. **capability 注入**:Flow 的 plan/pick 可能需要 leadService/pmService——核实哪些 action 需要哪些 ctx 依赖,F2 暂按需注入(F3 收口)。

## 关键文件
`flow-tool.ts` · `data-change-hub.ts`(emitTransition)· `project-work-hook-manager.ts`(匹配命名信号)· `requirement-store.ts`(transitionStatus,既有)· `lead-service.ts`/`pm-service.ts`(复用既有方法)

## 不做(留 F3)
- 拆现 verify 工具的 PM 委派/合并逻辑。
- 默认 work 模板重配(交付→ready、加 PM/合并 work)。
- 替换 CreateRequirement/CreateRequirementWithDoc/verify。

## 风险
- 命名信号机制是本阶段核心;选 A 还是 B 影响 hook manager + 所有 action 的 emit 调用。先定再写。
- transitionStatus 的 triggeredBy/comment 参数:Flow action 是通用工具,triggeredBy 用什么(ctx.agentId? "tool"?)F2 暂定,F3 统一。
- worktree 创建(plan action)现在在 LeadService.pickupRequirement 里;Flow 的 plan 复用它还是抽公共方法——避免逻辑分叉。
