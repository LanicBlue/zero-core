# Step 4A · 退役 legacy turn API + turn_group 必填 + 迁移 + 合并 turn_seq(accept)

> sub2 客观判定。Phase 4 出口。

## 范围核对
`git diff --name-only HEAD` —— 不应重命名物理表(表名仍 turns)。

## 验收项

### A1. 编译 + 测试 green
```
npx tsc -p tsconfig.cli.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
npm run build:lib
npx vitest run
```

### A2. legacy API 彻底退役
grep `appendTurn|getTurns|updateTurnContent|hasStepSchema` 在 src → 0。读源码确认所有原分支只走 step 路径。

### A3. 迁移正确(新单测)
`tests/unit/turn-table-migration.test.ts`:
1. 造一份"旧格式"临时 sqlite:user/assistant 行**无 turn_group**(或 null)。
2. 跑迁移 → 断言:user 行 turn_group=seq;assistant 行 turn_group=前一 user 的 seq。
3. rebuildFromSteps(迁移后)→ messages 正确还原(user/assistant/tool 配对合法)。
4. fresh DB(空库)建表 → turn_group 列存在 → 写 step 正常。

### A4. 5 处列同步
grep `turn_group` 确认:db-migration.ts(CREATE TABLE + safeAddColumn + *_COLUMNS 数组)、session-db store COLUMNS、shared/types StepRow 都覆盖。

### A5. turn_seq Map 合并
读源码:turn-hooks 与 durable-hooks 不再有各自独立的 sessionTurnSeq Map,共用一处。

## 通过判定
A1 + A2 + A3 + A4 + A5 全过 → PASS → commit Phase 4。

## FAIL 反馈格式
```
FAIL · Step 4A
- 失败项: <A1-A5 + 具体>
- 证据: <legacy API 残留 / 迁移后 rebuild 错乱 / 列同步缺失 / Map 未合并>
```
