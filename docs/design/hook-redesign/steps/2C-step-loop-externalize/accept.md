# Step 2C · executeStream 外置 step 循环 + OnLLMError + step 级重试(accept)

> sub2 客观判定。本步是引擎核心,测试要覆盖正向 + 重试 + abort。

## 范围核对
`git diff --name-only HEAD` —— 主要 agent-loop.ts(+可能 turn-recorder.ts)。不应动 resume(2D)、deferred/dangling(2E)、turn 表(P4)。

## 验收项

### A1. 编译 + 全量测试 green(含回归)
```
npx tsc -p tsconfig.cli.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
npm run build:lib
npx vitest run
```
**m3-orchestrate 必须全绿**(多 step tool-use 链路)。

### A2. 多 step tool-use 走外置循环(新单测)
`tests/unit/step-loop-external.test.ts`(用 mock provider):
1. 模型第 1 步调工具 T → 拿 result → 第 2 步调工具 U → 拿 result → 第 3 步 text 结束。断言:外置 while 跑了 3 轮 streamText,StepEnd fire 3 次,每步 messages 正确累积(tool-call/result 配对),最终 turn 正常完成。
2. **注入在下一 step 生效**:PreLLMCall handler 第 2 步起返回 appendMessages(user msg)→ 该 msg 出现在第 2 步发给模型的 messages 里(不是第 1 步)。

### A3. 单步重试只重跑该 step(新单测)
mock provider:第 1 步成功,第 2 步第 1 次抛 rate_limit、第 2 次成功,第 3 步成功。断言:
- OnLLMError fire 1 次,errorClass="rate_limit"。
- 第 1 步**不重发**(其 tool-call/result 在 messages 里只出现 1 次)。
- 第 2 步重试 1 次后成功。
- 最终 turn 完成,messages 正确。

### A4. fatal 不重试(新单测)
mock provider 抛 auth 错 → OnLLMError fire → 不重试 → 抛 TurnError → turn 失败处理(TurnError hook 触发,如落库 partial)。

### A5. abort 在 step 边界(新单测)
外置循环跑第 2 步前 abort() → 循环 break,不进第 2 步;第 1 步已落库。

## 通过判定
A1(含 m3)+ A2 + A3 + A4 + A5 全过 → PASS。

## FAIL 反馈格式
```
FAIL · Step 2C
- 失败项: <A1-A5 + 具体 case>
- 命令: <...>
- 证据: <events 顺序 / messages 实际 vs 期望 / m3 失败详情>
```
