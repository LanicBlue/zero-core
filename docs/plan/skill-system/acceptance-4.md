# acceptance-4:SkillsSection(agent 配置)

对应 `sub-4.md`。

## 用例

1. **区段渲染**:AgentEditor 含 `<SkillsSection>`,邻近 ToolsSection。
2. **分组正确**:skills 按来源分组,"本软件 skills"(`source==="app"`)在最上,外部(`source==="user"`)其下。
3. **checkbox 绑定**:勾选某 skill → `form.skillPolicy.enabledSkills` 含其 name;取消→移除。
4. **默认值**:新建 agent 表单 `enabledSkills = []`(全不开,对齐决策 3)。
5. **持久化**:保存 agent → 重新打开,勾选状态从 `AgentRecord.skillPolicy.enabledSkills` 还原。
6. **影响 prompt**:勾选的 skill 经 sub-3 路径进系统提示词 name+desc;调用提示也在。
7. **无存量破坏**:typecheck 三层 + vitest 全套绿;ToolsSection 不受影响。

## 验证手段

- 手动/截图:AgentEditor 渲染、勾选、保存往返。
- 单测(若有 renderer 测试):FormState 字段 + 持久化映射。
- typecheck 三层 + `npm run test`。
