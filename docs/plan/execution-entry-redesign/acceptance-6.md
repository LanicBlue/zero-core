# acceptance-6:category 修正

> 对应 [./sub-6.md](./sub-6.md)。

## 功能验收

1. **Cron category = management**:Cron meta.category === "management"。
   - 验证:读 getToolMeta(Cron).category。
2. **Wait category = task**:Wait meta.category === "task"。
   - 验证:读 getToolMeta(Wait).category。
3. **ToolCategory 含 management + task**:联合类型含两项。
   - 验证:typecheck 过 + getToolCategories() 含 management 组与 task 组。
4. **UI 分组正确**:Cron 归 management 组、Wait 归 task 组(和 Project/AgentRegistry 或 Task 同组)。
   - 验证:getByCategory() 输出 或 ToolsPage 分组检查。

## 不破坏验收

5. **Cron/Wait 功能不变**:仅 category 字段变,execute/prompt 不动。
   - 验证:Cron/Wait 现有测试仍过。

## build

6. **typecheck 过**。
