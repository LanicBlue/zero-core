# sub-5:UI 统一 dispatcher + REST 退场

> 决策 4 落地。UI 经统一 dispatcher 调任意工具(全暴露,无可见性策略);UI 侧 REST 退场。依赖 sub-2/3/4(工具已迁 JSON)。

## 任务

1. **IPC `tool:run`**:UI → `ipc.invoke("tool:run", {tool, input, scope?, workingDir?})` → dispatcher。
2. **dispatcher**(server):`getToolExecute(tool)(input, {caller:"ui", scope?, workingDir?})` → JSON 返 UI。
   - 全工具暴露(决策 4:无可见性策略;Tool 页已如此)。
   - session 工具无 loop 状态 → 返默认示例(G1)。
3. **UI 消费者切 dispatcher**:Tool 测试页、看板(DashboardPage)等从 REST 改调 `tool:run`(拿 JSON 直渲染)。
4. **REST 退场**:UI 侧 REST handler(sessions:parents / provider:stats 等给 UI 用的)删;外部 REST 消费者若存在留薄代理。

## 范围

- dispatcher 一个统一入口,取代 UI 用途的所有 REST。
- 不影响 agent 路径(仍走 buildTool wrapper)。
- MCP host 属 external-subagent-mcp,本 sub 不含。

## 风险

- 现有 UI 消费者(Tool 页 / 看板)切换面广 —— 逐个迁,别漏。
- 外部 REST 消费者存在性需确认(无则直接删)。
- dispatcher 错误处理(工具抛错 → UI 收结构化错误)。

## 验收

见 `acceptance-5.md`。
