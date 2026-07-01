# Step 1A · hook-registry 实例化 + 数组 concat(impl)

> sub1 实现者只读本文档。不要做本文档没写的事。

## 背景
HookRegistry 当前是进程级单例(全局 `getInstance()`),handler 跨所有 loop 触发。本步是 per-loop registry 重构的**基础设施层**:把 registry 改成可实例化的普通类,并修 merge 语义(数组 concat)。**本步不重命名任何 hook 事件、不动 agent-loop / hook 模块** —— 那是后续 1B/1C 的事。本步只动 registry 内部,保持全仓 green。

## 目标
1. `HookRegistry` 可 `new` 出独立实例,实例之间 handler 互不干扰。
2. `trigger()` 对数组字段 concat(不再 last-writer-wins),标量仍 last-writer-wins,`blocked: true` 仍短路。
3. 保留 `getInstance()` 作**过渡**(标 `@deprecated`),供尚未切换的调用方继续用;`triggerHooks()` 全局便捷函数继续工作(内部走默认实例)。后续 1B/1C 会把调用方切到实例,本步不动它们。

## 要改的文件(仅此一个)
- `src/core/hook-registry.ts`

## 实现要点
1. `HookRegistry` 去掉 `private static instance` 单例强制;构造函数 `public`(已经是)。`getInstance()` 保留,加 `/** @deprecated transitional — use per-loop instance (Step 1B) */`,内部仍懒持一个共享默认实例返回(保证未切换调用方不破)。
2. `trigger()` 的 merge 循环改为:
   - 先判 `blocked`(不变)。
   - 对每个 handler 返回对象的每个字段:`if (Array.isArray(v)) merged[k] = [...(Array.isArray(merged[k]) ? merged[k] : []), ...v];` else `merged[k] = v;`。
   - 错误吞掉、log.error(不变)。
3. `trigger()` 签名不变(仍 `async trigger(event, ctx): Promise<AggregatedHookResult>`)。
4. `triggerHooks()` 全局函数签名不变,继续 `HookRegistry.getInstance().trigger(...)` + 补 timestamp(不变)。
5. 文件头注释更新:说明"实例化 + 数组 concat;getInstance 为过渡"。

## 边界(不要做)
- ❌ 不改 `src/core/hook-types.ts`(事件名/loopKind 是 1B/1C)。
- ❌ 不改 `src/runtime/agent-loop.ts` 的 trigger 调用(1B/1C)。
- ❌ 不改任何 `src/runtime/hooks/*` 或 `src/server/*-hooks.ts`(1B/1C)。
- ❌ 不删 `getInstance()` / `triggerHooks()`(过渡保留)。
- ❌ 不动 `blocked` 短路 / 错误吞掉的现有语义。

## 自检(sub1 交工前)
- `npx tsc -p tsconfig.cli.json --noEmit` 等(见 accept)全 green。
- 新写一个临时验证:手算 2 个 handler 各返回 `{appendMessages:[a]}` / `{appendMessages:[b]}` → trigger 结果 `appendMessages` 长度 = 2(由 sub2 的正式单测覆盖,sub1 可先手动确认逻辑)。
