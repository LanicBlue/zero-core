# acceptance-6:SkillsPage 双栏 UI + 本软件 skill CRUD

对应 `sub-6.md`。

## 用例

1. **双栏渲染**:SkillsPage 左列表按来源分组(本软件置顶)+ 右详情;选中左项→右显示 name/description/source/body。
2. **外部只读**:外部来源(`source==="user"`)skill 详情区**无**编辑/删除按钮,只读展示。
3. **本软件可编辑**:本软件 skill(`source==="app"`)详情区分字段编辑(name/description + body textarea)+ 保存按钮。
4. **保存写回**:编辑后保存 → `~/.zero-core/skills/<name>/SKILL.md` 内容更新(frontmatter + body 格式正确);重新扫描读到新内容。
5. **新建**:新建按钮 → 创建 `~/.zero-core/skills/<name>/SKILL.md` → 列表出现该项。
6. **删除**:删除(确认)→ 目录消失 → 列表移除。
7. **写路径安全**:CRUD 端点拒绝写到 `~/.zero-core/skills/` 之外的路径(构造 `../` 越界 / 绝对外部路径 → 拒绝 + 错误)。
8. **不破坏外部来源**:全程不写 `~/.claude/skills/` / `~/.agents/skills/`(只读校验)。
9. **无存量破坏**:typecheck 三层 + vitest 全套绿。

## E2E(扩展 `tests/e2e/skills-page.spec.ts`)

现有 spec 只覆盖侧边栏入口 + 页面可见;补 sub-6 行为用例。CRUD 写到 `app.zeroDir/skills/`(tmp,cleanup 清掉,不污染真实 home)。

10. **双栏 + 分组**:进 Skills 页 → 左列表按来源分组、"本软件 skills"(`source==="app"`)置顶、外部其下;选中左项 → 右详情显示 name/description/body。
11. **外部只读**:外部来源(`source==="user"`)skill 选中后,详情区**无**编辑/删除按钮(只读)。
12. **本软件可编辑 + 往返**:本软件 skill 编辑 display name/description/body → 保存 → 重新扫描 → 详情显示新内容(`app.zeroDir/skills/<id>/SKILL.md` 写回正确)。
13. **新建**:新建(id path-safe + display name + desc + body)→ 列表出现该项;再次进页仍在。
14. **删除**:删除(确认)→ 列表移除;再次进页不在。
15. **id 不可改**:编辑模式下 id(目录名)字段只读/不出现(仅改 display name + body)。

**前置(fixture)**:测试种一个已知 app-skill + 至少一个外部 skill(或用 `app.zeroDir` 控制外部来源为空再断言"仅本软件组")。**注意非确定性**:真实 `~/.claude/skills`、`~/.agents/skills` 内容不可控——用例应按 seeded skill 的 id 定位、不断言全局条数;若需确定的外部只读用例,可在 `app.zeroDir` 下伪造外部来源目录(若 scanner 支持环境变量重定向)或跳过外部断言改单测覆盖。

## 验证手段

- 手动/截图:双栏、编辑往返、新建/删除。
- 单测:写路径校验(越界拒绝)+ CRUD 往返。
- 安全 grep:写端点路径校验逻辑存在。
- **E2E**:上述 10–15。
- typecheck 三层 + `npm run test`(含 e2e)。
