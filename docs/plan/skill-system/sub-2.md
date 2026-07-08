# sub-2:`skill` 工具(按 name 查询 body)

> progressive disclosure 第 2 段(selection):agent 按需查询 skill 正文。新增一个工具,经 tool-decoupling 落地的纯函数层注册,agent/UI/MCP 三 host 共享。对应 design 方案 A + 决策 1。

## 任务

1. **新工具 `skill`**(`src/tools/skill-tool.ts`,或入 `src/tools/index.ts` 注册):
   - 入参:`{ name: string }`(skill 的 frontmatter name)。
   - 逻辑:调 `scanSkills()` 找 `name` 匹配项(去重后唯一,sub-1 保证)→ 返回 `{ ok:true, data:{ name, description, body, source } }`;找不到 → `{ ok:false, error:"skill not found: <name>" }`。
   - 按 tool-decoupling 约定:`CallerCtx` + `ToolResult<T>` + `format`(format 返回拼好的 name/description/body 文本块,供 agent host 用)。
   - **exposable 标记**:`ToolMeta.exposable = false`(session 内查询,不对 MCP 外部暴露——见 tool-decoupling 设计;不过此工具无副作用,可酌情 true,plan 实施时定)。
2. **工具注册**:进 `ALL_TOOLS` / 工具清单;`getToolExecute` 能取到。
3. **UI dispatcher 暴露**(自动,经 `listDispatchableTools()`):ToolsPage 可见可试。

## 范围

- 只加查询工具;**不改系统提示词文案**(sub-3 才加"调用提示")、**不改 AgentEditor**(sub-4 才加 SkillsSection)。
- agent 此时已能手动调 `skill` 工具查 body(只是 prompt 还没告诉它该调)。

## 风险

- `scanSkills()` 每次调用读盘:工具调用频率低可接受;若性能敏感可加缓存(本 sub 不做,deferred)。
- name 入参大小写/空格:严格匹配 frontmatter name;找不到明确报错。

## 验收

见 `acceptance-2.md`。
