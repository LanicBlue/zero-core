# acceptance-2:`skill` 工具(按 name 查询 body)

对应 `sub-2.md`。

## 用例

1. **工具存在并注册**:`skill` 在 `ALL_TOOLS`;`getToolExecute("skill")` 返函数;ToolsPage 列表可见。
2. **查询成功**:mock 一个 skill(name="foo", body="正文"),调 `skill({name:"foo"})` → `{ok:true, data:{name:"foo", body:"正文", ...}}`。
3. **查询失败**:调 `skill({name:"不存在"})` → `{ok:false, error:"skill not found: 不存在"}`(或等价明确错误)。
4. **format 可用**:`getToolFormat("skill")(result)` 返可读文本块(含 body),供 agent host。
5. **经 dispatcher 可达**:`dispatchTool("skill", {name:"foo"}, {caller:"ui"})` 返 JSON 结果。
6. **无存量破坏**:typecheck 三层 + vitest 全套绿;新工具不影响其它工具注册顺序/可见性。

## 验证手段

- 单测:mock scanSkills(或临时 skill 目录)+ 直接 execute + dispatcher 两路验证。
- typecheck 三层 + `npm run test`。
