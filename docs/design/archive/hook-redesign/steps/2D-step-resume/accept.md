# Step 2D · step 级 resume + durable step 检查点(accept)

> sub2 客观判定。

## 范围核对
`git diff --name-only HEAD` —— 不应动 2E(deferred/dangling/task)、4A(turn 表 legacy)。若加 DB 列,确认 db-migration 5 处同步。

## 验收项

### A1. 编译 + 测试 green
```
npx tsc -p tsconfig.cli.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
npm run build:lib
npx vitest run
```

### A2. step 级 resume(新单测)
`tests/unit/step-resume.test.ts`:
1. 跑一个 turn 到第 3 step 完成(第 3 StepEnd fire,lastCompletedStepSeq=3)→ 模拟崩溃(不跑第 4 step)。
2. 重启 → doRecoverIncompleteSessions 发现该 session 未 done → resume(lastCompletedStepSeq=3)→ 从第 4 step 续。
3. 断言:前 3 step 的 tool-call/result 在 messages 里只 1 次(不重跑);第 4 step 正常跑;turn 完成。

### A3. 检查点推进(读源码 + 单测)
- 每个 StepEnd 推进 lastCompletedStepSeq(单测:跑 3 step → 检查点值=3)。
- turn 正常结束(TurnEnd)→ 检查点标 done,下次启动不恢复(单测)。

### A4. DB 列同步(若加了 last_completed_step_seq)
grep 确认:db-migration.ts(CREATE+safeAddColumn+*_COLUMNS)、store COLUMNS、shared/types 都有该列。fresh DB 测试 green。

## 通过判定
A1 + A2 + A3 + A4 全过 → PASS。

## FAIL 反馈格式
```
FAIL · Step 2D
- 失败项: <A1-A4 + 具体>
- 证据: <resume 实际重跑了哪些 step / 检查点值 / 列同步缺失处>
```
