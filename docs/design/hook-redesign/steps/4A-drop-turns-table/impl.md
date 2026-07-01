# Step 4A · 退役 legacy turn API + turn_group 必填 + 迁移 + 合并 turn_seq(impl)

> sub1 只读本文档。前置:Phase 3 完成。原子 green 单元(退役 API 会破调用方,一次改完)。

## 背景
turns 物理表里 step 就是带 turn_group 的行。退役 legacy turn API(appendTurn/getTurns/updateTurnContent/hasStepSchema),turn_group 必填,turn 沦为 step 属性(spec §8)。带数据迁移。

## 目标
1. **session-db.ts 退役 legacy API**:删 `appendTurn`/`getTurns`/`updateTurnContent`/`hasStepSchema`;删所有 `if (hasStepSchema) … else appendTurn` 分支,只留 step 路径(`getSteps`/`appendStep`/`upsertStep`/`replaceStepsFromMessages`/`deleteStepGroup`)。turn_group 列逻辑必填(写入永远带)。
2. **session.ts**:`rebuildFromTurns` 删 legacy 分支,只走 `rebuildFromSteps`;`cachedTurns` 一律 `getSteps`。
3. **turn-hooks / durable-hooks / compression-hooks**:删所有 `if hasStepSchema … else appendTurn` 分支,只走 step。
4. **迁移 db-migration.ts**:确保 `turn_group` 列存在;backfill 旧 rows 的 turn_group(无 turn_group 的:user → turn_group=seq;assistant → turn_group=前一 user 的 seq)。同步 *_COLUMNS(5 处:[[feedback-fresh-db-migrations]])。
5. **合并 turn_seq 追踪**:turn-hooks 与 durable-hooks 各自的 `sessionTurnSeq` Map 合并为一处共用(抽公共模块或挂在 store)。
6. 物理表名 `turns` **不改名**(spec §10 #6:风险高,本次不重命名)。

## 要改的文件
- `src/server/session-db.ts`、`src/server/db-migration.ts`、`src/runtime/session.ts`、`src/runtime/hooks/turn-hooks.ts`、`src/server/durable-hooks.ts`、`src/runtime/hooks/compression-hooks.ts`(+ shared/types 若有 StepRow 字段)

## 边界
- ❌ 不重命名物理表 `turns` → `steps`。
- ❌ 不动 hook 事件名(P1 已定)/ 不外置循环(P2)。
- ⚠️ 5 处列同步必须齐(db-migration CREATE + safeAddColumn + *_COLUMNS / store COLUMNS / shared/types)。
- ⚠️ sessions.db readonly;迁移只读旧数据写新列,backend 占用时不 checkpoint([[feedback-sessions-db-readonly]])。

## 自检
- typecheck + build:lib + vitest green。
- grep `appendTurn|getTurns|updateTurnContent|hasStepSchema` 在 src → 0。
- 手动:旧格式 DB 升级 → 历史会话 rebuild 正确。
