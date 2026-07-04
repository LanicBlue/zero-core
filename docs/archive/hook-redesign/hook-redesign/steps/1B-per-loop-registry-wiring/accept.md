# Step 1B · per-loop registry 接线 + registerHooksForLoop + 去 requirement(accept)

> sub2 客观判定。全绿 PASS,任一红 FAIL + 证据。

## 范围核对
```
git diff --name-only HEAD
```
不应出现事件名字符串的增删(事件名仍是旧的)。若 agent-loop.ts 里把 "SessionStart" 改成了 "TurnStart" 等 → FAIL(越界,那是 1C)。

## 验收项

### A1. 编译 + 测试 green
```
npx tsc -p tsconfig.cli.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
npm run build:lib
npx vitest run
```
全 0 退出。requirement 相关退役测试已删/改写(不算红)。

### A2. per-loop 隔离(新单测)
`tests/unit/per-loop-registry.test.ts`:
1. 构造 2 个 AgentLoop(或直接 new HookRegistry 模拟 main/delegated),分别 registerHooksForLoop main/delegated。
2. main loop 的 registry trigger "PreLLMCall" → notification/input-queue/metrics 的 handler 命中;delegated loop 的 registry trigger "PreLLMCall" → 这些 main-only handler **不**命中(用 spy 计数)。
3. delegated loop trigger "PrepareStep" → task-control handler 命中;main loop trigger "PrepareStep" → task-control **不**命中。
全绿。

### A3. requirement 不再触发(新单测或 grep)
- grep `registerRequirementHooks` 在 `src/server/index.ts` → 0(不再 startup 注册)。
- 单测:模拟 lead 调 Orchestrate 工具 → 不再自动 plan→build(requirement-hooks 未注册,无副作用)。

### A4. loopKind 透传
读 agent-loop.ts:每个 trigger 的 ctx 含 `loopKind`(取自 `this.config.loopKind ?? "main"`)。subagent-delegator 建子 loop 的 SessionConfig 含 `loopKind: "delegated"`。

## 通过判定
A1 + A2 + A3 + A4 全过 → PASS。

## FAIL 反馈格式
```
FAIL · Step 1B
- 失败项: <A1/A2/A3/A4 + 具体 case>
- 命令: <跑的命令>
- 证据: <关键输出 / 实际 vs 期望>
- 越界(若有): <改了事件名 / 加了 Session 级 fire 等>
```
