# sub-5:SkillsPage 双栏 UI + 本软件 skill CRUD

> 用户浏览/编辑 skill 的主页面。左列表 + 右详情;只有"本软件 skills"(`~/.zero-core/skills/`)可新建/编辑/删除,外部来源只读。对应 design 已定项(UI 形态、可编辑边界、目录)+ 决策 4(分字段编辑)。

## 任务

1. **SkillsPage 改双栏**(`src/renderer/components/skills/SkillsPage.tsx`):
   - 左:skill 列表,按来源分组("本软件 skills" 置顶,外部其下);每项 name + source 标记。
   - 右:选中 skill 的详情——name / description / source / body(只读或可编辑,见下)。
2. **本软件 skill 可编辑**(分字段,决策 4):name / description(frontmatter 字段)+ body(textarea);保存写回 `~/.zero-core/skills/<name>/SKILL.md`(重组 frontmatter + body,保留 frontmatter 格式)。
3. **本软件 skill 新建**:按钮 → 新建目录 + SKILL.md(name/description/body 默认空)→ 列表刷新。
4. **本软件 skill 删除**:删除目录(确认对话框);外部来源**无**新建/编辑/删除按钮(只读)。
5. **后端 CRUD API**(若现 `/api/skills` 只读):加写端点(create / update / delete),**仅限 `~/.zero-core/skills/`**——路径校验拒绝任何 home 之外/外部来源的写操作(安全护栏,绝不破坏 ~/.claude 等)。

## 范围

- 只动 SkillsPage + skill-router 写端点;**不动 agent 配置**(sub-4)、**不动 prompt/工具**。
- 编辑保存后,sub-1 scanner 下次扫描读到新 body(无须重启,scanSkills 每次读盘)。

## 风险

- **写路径安全**:必须校验目标在 `~/.zero-core/skills/` 内,防 `../` 越界写到外部(关键护栏)。
- name 改名 = 目录改名 + SKILL.md frontmatter 同步;核对一致性。
- 路径校验 + 软链接边界:`resolve` 后比对前缀。

## 验收

见 `acceptance-5.md`。
