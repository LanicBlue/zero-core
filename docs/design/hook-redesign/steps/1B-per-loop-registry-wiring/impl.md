# Step 1B · per-loop registry 接线 + registerHooksForLoop + 去 requirement(impl)

> sub1 只读本文档。事件名本步**不 rename**(那是 1C),只做 registry 实例化接线。

## 背景
1A 已让 HookRegistry 可实例化。本步把 agent-loop 切到 per-instance registry,用 `registerHooksForLoop(registry, loopKind, deps)` 按 loop 类型注册,退役全局 `registerAllRuntimeHooks`。顺带**不再注册 requirement-hooks**(workflow 域,§5.5)。handler 仍挂旧事件名(SessionStart/Stop/PreLLMCall 等),1C 才统一改名。

## 目标
1. AgentLoop 构造期 `this.registry = new HookRegistry()`;所有 `triggerHooks(E, ctx)` 改走 `this.registry.trigger(E, {...ctx, loopKind, timestamp})`(加 `triggerLocal(E, ctx)` helper 自动补 loopKind+timestamp)。
2. `SessionConfig` 加 `loopKind?: "main" | "delegated"`(默认 main);subagent-delegator 建子 loop 时置 `"delegated"`。
3. 新增 `registerHooksForLoop(registry, loopKind, deps)`:`src/runtime/hooks/index.ts` 重写此函数,按 kind 注册(shared / main-only / delegated-only,清单见 spec §6);**requirement-hooks 不注册**。各 hook 模块 register 函数收 `registry` 形参(不再 `HookRegistry.getInstance()`)。
4. agent-service 建主 loop 后调 `registerHooksForLoop(loop.registry, "main", deps)`;subagent-delegator 建子 loop 调 `registerHooksForLoop(loop.registry, "delegated", deps)`。
5. `server/index.ts` 退役 `registerAllRuntimeHooks` 调用(及 requirement-hooks 注册);durable/tool-execution/metrics/workflow-context 等服务端 hook 也改为经 `registerHooksForLoop` 的 deps 注入(它们需要 SessionDB/stores,deps 透传)。

## 要改的文件
- `src/runtime/types.ts`(SessionConfig.loopKind)
- `src/runtime/agent-loop.ts`(this.registry + triggerLocal + 传 loopKind;**事件名不改**)
- `src/runtime/hooks/index.ts`(registerHooksForLoop)
- `src/runtime/hooks/*.ts` + `src/server/*-hooks.ts`(register 函数收 registry 形参)
- `src/server/agent-service.ts`(建 loop 后 registerHooksForLoop main + 注入 deps)
- `src/runtime/subagent-delegator.ts`(子 loop loopKind=delegated + registerHooksForLoop delegated)
- `src/server/index.ts`(退役全局注册;组装 deps 传 agent-service)

## 边界(不要做)
- ❌ 不改任何事件名(SessionStart/Stop/PreLLMCall/PrepareStep/PostStep/PostTurnComplete 等保持原名)—— 1C 做。
- ❌ 不加 agent-service 的 Session 级 fire(SessionStart/SessionClose 新语义)—— 1C 做(避免与 agent-loop 现有 per-run SessionStart 撞名双触发)。
- ❌ 不动 compression/extraction/todo 的挂载点(仍 PostTurnComplete)—— P3 做。
- ❌ 不删 requirement-hooks.ts 文件(只不注册;文件留着,标注 legacy,随 workflow 退役再删)。
- ❌ 不删 `getInstance()`/`triggerHooks()`(仍可能有零散调用,1C 末或后续清)。

## 自检
- typecheck 三层 + build:lib + vitest 全 green。
- 注意:vitest 里若有依赖 requirement-hooks 触发(plan→build、autoPickup)的测试可能红 —— 这些测试随 requirement 退役应一并删除/改写(属本步范围)。
