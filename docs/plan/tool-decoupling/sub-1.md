# sub-1:基建 + 工具搬层(无行为变化)

> 决策 0/1/2/3 的地基。纯搬运 + 类型 + 单例注册,不改任何工具行为。对应 design 决策 0/1 + G1/G2 类型。

## 任务

1. **新类型**(`src/tools/types.ts` 或 `src/runtime/types.ts`):
   - `CallerCtx`(身份 + host 注入项 + per-session 访问器 + emit;见 design 最终形态)。
   - `ToolStreamEvent`(`{type, text?, data?}`)。
   - `ToolResult<T>` 约定(结构化 JSON 返值)。
2. **工具 meta 加 `exposable` 标记**(`ToolMeta` 加 `exposable?: boolean`;默认按类别)。
3. **服务 getter/setter 单例**:agentService + 各 server store(wikiStore / requirementStore / pmService / sessionDB …)各加 `getXxx()/setXxx()`;启动注册(`server/index.ts` + `cli.ts` 共用注册逻辑)。
4. **搬层**:`src/runtime/tools/` + `src/runtime/mcp-tools/` → `src/tools/`;全仓库 import 路径更新。
5. **format 约定**:`BuildToolOptions` 加可选 `format?(result): string`(工具自带文本 formatter);buildTool 暂不强制。

## 范围(关键:无行为变化)

- 工具仍取旧 `ctx`,buildTool wrapper 行为不变,AgentLoop 仍建 ctx。
- 只铺地基:类型在那、单例注册了、文件搬了、import 改了。
- 既有测试**零改**全过(行为没变)。

## 风险

- 大量 import 路径改动(机械,易漏)→ typecheck + 全套测试把关。
- 单例注册时机:必须在任何工具调用前(server/cli 启动序)。

## 验收

见 `acceptance-1.md`。
