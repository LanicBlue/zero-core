# Plan-B:ALL_TOOLS key 派生(单一来源)

> 节点 B(改名一致性)。验收见 [acceptance-B.md](acceptance-B.md)。设计见 [`./tool-rename-consistency.md`](./tool-rename-consistency.md)。

## 目标

`ALL_TOOLS` 的 key 从手写字面量改成从每个工具自身 `__name`(`getToolName(def)`)派生。改名 = 只改工具文件一处 `buildTool({name})`,#1(name 字段)与 #2(ALL_TOOLS key)从结构上不可能不一致。

## 改动

### `src/runtime/tools/index.ts`
- 把 `export const ALL_TOOLS: Record<string, any> = { Shell: bashTool, ... }` 字面量改为:
  ```ts
  const TOOL_DEFS = [
      bashTool, fileReadTool, fileWriteTool, fileEditTool, grepTool, globTool,
      delegateTool, taskStatusTool, taskListTool, taskStopTool, waitTool,
      webSearchTool, askUserTool, todoWriteTool, webFetchTool, sequentialThinkingTool,
      orchestrateTool, projectTool, workTool, agentRegistryTool, cronTool, wikiTool, flowTool,
  ];
  export const ALL_TOOLS: Record<string, any> = Object.fromEntries([
      ...TOOL_DEFS.map((def) => [getToolName(def), def]),
      ...Object.entries(getPlatformTools()),
  ]);
  ```
- **顺序**:TOOL_DEFS 数组顺序 = 当前字面量顺序(见上),platform 工具仍 spread 在末尾。→ `/tools` API 与 UI 列表呈现零变化。
- `getToolName` 已从 tool-factory 导出,确认 import。

### `tests/unit/p2-agent-runtime.test.ts:58-61`
- 源码契约正则 `/Subagent:\s*delegateTool/` 失效(字面量没了)。改为运行时断言:
  ```ts
  test("Subagent tool is the single delegation surface (in ALL_TOOLS)", () => {
      expect(ALL_TOOLS.Subagent).toBe(delegateTool);
      expect(getToolName(delegateTool)).toBe("Subagent");
  });
  ```
  需要 `import { ALL_TOOLS } from "../../src/runtime/tools/index.js"` + `delegateTool` + `getToolName`。注意 index.ts 间接拉 jsdom 的加载问题(见该测试文件头注释:ALL_TOOLS 通过源码文本断言就是因为动态 import 有坑)——若运行时 import 跑不通,退回源码文本断言:断言 `TOOL_DEFS` 数组存在 + 字面量消失(`expect(src).not.toMatch(/^\s*Shell:\s*bashTool/m)`)。**实施时先试运行时断言,不行再用文本兜底,在 acceptance 里记录实际用了哪条。**

## 不在范围
- CONDITIONAL_TOOLS(sub-D 处理)。
- 种子策略/renderer 显示名(由 acceptance-B 的契约测试守,不改结构)。

## 风险
- index.ts 的 jsdom 传递依赖可能让运行时 import ALL_TOOLS 在 vitest vmThreads 下失败(老坑)。预案如上(文本断言兜底)。
- platform 工具顺序:仍 `...getPlatformTools()` 在末尾,与现状一致。
