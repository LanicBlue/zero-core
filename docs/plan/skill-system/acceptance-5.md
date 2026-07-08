# acceptance-5:SkillsPage 双栏 UI + 本软件 skill CRUD

对应 `sub-5.md`。

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

## 验证手段

- 手动/截图:双栏、编辑往返、新建/删除。
- 单测:写路径校验(越界拒绝)+ CRUD 往返。
- 安全 grep:写端点路径校验逻辑存在。
- typecheck 三层 + `npm run test`。
