# Step 2B · per-tool result 即时落库(accept)

> sub2 客观判定。

## 范围核对
`git diff --name-only HEAD` —— 不应动 step 外置(2C)、resume(2D)、dangling 合成(2E)。

## 验收项

### A1. 编译 + 测试 green
```
npx tsc -p tsconfig.cli.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
npm run build:lib
npx vitest run
```

### A2. 即时落库(新单测)
`tests/unit/per-tool-persist.test.ts`:
1. 模拟一个 step,2 个工具 A、B。A 跑完(PostToolUse,带 result)→ **不**触发 finish-step → 查 DB(DB 用 in-memory 或临时 sqlite)→ A 的 tool block 已落库(含 result,status=done)。
2. B 未完成(无 PostToolUse)→ DB 里无 B 的 block。
3. 后续 finish-step(StepEnd)→ 完整 step 落库(含 A+B+usage),A 的 block 不重复(用 upsert 幂等,seq 不变)。

### A3. rebuild 合法
A 完成 B 未完成状态下,若强行 rebuild(getSteps → rebuildFromSteps)→ A 的 tool-call 有配对 tool-result(完成的),不抛错。

## 通过判定
A1 + A2(3 case 全绿)+ A3 → PASS。

## FAIL 反馈格式
```
FAIL · Step 2B
- 失败项: <A1/A2.caseN/A3>
- 命令: <...>
- 证据: <DB 实际内容 vs 期望 / 错误>
```
