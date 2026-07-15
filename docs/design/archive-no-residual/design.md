# Design: archive-no-residual

- **状态**:② design(讨论细化)
- **关联**:[issue.md](./issue.md)

## 目标(两条不变式,零遗留)

1. **任务结束**:`delegated_tasks` 行删除,指向的子 session 归档。
2. **父 session 归档**:它派发的 `delegated_tasks` 行删除,这些行指向的子 session 归档(递归)。

## 已实现(无需重做)

用户设计后两点已落地于 [archive-service.ts](../../src/server/archive-service.ts):

| 用户设计点 | 现状 | 位置 |
|---|---|---|
| ② 先标记归档 → 调 LLM → 完成后 JSON 出表 | `archiveSession`:`markArchivedTransient` → memory ephemeral turn → 原子 export(tmp→parse→rename→`deleteSessionData`) | [archive-service.ts:327-430](../../src/server/archive-service.ts#L327-L430) |
| ③ 启动恢复被打断的归档 | `recoverInterruptedArchives(db)`,`index.ts` 启动扫 `archived=1 且仍有行` 重 export | [archive-service.ts:599](../../src/server/archive-service.ts#L599) |

即 session 归档本身**已是崩溃可恢复的二级缓冲**。本 effort 不重写它,只补「**行删除与慢归档解耦**」+「**触发接线**」+「**父归档级联**」三处。

## 决策

### D1. 行删除与慢归档解耦(用户点 1)— **推荐 A2**

terminal 时**立即**删 `delegated_tasks` 行,但与归档触发的依赖关系要理清:

- [archiveDelegatedSession:987-989](../../src/server/agent-service.ts#L987-L989) 归档时要从行里读 `sessionId`/`targetAgentId`/`modelId`;
- [fireOnTaskTerminal:262](../../src/runtime/subagent-delegator.ts#L262) 已先 `getDelegatedTask(taskId).sessionId` 拿到 childSessionId。

**所以顺序必须为:先捕获 childSessionId(+ agent/model),fire 归档(fire-and-forget),再删行**(同 tick)。删行不能早于捕获,否则归档拿不到子 session 信息。

**A1(仅解耦)**:terminal handler 捕获 childSessionId + agent/model → 透传给归档回调(回调不再回读行)→ fire 归档 → 删行。
- 优点:最小改动。
- 缺点:**归档从未触发**(Gap A 未修 / 崩在 fire 之前)时,行没了、子 session 留下成孤儿,且 sessions 表无 parent 链接,**启动扫描发现不了**。

**A2(解耦 + terminal 时打 session mark)— 推荐**:terminal handler 捕获信息 → **同步 `markArchivedTransient(childSessionId)`**(复用现有 `archived=1` 瞬态列,廉价 DB 写)→ fire 归档 → 删行。
- 归档正常跑:管线 ② 再 mark 一次(idempotent,no-op)→ memory turn → export → `deleteSessionData`(行+mark 一起清)。
- 归档从未触发 / 崩在异步段前:**session 行仍带 `archived=1`** → 现有 `recoverInterruptedArchives` 启动时重 export + 删行。**零遗留、自愈,不依赖 Gap A 是否修好**。
- 代价:**recovery 路径不再能区分「memory turn 已跑」与「从未跑」**——从未触发的子 session 走 recovery 时会**跳过 memory turn** 直接 export。但这类是异常路径(crash / 接线漏);其 mid-turn 压缩(若有)已写 wiki,损失的只是「agent 终态前的那一轮自写记忆」,steps 仍完整导出到 JSON。可接受。
- **无需 schema 变更**(复用 `archived` 列)。

> `killed` 路径(父主动停,非完成)不在 `fireOnTaskTerminal` 内(delegator 注释 L250-252);其行删除已由 `abandonTask`/`acknowledgeTask` 调 `deleteDelegatedTask` 覆盖(已落地)。本 sub 只管 `completed`/`failed`。

### D2. Gap A:terminal 归档触发接线补全

`archiveDelegatedSession` 只在 [createLoopForSession:1385](../../src/server/agent-service.ts#L1385) 接线;[sendProjectPrompt lazy-rebuild:1654](../../src/server/agent-service.ts#L1654) 漏接 → 该 loop 派的子 agent 终态时 `onTaskTerminal=undefined` → [delegator:261](../../src/runtime/subagent-delegator.ts#L261) 早退 → 永不归档(264 行累积根因)。

- **B1(最小)**:在 sendProjectPrompt lazy-rebuild 处镜像 L1385 补 `sessionConfig.archiveDelegatedSession = ...`。
- **B2(DRY)**:抽共享 `buildAndRegisterLoop(sessionConfig, ...)` 给两处共用,接线写一次,防未来再分叉。
- **推荐 B1**(改动小、风险低、定位准);B2 作为可选清理(本 effort 不强求,避免扩大面)。即便只做 D1 的 A2,Gap A 不修也不会留遗留(只是那些子 session 走 recovery、丢 memory turn),但为**正确性**(memory turn 真跑)应修。

### D3. Gap C:父 session 归档级联

D1 的 A2 落地后,终态子任务的行**立即删** → 父归档时按 `parent_session_id` 能查到的多是**仍在跑**的子任务(行还在)。父归档应:

1. `listDelegatedTasks({parentSessionId: 父})` 拿到这些子任务(查询能力 [session-db.ts:1708](../../src/server/session-db.ts#L1708) 已有);
2. 逐个 kill/abandon(让子走到 terminal)→ terminal handler 接 D1 路径(打 mark + fire 归档 + 删行);
3. 递归:子若也派了子,`parent_task_id`/`root_task_id` 链表递归(实际上 kill 会让每一层各自走 terminal,天然递归)。

挂载点:`archiveSession` 的 teardown 段(活跃 session 手动归档)前,或新增 `archiveChildrenOf(parentSessionId)` 在管线入口调。**推荐**:在 `archiveSession` 入口加一步 `await archiveChildrenOf(sessionId, db)`(teardown 之前),内部 list + kill,kill 触发各层 terminal → 自归档。chat 手动归档路径受益;delegated 子 session 自身归档时它的子也递归归档。

### D4. cleanup-TTL(e82311c band-aid)去留

D1 后终态行不再累积(立即删)→ TTL 无 completed 行可清。

- registry 内存侧清理(aging out TaskInfo)仍有用(防内存膨胀),与 DB 无关。
- **推荐**:保留 `taskRegistry.cleanup()`(内存卫生),其 `deleteDelegatedTask` 调用变 idempotent no-op(行已删)——**纯安全网,不删**。或顺手把 cleanup 里的 DB 删去掉(行已立即删,没必要)。倾向**保留不动**(idempotent,零风险)。

### D5. 孤儿子 session 兜底(存量 + 未来)

- **存量**(D1 修前累积的孤儿 session,行已不在):sessions 表无 parent 链接,启动扫描**无法识别**它们是委托子 session。
  - **推荐**:一次性 sweep——启动 `recoverInterruptedArchives` 之后,补一个启发式清理:`is_main=0 且 updated_at 早于 N 天 且 非任何 active agent 的当前 session` 的 session 视为孤儿,归档或删。**或**干脆不动(存量已手清 374 行,子 session 数据量小,可接受留档)。倾向**不自动清存量**,只在新管线保证零新增遗留;若用户要,再补 sweep sub。
- **未来**:D1 的 A2 保证 terminal 时已打 mark → 任何未归档子 session 都被 `recoverInterruptedArchives` 兜底。**未来零新增孤儿**。

## 拆分预案(plan 阶段细化)

1. **sub-1(D1+A2)**:terminal 解耦删行 + 同步打 mark。改 `fireOnTaskTerminal`/`archiveDelegatedSession`(透传 agent/model,不回读行)+ 删行时机。验收:completed/failed 后行立即消失、子 session 带 `archived=1`、归档完成后行+mark 清。
2. **sub-2(D2)**:sendProjectPrompt lazy-rebuild 接 `archiveDelegatedSession`。验收:该 loop 派的子 agent 终态后归档真触发(源码 grep + 集成测试)。
3. **sub-3(D3)**:父归档级联 `archiveChildrenOf`。验收:父归档时仍在跑的子任务被 kill + 子 session 归档 + 行删,递归。
4. **sub-4(D4/D5 收尾)**:cleanup-TTL 定性 + (可选)存量 sweep。验收:文档 + 回归。

## 待用户拍板(进 plan 前)

1. **D1 选 A1 还是 A2?**(推荐 A2:零遗留自愈、无需 schema 改;代价是异常路径丢 memory turn)
2. **D2 选 B1 还是 B2?**(推荐 B1)
3. **D3 父归档级联**:kill 仍在跑的子任务,还是只归档「已终态但未归档」的?(推荐前者:父没了,子不应继续跑)
4. **D4 cleanup-TTL**:保留作安全网(推荐)还是清掉 DB 删段?
5. **D5 存量孤儿 session**:不动(推荐,已手清)/ 加启动 sweep?

> design 决策点钉死、对抗式 review gap 后,再进 ③ plan。**跳转本身需用户显式确认。**
