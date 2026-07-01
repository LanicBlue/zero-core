# Step 3A · compression + extraction 改挂 StepEnd(accept)

> sub2 客观判定。

## 范围核对
`git diff --name-only HEAD` —— 不应动 todo/metrics/TurnEnd(3B)、不应删 PostTurnComplete(todo 仍挂它)。

## 验收项

### A1. 编译 + 测试 green
```
npx tsc -p tsconfig.cli.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
npm run build:lib
npx vitest run   # m5-extractors 改写后必须 green
```

### A2. compression per-step 触发(新单测)
`tests/unit/compression-stepend.test.ts`:
1. 构造一个 turn,mock contextUsage 在第 2 步跨过 l1Threshold。
2. 断言:compression 在**第 2 步的 StepEnd**触发(didCompress=true),不是 turn 末。
3. 未超阈值的 step → compressIfNeeded 早返回(didCompress=false)。

### A3. extraction per-step 触发(改写 m5-extractors)
m5-extractors.test.ts 里 8 处 `trigger("PostTurnComplete", …)` → `trigger("StepEnd", …)`(含 contextUsage)。断言:阈值跨过在某 step 的 StepEnd 触发增量抽取,游标推进。

### A4. PostTurnComplete 仍存(防越界)
grep `"PostTurnComplete"` 在 hook-types + agent-loop + todo-cleanup-hooks → 仍存在(本步不删)。

## 通过判定
A1 + A2 + A3 + A4 全过 → PASS。

## FAIL 反馈格式
```
FAIL · Step 3A
- 失败项: <A1-A4 + 具体>
- 证据: <压缩触发时机 / m5 失败详情 / PostTurnComplete 误删>
```
