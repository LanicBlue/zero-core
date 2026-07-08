# acceptance-5:UI 统一 dispatcher + REST 退场

对应 `sub-5.md`。

## 用例

1. **IPC tool:run**:UI 调 `tool:run({tool:"Wiki", input:{action:"expand",...}})` → 返 JSON。
2. **全工具暴露**:dispatcher 能调任意已迁工具(Platform/Wiki/OS/Task/…);无可见性过滤。
3. **session 工具 UI 调返示例**:UI 调 TodoWrite/Task → 返默认/示例值(无 loop 状态)。
4. **UI 消费者切 dispatcher**:Tool 测试页 + 看板(DashboardPage)从 REST 改调 tool:run,行为不回归(JSON 直渲染)。
5. **UI 侧 REST 退场**:sessions:parents / provider:stats 等 UI 用 REST handler 删(grep 确认);外部 REST 消费者(若有)留薄代理。
6. **三 host 同 execute**:agent(buildTool wrapper)/ UI(dispatcher)/ [MCP 后续] 调同一 `getToolExecute`。
7. **错误处理**:工具抛错 → dispatcher 返结构化错误(UI 不崩)。

## 验证手段

- 单测:dispatcher 调代表工具返 JSON;session 工具返示例。
- 手测/组件测:Tool 页 + 看板经 dispatcher 工作。
- grep:UI 用 REST handler 已删(或留薄代理标注)。
- typecheck 三层(含 web)+ vitest(主 cwd)。
