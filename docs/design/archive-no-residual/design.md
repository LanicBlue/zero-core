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

### D3. Gap C:父 session 归档级联(已决策:直接 archive 子 session)

D1 的 A2 落地后,终态子任务的行**立即删** → 父归档时按 `parent_session_id` 能查到的多是**仍在跑**的子任务(行还在)。父归档应把它们一并归档。

**实现陷阱(对抗式 review 发现)**:不能走 kill。`fireOnTaskTerminal` 只对 `completed`/`failed` 触发归档——[delegator:250](../../src/runtime/subagent-delegator.ts#L250) 明确 `killed` **被排除**(killed 设计为 abandoned、父 owns cleanup、不归档)。所以「kill 仍在跑的子任务」走 kill→terminal **不会**归档子 session,反造孤儿,与零遗留矛盾。

**正确做法:直接 archive 子 session**,不走 kill:

1. `archiveSession` 入口加一步 `await archiveChildrenOf(sessionId, db)`(teardown 之前);
2. 内部 `listDelegatedTasks({parentSessionId: 父})`([session-db.ts:1708](../../src/server/session-db.ts#L1708) 查询能力已有)拿所有子任务;
3. 对每个子 session **直接调归档路径**——运行中的带 teardown 停 loop(复用现有 chat 手动归档的 teardown+pipeline 段),已终态的走 delegated 路径(无 teardown);
4. 递归天然成立:每个子 session 进 `archiveSession` → 入口又跑 `archiveChildrenOf` → 孙子层一并归档(按 `parent_session_id`/`root_task_id` 链);
5. 各子任务的 `delegated_tasks` 行由各自归档末尾的 `deleteSessionData` 删(或 D1 已删的 idempotent)。

效果 = 用户意图(父没了、子 session 被归档、零遗留),只是路径是「直接 archive」而非「kill 触发 terminal」。chat 手动归档 + delegated 子自身归档两条路径都受益。

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
3. **sub-3(D3)**:父归档级联 `archiveChildrenOf`(直接 archive 子 session,不走 kill)。验收:父归档时仍在跑的子任务被 archive(运行中的 loop teardown)+ 行删,孙子层递归归档。
4. **sub-4(D4/D5 收尾)**:cleanup-TTL 定性 + (可选)存量 sweep。验收:文档 + 回归。

## 已决策(2026-07-15 用户拍板)

| 决策 | 选定 | 备注 |
|---|---|---|
| **D1** 行删除解耦 | **A2** terminal 同步打 mark | 零遗留自愈,无需 schema 改;异常路径 recovery 跳过 memory turn(可接受) |
| **D2** Gap A 接线 | **B1** sendProjectPrompt 镜像补接 | 改动小、定位准 |
| **D3** 父归档级联 | **直接 archive 子 session**(不走 kill) | 对抗式 review 发现 killed 被排除出 terminal 归档;kill 反造孤儿。运行中的子带 teardown 停 loop |
| **D4** cleanup-TTL | **保留作安全网**(未问,按推荐) | D1 后 DB 删段变 idempotent no-op;保留无害 |
| **D5** 存量孤儿 | **加启动 sweep** | 启发式(is_main=0 + updated_at 早于 N 天 + 非 active agent 当前 session)识别孤儿归档/删 |

决策已钉死。**进 ③ plan 需用户显式确认**(答完决策 ≠ 可进 plan)。
