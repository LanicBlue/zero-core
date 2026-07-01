# Step 2E · 延迟消费注入 + dangling tool-call 兜底 + tool-call↔task 链接(accept)

> sub2 客观判定。Phase 2 出口。

## 范围核对
`git diff --name-only HEAD` —— 不应动 P3(操作搬移)、P4(turn 表)。

## 验收项

### A1. 编译 + 测试 green
```
npx tsc -p tsconfig.cli.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
npm run build:lib
npx vitest run
```

### A2. control message 延迟消费(新单测)
`tests/unit/deferred-consume.test.ts`:
1. delegated task 置 finishing + controlMessage。
2. PreLLMCall 注入 control message 到 step N → step N **失败重跑**(模拟)→ 重跑时 PreLLMCall 仍注入同一 control message(还在)。
3. step N 成功(StepEnd)→ controlMessage 才被清。
4. 断言:重跑前 controlMessage 非空;StepEnd 后才空。

### A3. insert_now 延迟出队列(新单测)
同 A2 模式:insert_now 入队 → PreLLMCall 注入到失败重跑的 step → 重跑仍在 → StepEnd 成功才出队列。

### A4. dangling tool-call 合成(新单测)
模拟 abort 在工具执行中(tool block status:"running" 无 result)→ 落库路径合成 result `[interrupted]` → getSteps → rebuildFromSteps 合法(不抛错,tool-call 有配对 result)。

### A5. tool-call↔task 链接 + subagent resume(新单测)
1. Agent 工具 dispatch → tool-call block 含 taskId。
2. 父 step 含该 Agent tool-call,模拟中断(dangling)→ resume → 按 taskId 调用 SubagentDelegator.resumeTask → 子任务续跑 → 结果回填父 tool-call 的 result。
3. 断言:**不**重新 invoke(子 task 的 step 历史不重置,从其中断处续)。

## 通过判定
A1 + A2 + A3 + A4 + A5 全过 → PASS → commit Phase 2。

## FAIL 反馈格式
```
FAIL · Step 2E
- 失败项: <A1-A5 + 具体 case>
- 证据: <controlMessage 实际清空时机 / dangling rebuild 报错 / task 是否重新 invoke>
```
