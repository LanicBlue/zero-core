# acceptance-2:收口共享建 loop

> 据 [sub-2.md](./sub-2.md) 独立验收。

## 源码断言(grep / 读源码)

1. `new AgentLoop(` 在 agent-service.ts 中**只**出现在 `buildAndRegisterLoop` 内(createLoopForSession 与 sendProjectPrompt 都不再内联)。tempLoop(buildTempMemoryTurnRunner)除外。
2. `registerHooksForLoop(loop.registry, "main", ...)` 在 agent-service.ts 中**只**出现在 `buildAndRegisterLoop` 内。
3. `sessionConfig.archiveDelegatedSession =` **只**出现在 `buildAndRegisterLoop` 内(原 createLoopForSession:1385 那处已移走)。
4. `buildAndRegisterLoop` 内 archiveDelegatedSession 赋值在 `new AgentLoop` **之前**(顺序断言:agent-loop.ts:340 构造时读它)。

## 行为测试(real SessionDB + real AgentService 或最小 loop 工厂)

5. **sendProjectPrompt loop 派子终态后归档真触发**:用 sendProjectPrompt 建一个 loop(agent.subagents 非空)→ 派一个 mock 子任务 → 子 complete → 断言:
   - delegator 的 onTaskTerminal 被调用(loop 建出时即非 undefined)。
   - 子 session 行最终消失(archive 管线 deleteSessionData 跑过)或带 archived=1(sub-1 mark)。
6. **createLoopForSession 回归**:chat 路径建 loop → 派子 → 终态归档,行为与收口前一致(不回归)。
7. **fireSessionStart 仍 fire 一次**:建 loop 后 fireSessionStart 被调一次(main),不重复(loop 复用路径不重复建)。
8. **loop 复用**:`this.loops.get(sessionId)` 命中时不调 buildAndRegisterLoop(不重建、不重复 fireSessionStart)。

## 回归

9. 既有 agent-service / loop 构造相关测试全绿。
10. `npm run build:lib`(tsc)类型绿。
