# acceptance-1:基建 + 工具搬层

对应 `sub-1.md`。

## 用例

1. **类型存在**:`CallerCtx` / `ToolStreamEvent` / `ToolResult` 类型定义可 import。
2. **exposable 标记**:`ToolMeta` 有 `exposable?` 字段;工具可标。
3. **getter/setter 单例**:agentService + 各 server store 有 `getXxx()/setXxx()`;启动后 `getAgentService()` 返实例(非 undefined)。
4. **CLI 注册**:cli.ts 启动路径也注册单例(headless 数据工具可用)。
5. **搬层完成**:`src/runtime/tools/` + `src/runtime/mcp-tools/` 不存在;工具在 `src/tools/`;全仓库 import 更新。
6. **无行为变化**:既有测试**零改**全过(typecheck 三层 + vitest 全套 baseline)。
7. **format 约定**:`BuildToolOptions` 接受可选 `format`(暂不强制用)。

## 验证手段

- typecheck 三层 + vitest 主 cwd 全套(baseline 全绿,零行为变化)。
- grep:`src/runtime/tools/`、`src/runtime/mcp-tools/` 目录不存在。
- 单测:getAgentService() 启动后非 undefined;CallerCtx 类型可构造。
