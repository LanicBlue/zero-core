# sub-4:SkillsSection(agent 配置)

> per-agent skill 开关入口。镜像 `ToolsSection.tsx` 的分组 checkbox UI,写入 `skillPolicy.enabledSkills: string[]`(**id=目录名**,非 display name)。对应 design 决策 1/6。

## 任务

1. **`SkillsSection.tsx`**(`src/renderer/components/agents/`):镜像 ToolsSection 布局——按来源分组("本软件 skills" 置顶、其下外部来源),每 skill 一行 checkbox(**显示** display name + description,**值**绑 id=目录名)。
2. **数据源**:从 `skill-router`(`/api/skills`,经 preload)拉 `scanSkills()` 结果;按 `source` 分组。
3. **绑定 form state**:`form.skillPolicy.enabledSkills`(string[] of **id**);勾选=push id,取消=filter 出。对齐 `agent-editor-types.ts` 的 FormState(加 `skillPolicy.enabledSkills` 字段,默认 `[]`)。
4. **AgentEditor 接入**:在编辑器里挂载 `<SkillsSection>`(位置邻近 ToolsSection)。
5. **保存**:FormState → AgentRecord.skillPolicy.enabledSkills 持久化(经现有 agent-store 保存路径,JSON 列)。

## 范围

- 只加 agent 配置区段;**不动 SkillsPage**(sub-5)、**不动 prompt/工具/虚拟通道**(已定)。
- 本软件/外部 skill 在此都只勾选(不编辑正文,编辑在 sub-5)。

## 风险

- 来源分组 label:"本软件 skills" = `source==="app"`;外部 = `source==="user"`(含 ~/.claude + ~/.agents)。核对 scanner 的 source 字段语义。
- **id vs display name 区分**:UI 显示 name、存 id;prompt 过滤(sub-3)按 id 匹配、显示 name。别混。
- id 唯一性依赖 sub-1 的按目录名去重。

## 验收

见 `acceptance-4.md`。
