# Step 3B · todo→StepEnd + metrics 重做 + TurnEnd 闭合 + 删 PostTurnComplete(accept)

> sub2 客观判定。Phase 3 出口。

## 范围核对
`git diff --name-only HEAD` —— 不应动 turns 表 legacy(4A)。

## 验收项

### A1. 编译 + 测试 green
```
npx tsc -p tsconfig.cli.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
npm run build:lib
npx vitest run
```

### A2. PostTurnComplete 彻底删除
grep `"PostTurnComplete"` 在 src → 0(含 hook-types、agent-loop、所有 hook 模块)。

### A3. todo per-step 清理(新单测)
`tests/unit/todo-stepend.test.ts`:agent 完成 todo 列表最后一条在某 step → 该 step 的 StepEnd → clearSessionTodos + emit `todos_update[]`(sessionId 路由)。未全 done 的 step → 不清。

### A4. metrics 读真实 usage(读源码 + 单测)
- grep `messageCount.*50|length.*\/.*4|recordTokenEstimate` 在 metrics-hooks → 0(粗估砸掉)。
- 单测:StepEnd ctx 带 usage{inputTokens:100,outputTokens:50} → metrics 记 100/50(来自真实 usage,非估算)。
- trackSessionStreaming/Idle/Error 分别在 SessionStart/SessionClose/TurnError。

### A5. TurnEnd 边界闭合(新单测)
连续两个 user 输入跑两个 turn → 第二个 turn 的 step 的 turn_group = 第一个 +1(不串)。断言 TurnEnd handler 闭合了第一个 turn_group。

## 通过判定
A1 + A2 + A3 + A4 + A5 全过 → PASS → commit Phase 3。

## FAIL 反馈格式
```
FAIL · Step 3B
- 失败项: <A1-A5 + 具体>
- 证据: <PostTurnComplete 残留位置 / 粗估残留 / turn_group 串号>
```
