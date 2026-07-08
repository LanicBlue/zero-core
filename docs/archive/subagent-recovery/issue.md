# 子代理 session 中断恢复 + 父子同步重设计

> 阶段 ① 问题记录。本文件是讨论与待确认信息的累积点,**未定案**。设计细化时整体 `mv` 到 `docs/design/subagent-recovery/` 并补 `design.md`。

## 背景:崩溃/关闭打断 subagent 后,重启如何恢复

子代理 session 是真实 sessionId、带 `parent_session_id` 落盘的([session-db.ts:189](../../../src/server/session-db.ts#L189)、[:286](../../../src/server/session-db.ts#L286) `session_kind: "chat" | "delegated"`)。turns/step 即时持久化,turn_state 记未完成 turn + `last_completed_step_seq` 检查点。

## 当前行为(问题所在)

重启时 `recoverIncompleteSessions()`([agent-service.ts:1047](../../../src/server/agent-service.ts#L1047))对 `getIncompleteTurns()`([session-db.ts:847](../../../src/server/session-db.ts#L847))返回的**每个** incomplete turn 无差别 `loop.resume()`。`getIncompleteTurns` 只按 `phase` 过滤,**不看 `session_kind`/`parent_session_id`** —— 父子一视同仁。

后果:
1. **委派子 session 被独立 auto-resume,自顾自跑完**,结果无人消费。
2. 父(若也有 incomplete turn)单独 resume,其 pending 委派工具调用被 `synthesizeDanglingToolResultsInPlace`([session.ts:334](../../../src/runtime/session.ts#L334))合成成 `[interrupted]` → 父以为委派失败 → **可能重派 → 重复子**。
3. 父 turn 已完成、后台子还活着的情况:父不进 recovery,子**独自跑完成孤儿**。

一句话:子现在无差别独立 auto-resume,与父脱钩,结果或孤儿或引发重复派发。

## 已对齐的方向(本轮讨论确认)

- **父 session(`session_kind='chat'`)auto-resume 执行**(照旧)。
- **委派子 session(`session_kind='delegated'`)启动一律不 auto-run,冻结在 interrupted**(turn_state 留 incomplete),等父 agent 决定续不续。判别用现成 `session_kind`,不加字段。
- 父 resume 时,把它名下中断子的**状态 + 真实wait时间**作为信息交给父 agent 决策:
  - **真实wait时间 = `now − delegated_tasks.created_at`,含停机时间(wall-clock)**。
  - 阻塞委派:替换 pending 委派工具调用的 `[interrupted]` 合成结果,把"子状态/wait时间/是否续"作为该工具结果返回父 LLM。
  - 后台委派:父当时不 await 它(立即返回 task id)→ 在父 TurnStart 注入 system 前言列中断子。
- 父 agent 决定续 → 懒建子 loop + `loop.resume`(子的 turnSeq/stepSeq);决定不续 → 子 turn_state 标 abandoned。
- 链路靠 `delegated_tasks.parent_tool_call_id`([subagent-delegator.ts:79](../../../src/runtime/subagent-delegator.ts#L79))把父子工具调用对上。

## 待评估的更大改动(3 点,未定案)

用户提出"要不要改动大一点",评估如下:

### 1. turn 想结束时若仍有在跑 task,强制再跑一个 step 让 LLM 调 Wait

- 现状:父 LLM 出 final response → turn 结束,**即便后台子还在跑**([agent-loop.ts](../../../src/runtime/agent-loop.ts) turn 生命周期)。
- 收益:父 turn 在后台子跑完前不结束 → 后台子不再"活过父 turn"变孤儿。**上一轮"父 turn 已完成 + 孤儿后台子 → 不通知"特例基本消失**;崩溃只可能发生在父 mid-Wait(turn incomplete)→ 父 auto-resume 即可。recovery 设计因此塌缩成一条线。
- 代价:每次"本该结束但有子在跑"的 turn 多一轮 LLM(nudge step)。只在有在跑子时触发。
- 落点:PostTurnComplete / finish-step **hook**(符合"功能走 hook"红线)。nudge 一次/turn-end 尝试,不死循环;Wait timeout 兜底。

### 2. Wait 增加"到某时间点"功能(cron 式,不注入 prompt,可打断)

- 现状:`Wait`([tools/wait.ts](../../../src/runtime/tools/wait.ts))已事件驱动(`suspendUntilWake` [task-registry.ts:216](../../../src/runtime/task-registry.ts#L216):timeout + 任一后台子完成即唤醒),但**只有相对 timeout,无"等到时间点"**;`wakeCallback` **纯内存,崩了即丢**。
- 提案:加 `until`(绝对时间点 / cron 式)。与 cron 区别:不注入 prompt(只挂起当前 turn 到点)、可被打断(子完成提前唤醒)。
- 配合第 1 点:长时间后台活用 `Wait until=明天` 挂起,期间 turn 不结束、子完成即打断唤醒。
- **硬成本:durable Wait**。需把 wait 状态(deadline + 等 task_ids)持久化到 turn_state / resume 上下文,`resume()` 见未到点重新挂起。与 durable blocking delegation 同类原语,范围限 Wait 一个工具。

### 3. task 状态注入到 context(范围待定)

- 现状:task 状态**纯 pull**(TaskList/TaskStatus/Wait 返回);`prompt-sections` 无 task 段,不自动注入。
- **上下文消耗实算**:每行 task 摘要 `[task_a1b2] subagent running (turns:5 tokens:1200) tool:Edit` ≈ 18 token,加段头 ≈ 30 token → `≈ 30 + 18N` token/step(N=在跑子数)。放系统提示尾部 cacheBreak 段,每 step 该段及之后全价重计。S=100 step、N=5 → ~12k 全价 token 纯开销;pull 对比平时 0/step,需要时 ~40 token,同一信息开销约注入的 1/10–1/50。
- 候选范围(未定):
  - (a) 缩小:只在 **turn 起步(有在跑子时)+ Wait 唤醒时**注入(约 2 次/后台子生命周期);
  - (b) 原话:每 step 注入(30+18N token/step,cache break);
  - (c) 不注入,纯 pull。

## 待用户确认的信息(用户:"我还有很多先确认的信息")

> 下面是本轮未闭合、阻塞定案的开放问题。用户确认前不进 design。

- [ ] **改动档位**:全做(1+2+缩小 3)/ 1+2 缓 3 / 只做原窄方案(recovery 按 session_kind 冻结 + 父 resume 注入,不动 turn 生命周期与 Wait)?
- [ ] **第 3 点注入范围**:(a) turn 起步+唤醒 / (b) 每 step / (c) 纯 pull?
- [ ] **后台子与父 turn 的实际关系**:实际后台子是否真的会越过父 turn(即"父 turn 完成时仍有活后台子"是否真发生)?若架构上不会(父 loop 会等所有后台子收尾才结束 turn),则第 1 点的必要性要重评 —— 需核实当前父 turn 结束时是否真的不等后台子。**这是最关键的事实确认。**
- [ ] **durable Wait 的持久化载体**:turn_state 复用扩列,还是新表?
- [ ] 父 agent"续子"的动作入口:新增 `Agent action:resume task_id`?
- [ ] 冻结子若父一直没决策(父自身恢复失败),turn_state 留 incomplete 幂等再现,是否接受?

## 关联代码

- 恢复主路径:[agent-service.ts](../../../src/server/agent-service.ts) `doRecoverIncompleteSessions`:1047、`restoreAllSessions`:1104、`recoverIncompleteSessions`:1036
- turn/step 持久化:[durable-hooks.ts](../../../src/server/durable-hooks.ts) StepEnd→advanceStepCheckpoint
- resume 语义:[agent-loop.ts:325](../../../src/runtime/agent-loop.ts#L325)(lastCompletedStepSeq 仅信息性,不跳步)
- 悬挂工具合成:[session.ts:334](../../../src/runtime/session.ts#L334) `synthesizeDanglingToolResultsInPlace`、[:539](../../../src/runtime/session.ts#L539) `normalizeMessages` 剥孤儿 result
- 委派路径:[subagent-delegator.ts](../../../src/runtime/subagent-delegator.ts) 阻塞 `await subLoop.run`:372、后台 delegateTaskBackground、parent_tool_call_id:79
- Wait / 挂起:[tools/wait.ts](../../../src/runtime/tools/wait.ts)、[task-registry.ts:216](../../../src/runtime/task-registry.ts#L216) suspendUntilWake(wakeCallback 内存态)
- session_kind 列:[session-db.ts:189](../../../src/server/session-db.ts#L189)、[:286](../../../src/server/session-db.ts#L286)
- workflow 状态恢复:[recovery.ts:64](../../../src/server/recovery.ts#L64) recoverWorkflowState(正交,业务层)

## 相关记忆

- [[project-recovery-wikistore-startup-race]](recovery 启动顺序 race,已修)
- [[feedback-agent-loop-hooks-only]](功能走 hook)
