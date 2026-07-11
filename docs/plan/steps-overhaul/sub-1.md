# sub-1:表重建 + sessions 收状态(turn_state 折入)

## 范围
DROP+重建 session 内容/状态表;`turns`→`steps` 正名;sessions 吸收 turn_state(1:1 当前状态);recovery 扫 `sessions.phase`。

## 依赖
无(地基)。

## 改动点
- `src/server/session-db.ts` `initSchema`:`turns`→`steps`;DROP `turn_state`;sessions 加 7 列(权威清单见 design.md「sessions 收状态」):`phase`(DEFAULT `'completed'`)/`last_completed_step_seq`/`source`/`error`/`turn_count`/`step_count`/`token_usage(JSON)`。
- **`turn_seq` 不进 DB**:运行时真相是 in-memory `turn-seq-tracker.ts`(TurnStart 经 `db.getStepCount()` 分配)。
- **`getStepCount()` 读 `sessions.step_count`(非 turn_count)**:原方法名 `getTurnCount` 误导——它原是 `COUNT(*) FROM turns`,数的是**所有行 = 所有 step**(user+assistant),被 `agent-loop.ts:661/678` 拿去分配 stepBaseSeq。sub-1 已**正名为 `getStepCount`**(直接对应所读的 `step_count` 列,消除"Turn"误解)。读 `step_count`(总 step 行数)保语义不变(step seq 分配不漂);读 `turn_count`(只 user turn 数)会让 resume 算错 stepBaseSeq → step 覆盖。`turn_count` 列留给 sub-9 体积 UI(真正的逻辑 turn 计数,= DISTINCT turn_group)。两列都建。
- **计数器 bump 时机**:在 step-row 写入点(`appendStep`/`upsertStep`/`replaceStepsFromMessages`/`deleteStepGroup`/`clearTurns`)bump/重算,**不在 `createTurnState`**——避免 durable TurnStart vs turn-hooks TurnStart 顺序依赖。`replaceStepsFromMessages` 等重建路径用 `COUNT(*)`/`SUM(role='user')` 重算,防压缩后漂移。
- **`checkpoint TEXT(JSON)` 列丢弃(已查证为死代码,2026-07-10)**:唯一写该列的是 `updateTurnPhase`(`session-db.ts:930`),而 `updateTurnPhase` **src 内零 caller**(自带注释"no live caller");该列唯一读点是 `getIncompleteTurns` 的返回字段 `.checkpoint`(`:976`),**零下游消费**(recovery.ts 只读 `.length`,durable-hooks 只读 `.turnSeq`)。直接删列 + 删 `updateTurnPhase` 死方法。(`advanceStepCheckpoint`/`getStepCheckpoint` 名字虽带 checkpoint,实际读写的是 `last_completed_step_seq`,保留语义改名后留用。)
- turn_state 方法(`createTurnState`/`advanceStepCheckpoint`/`completeTurnState`/`failTurnState`/`getIncompleteTurn*`/`abandonInterruptedTurn`)改成 sessions 单行操作;`updateTurnPhase`(零 caller 死代码)删。
- **`cleanOldTurnState` 整体退役**(2026-07-10 定,非"语义替代"):无 per-turn 行可 GC;其 stale 清理职责由 recovery 扫描吸收——启动时 `phase NOT IN ('completed','failed')` 即恢复候选,恢复不了的标 `'interrupted'`/`'failed'`。
- `src/server/db-migration.ts`:sessions 7 新列进 `*_COLUMNS` 数组(⚠️ memory `feedback-fresh-db-migrations`:SqliteStore 列必须同步 *_COLUMNS,否则 fresh DB 缺列)。老 sessions 行 `phase` 默认 `'completed'`(不触发恢复扫描)。
- `src/server/recovery.ts` `scanIncompleteTurns` + `src/server/agent-service.ts` `doRecoverIncompleteSessions`/`getIncompleteTurnSessionIds`:从扫 turn_state 改成扫 `sessions.phase NOT IN ('completed','failed')`。
- `~18 处 SQL 字面量` `FROM turns`/`INTO turns`/`UPDATE turns`/`idx_turns_*` → `steps`(session-db.ts)。
- **过渡不变量(本 sub 落地后、sub-3 前)**:旧压缩路径(`compression-hooks.ts` 的 `syncTurnsAfterCompression`/`replaceStepsFromMessages` + `compression-engine.ts` L1/L2)**保留继续工作**,但作用对象改成 `steps` 表(破坏式 DELETE+重插,过渡期暂违"steps 不可变",sub-3/sub-4 拆除)。本 sub 单独编译 + 测试必须通过——若旧压缩调了被删的 turn_state 方法,就地改读 sessions 单行(不改其破坏式语义)。

## 关键不变量
- 一个 session 至多 1 个 in-flight turn(折叠的理论基础,所有消费点已验证 1:1 等价)。
- 不碰配置表(agents/projects/wiki/tool/provider_usage);`tool_executions`/`delegated_tasks` 一并清。
- 数据不迁移(DROP 重建)。

## 参考
design.md「已定架构」「可行性已验证」。
