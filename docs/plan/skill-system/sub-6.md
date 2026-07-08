# sub-6:SkillsPage 双栏 UI + 本软件 skill CRUD

> 用户浏览/编辑 skill 的主页面。左列表 + 右详情;只有"本软件 skills"(`~/.zero-core/skills/`)可新建/编辑/删除,外部来源只读。对应 design 已定项(UI 形态、可编辑边界、目录)+ 决策 9(分字段编辑)。

## 任务

1. **SkillsPage 改双栏**(`src/renderer/components/skills/SkillsPage.tsx`):
   - 左:skill 列表,按来源分组("本软件 skills" 置顶,外部其下);每项 display name + source 标记。
   - 右:选中 skill 的详情——display name / description / source / body。
   - **body 按需取**(F4):scanner 不持有 body,详情视图经 backend 读真实 SKILL.md 取正文(外部来源只读展示;本软件可编辑)。
2. **本软件 skill 可编辑**(分字段,决策 9):display name / description(frontmatter 字段)+ body(textarea);保存写回 `~/.zero-core/skills/<id>/SKILL.md`(重组 frontmatter + body)。**id=目录名不可改**(仅改 frontmatter display name + body)。
3. **本软件 skill 新建**:按钮 → 用户提供 **id(目录名,path-safe)**+ display name + description + body → 新建目录 + SKILL.md → 列表刷新。
4. **本软件 skill 删除**:删除目录(确认对话框);外部来源**无**新建/编辑/删除按钮(只读)。
5. **后端 CRUD API**(若现 `/api/skills` 只读):加写端点(create / update / delete),**仅限 `~/.zero-core/skills/`**——路径校验拒绝任何 home 之外/外部来源的写操作(安全护栏,绝不破坏 ~/.claude 等)。

## 范围

- 只动 SkillsPage + skill-router 写端点;**不动 agent 配置**(sub-5)、**不动 prompt/虚拟通道**(sub-2/3/4)。
- 编辑保存后,sub-1 scanner 下次扫描读到新元数据(无须重启,scanSkills 每次读盘)。
- **目录形态边界(v1)**:本软件 skill 是目录(SKILL.md 入口 + 兄弟文件 + scripts/),但 **v1 CRUD 只管 SKILL.md 入口**。兄弟文件/脚本的新建编辑**留后续 sub**(用户可手动放文件,scanner 只读入口、agent 经 `[skills]/` 按需读全部文件)。UI 标注此边界。

## 风险

- **写路径安全**:必须校验目标在 `~/.zero-core/skills/` 内,防 `../` 越界写到外部(关键护栏);`resolve` 后比对前缀 + 软链接边界。
- **id(path-safe)vs display name**:目录名=id 必须 path-safe(无空格/特殊字符);display name 可任意。新建时校验 id path-safe、不与已有冲突。
- 删除 = 删整个 skill 目录(含兄弟文件),确认对话框明示。

## 验收

见 `acceptance-6.md`。
