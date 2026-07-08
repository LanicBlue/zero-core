# acceptance-2:Platform 工具迁(首例)

对应 `sub-2.md`。

## 用例

1. **Platform 工具返 JSON**:sessions/providerStats/logs/info/config/providers 的 execute 返结构化 ToolResult(非裸 string)。
2. **自带 format**:每个 Platform 工具有 `format(result): string`,产出 LLM 文本(与今天文本输出等价)。
3. **buildTool 套 format(agent 路径)**:agent 调 Platform → 收到 format 后的文本;JSON 不泄露给 LLM。
4. **直读单例**:Platform 工具 `import { getAgentService }` 直读;**不经 ctx.platformObserver**。
5. **platformObserver 删除**:`SessionConfig.platformObserver` / `ToolExecutionContext.platformObserver` / 三注入点全删(grep 0 命中)。
6. **修 bug(work/cron)**:sendProjectPrompt 路径起的 agent 调 Platform `sessions` 正常返数据(不再 "Session observer not available")。
7. **chat 路径不回归**:chat(sendPrompt)调 Platform 正常。
8. **callerCtx 注入**:AgentLoop 调 Platform 时 callerCtx 含 sessionId/agentId/workingDir。

## 验证手段

- 单测:Platform 工具返 JSON + format 文本;getAgentService() 直读。
- 单测:删 platformObserver 后 work/cron 路径(模拟 sendProjectPrompt)调 sessions 返数据(修 bug)。
- grep:`platformObserver` 全仓库 0 命中。
- typecheck 三层 + vitest(主 cwd)。
