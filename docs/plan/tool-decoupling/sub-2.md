# sub-2:Platform 工具迁(首例 + 修 work/cron bug)

> 决策 1/2/3/4 首个落地范例。迁 Platform 工具到新模型,**删 platformObserver ctx 字段** → 修当前 work/cron 路径漏注入 bug。依赖 sub-1(类型 + 单例)。

## 任务

1. **Platform 工具迁新签名**(`src/tools/platform/*.ts`):
   - `execute(input, callerCtx): Promise<ToolResult>` —— 直读 `getAgentService()` 单例(不经 ctx.platformObserver)。
   - sessions List/Detail、providerStats、logs、info、config、providers 全迁。
   - 返**结构化 JSON**(ToolResult)+ 自带 `format(result): string`(文本,LLM 用)。
2. **buildTool wrapper 支持 migrated 工具**(agent 路径):调 execute 拿 JSON → 套 `format` → 文本喂 LLM(+ 既有 hook/rate/log/截断)。
3. **删 platformObserver**:`SessionConfig.platformObserver` + `ToolExecutionContext.platformObserver` + 所有注入点(`createLoopForSession` / `sendProjectPrompt` / `buildSessionConfigForEviction`)全删。Platform 工具改直读单例。
4. **callerCtx 注入**:AgentLoop 调 Platform 工具时填 `{sessionId, agentId, caller:"internal", workingDir}`。
5. **修 bug**:work/cron(sendProjectPrompt 路径)Platform 工具正常工作(不再依赖注入,直读单例)。

## 范围

- 只迁 Platform 这一组工具(首例,验证模式)。
- 其余工具仍旧 ctx(sub-3/4 迁)。
- buildTool wrapper 同时支持新(JSON+format)和旧(string)返值(过渡,sub-4 后删旧)。

## 风险

- buildTool wrapper 双返值支持(过渡期)—— sub-4 后清理。
- Platform JSON 形态要稳定(后续 UI dispatcher 消费)。

## 验收

见 `acceptance-2.md`。
