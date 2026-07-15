# sub-2:收口共享建 loop `buildAndRegisterLoop`(D2)

- **决策**:D2 = B2(抽共享建 loop 尾巴,wiring 写一次,物理上不可能再分叉)
- **依赖**:sub-1(回调签名已加宽 childAgentId/childModelId);sub-2 复用该签名接线
- **关联**:[design.md §D2](./design.md)

## 目标

根因不是「漏一行」,是 createLoopForSession 与 sendProjectPrompt **各内联了一份建 loop 代码**,后者抄漏 `archiveDelegatedSession`。收成一个共享方法,两处拼好各自 sessionConfig 后共用——wiring 写一次,防再分叉。

## 改动

### 1. [src/server/agent-service.ts](../../../src/server/agent-service.ts) 新增 `buildAndRegisterLoop`

```
private buildAndRegisterLoop(
  sessionConfig: SessionConfig, agentId: string, sessionId: string,
): AgentLoop {
  // 须在 new AgentLoop 之前:agent-loop.ts:340 构造时读 config.archiveDelegatedSession
  // 赋给 delegator 的 onTaskTerminal。
  sessionConfig.archiveDelegatedSession = (taskId, _status, childSessionId, childAgentId?, childModelId?) => {
    this.archiveDelegatedSession(taskId, childSessionId, childAgentId, childModelId)
      .catch((err) => log.warn("agent", `archiveDelegatedSession failed (task=${taskId}, child=${childSessionId}):`, ...));
  };
  const loop = new AgentLoop(sessionConfig, this.providerConfigs, {
    onEvent: (event) => this.handleRuntimeEvent(agentId, event),
  });
  registerHooksForLoop(loop.registry, "main", this.buildHookDeps());
  this.loops.set(sessionId, loop);
  void this.fireSessionStart(loop, agentId, sessionId, "main");
  return loop;
}
```

### 2. createLoopForSession 改用共享方法

[createLoopForSession:1246](../../../src/server/agent-service.ts#L1246):保留 sessionConfig 组装(chat 版:contextBundle 从 sessionRec、subagents/resolver 等),删掉内联的 [:1385 接线](../../../src/server/agent-service.ts#L1385) + [:1395 new AgentLoop](../../../src/server/agent-service.ts#L1395) + [:1405 hooks](../../../src/server/agent-service.ts#L1405) + loops.set + [:1435 fireSessionStart](../../../src/server/agent-service.ts#L1435),改为 `return this.buildAndRegisterLoop(sessionConfig, agentId, sessionId)`。

### 3. sendProjectPrompt lazy-rebuild 改用共享方法

[sendProjectPrompt:1654-1667](../../../src/server/agent-service.ts#L1654-L1667):
```
let loop = this.loops.get(sessionId);
if (!loop) {
  loop = this.buildAndRegisterLoop(sessionConfig, agentId, sessionId);
}
```
删掉内联的 new AgentLoop + registerHooksForLoop + loops.set + fireSessionStart(全部进共享方法)。**archiveDelegatedSession 由共享方法补上**——这是修 Gap A 的落点。

### 4. 注释

删 delegator [L253-258](../../../src/runtime/subagent-delegator.ts#L253-L258) 自相矛盾段(sub-1 已要求重写;此处确认所有派发 loop 都接线,不再有「cron/main 不 set」特例)。

## 不做(out of scope)

- 父归档级联 → sub-3。
- 子 agent dispatch 的实际归档行为(memory turn / export)——沿用现有 archive-service,不改。
- `tempLoop`(buildTempMemoryTurnRunner:1059)不派子,不接 archiveDelegatedSession,不动。
- `subagent-delegation.ts:80/189` 的 subLoop(子自身)——子若再派孙,其 config 由 delegator 组装;本 sub 只收口**父 loop**两处建点。孙层归档由 sub-3 级联覆盖。

## 验证要点

- 收口后 createLoopForSession 与 sendProjectPrompt **不再各自内联** new AgentLoop + hooks + fireSessionStart(grep 全 src 这三调用只出现在 buildAndRegisterLoop + tempLoop + 子 delegation + cli)。
- sendProjectPrompt 建出的 loop 的 delegator `onTaskTerminal` 非 undefined。
