# sub-6:category 修正(Cron/Wait)

> 所属 effort:execution-entry-redesign(详见 [./design.md](./design.md))。
> 依赖:无(独立小改)。

## 范围

修 category 错位:Cron `agent→management`(和 Project/AgentRegistry 一类)、Wait `runtime→task`(Task 配套原语)。仅改 meta.category + ToolCategory 联合类型,不动工具形态。

## 改动

### src/tools/cron-tool.ts
- meta.category:`"agent"` → `"management"`([cron-tool.ts:126](../../../src/tools/cron-tool.ts#L126))

### src/tools/wait.ts
- meta.category:`"runtime"` → `"task"`([wait.ts:66](../../../src/tools/wait.ts#L66))

### src/core/tool-registry.ts ToolCategory 联合类型
- [ToolCategory](../../../src/core/tool-registry.ts#L29) 检查含 `"management"` 和 `"task"`;"management" 若缺则补。

## 不做(scope 边界)

- prompt 互引(sub-7)
- 其他工具 category
- 不改工具功能

## 验证

见 [./acceptance-6.md](./acceptance-6.md)。
