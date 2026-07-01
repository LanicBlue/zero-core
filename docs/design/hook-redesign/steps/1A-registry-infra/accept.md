# Step 1A · hook-registry 实例化 + 数组 concat(accept)

> sub2 验收者只读本文档。你的职责是**客观判定**本步是否达标,不是改代码。全绿 → 报 PASS;任一红 → 报 FAIL + 具体证据,回 sub1 修。

## 范围核对(先确认 sub1 没越界)
grep 确认本步只动了 `src/core/hook-registry.ts`(允许新测试文件):
```
git diff --name-only HEAD   # 应只有 src/core/hook-registry.ts + 新测试文件
```
若动了 hook-types.ts / agent-loop.ts / 任何 hooks 文件 → 直接 FAIL(越界)。

## 验收项

### A1. 编译 + 既有测试 green
依次跑,任一失败即 FAIL:
```
npx tsc -p tsconfig.cli.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
npm run build:lib
npx vitest run
```
全部退出码 0。

### A2. 新单测:数组 concat
新增 `tests/unit/hook-registry-concat.test.ts`,覆盖以下 case(每条独立 test):
1. **concat**:同一 event 注册 2 个 handler,分别返回 `{ appendMessages: [{ role:"user", content:"a" }] }` 和 `{ appendMessages: [{ role:"user", content:"b" }] }`;trigger 后 `result.appendMessages.length === 2`,且顺序 a 在 b 前(注册顺序)。
2. **标量 last-writer-wins**:2 个 handler 都返回 `{ ragContext: "x" }` / `{ ragContext: "y" }`;trigger 后 `result.ragContext === "y"`(后注册覆盖)。
3. **blocked 短路**:注册 3 个 handler,第 1 个返回 `{ blocked: true, reason: "no" }`;trigger 后 `result.blocked === true`、`result.reason === "no"`,且第 2、3 个 handler 没执行(用 spy 计数断言)。
4. **实例隔离**:`new HookRegistry()` 两个实例 r1/r2,r1 注册 handlerA、r2 注册 handlerB;`r1.trigger(E,{})` 只跑 handlerA,`r2.trigger(E,{})` 只跑 handlerB(各自 spy 断言)。
全部 green。

### A3. 过渡兼容
`HookRegistry.getInstance()` 仍可调用且返回可用实例(标 `@deprecated`);`triggerHooks("Notification", {...})` 全局函数仍能跑通(注册一个 handler → trigger → 命中)。

## 通过判定
A1 + A2(4 case 全绿)+ A3 全过 → **PASS**。

## 不通过反馈格式(回 sub1)
```
FAIL · Step 1A
- 失败项: A2.case1 concat
- 命令: npx vitest run tests/unit/hook-registry-concat.test.ts
- 证据: <错误输出的关键行 / 实际 vs 期望>
- 越界(若有): <改了哪些不该改的文件>
```
```
