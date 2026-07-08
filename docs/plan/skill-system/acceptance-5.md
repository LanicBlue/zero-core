# acceptance-5:SkillsSection(agent 配置)

对应 `sub-5.md`。

## 用例

1. **区段渲染**:AgentEditor 含 `<SkillsSection>`,邻近 ToolsSection。
2. **分组正确**:skills 按来源分组,"本软件 skills"(`source==="app"`)在最上,外部(`source==="user"`)其下。
3. **checkbox 绑定**:勾选某 skill → `form.skillPolicy.enabledSkills` 含其 **id(目录名)**(UI 显示的是 display name);取消→移除。
4. **默认值**:新建 agent 表单 `enabledSkills = []`(全不开,对齐决策 3)。
5. **持久化**:保存 agent → 重新打开,勾选状态从 `AgentRecord.skillPolicy.enabledSkills` 还原。
6. **影响 prompt**:勾选的 skill 经 sub-4 路径进系统提示词 name+desc;调用提示也在。
7. **无存量破坏**:typecheck 三层 + vitest 全套绿;ToolsSection 不受影响。

## E2E(扩展 `tests/e2e/p8-wiki-and-agent-config.spec.ts` 或新 `skills-agent-config.spec.ts`)

照抄该文件 subagents/wikiAnchors 的 round-trip 模式(编辑→关→重开→断言持久化)。

10. **区段挂载**:进 Agents overlay → 点 agent → AgentEditor 导航出现 Skills 段(文案随实现,断言 nav 含 skills 段名)。
11. **勾选往返**:Skills 段勾选某 skill → 等待 autosave 落库 → 关编辑器重开 → 该 checkbox 仍勾选(持久化)。
12. **取消移除**:取消勾选 → autosave → 重开 → 该 checkbox 未勾选。
13. **清空回归(关键)**:把已勾的全部取消到空 → 重开 → 仍全空(回归 `[]` vs `undefined`:JSON.stringify 丢 undefined 会使旧值残留,必须显式发 `[]`,对齐决策 5 + `feedback-unique-message-keys` 同类陷阱)。
14. **id 而非 display name**:勾选后,持久化的 `AgentRecord.skillPolicy.enabledSkills` 含的是 **id(目录名)** 而非 display name(经 IPC 读回 / 或 sub-4 prompt 注入断言间接验证)。

**前置(fixture)**:测试需在 `app.zeroDir/skills/<id>/SKILL.md` 种一个已知 app-skill(launch 后写盘 + 点刷新;依赖 sub-1 「scanner 每次读盘」不变式)。**不要**断言外部来源(`~/.claude`、`~/.agents`)的确切条数——真实 home 可能有/无 skill,非确定;只针对 seeded app-skill 按 id 定位。

## 验证手段

- 手动/截图:AgentEditor 渲染、勾选、保存往返。
- 单测(若有 renderer 测试):FormState 字段 + 持久化映射。
- **E2E**:上述 10–14。
- typecheck 三层 + `npm run test`(含 e2e)。
