# sub-7:git URL 安装第三方 skill

> 用户在 SkillsPage 给 git URL → 系统 `git clone` + auto-detect 多 skill 布局 → 装到 `~/.zero-core/skills/`。对应 design 决策 10 + A1(多 skill auto-detect)+ A2(重名整批拒绝)。

## 任务

1. **SkillsPage「从 git 安装」入口**:button → 弹窗输入 git URL(+ 可选 display name 覆盖,不强制)→ 异步执行。
2. **后端新端点**(skill-router):`POST /api/skills/install-git` `{ url }` → 系统 `git clone` URL 到临时目录。
3. **auto-detect 布局**(不递归,只根 + 一层子目录):
   - repo 根有 `SKILL.md` → 单 skill,id = repo 名(path-safe 化)。
   - 直接子目录各有 `SKILL.md` → 多 skill,id = 各子目录名。
   - 两者并存 → 都装(id = repo 名 + 各子目录名)。
   - 一个都没 → 报错「未检测到合法 skill」。
4. **原子性**:任一目标 id 与现有 `~/.zero-core/skills/` 同名 → **整批拒绝** + 清理临时 clone(对齐 A2,多 skill 时一个冲突全拒)。
5. **校验**:clone 后跑 scanner 解析每个检测到的 skill(合法 SKILL.md + 合法 frontmatter);任一失败 → 回滚(删临时 clone,不落盘)+ 报错。
6. **落盘**:校验通过 → 把 skill 目录移到 `~/.zero-core/skills/<id>/`;**保留 `.git`**(为未来 pull,虽 v1 不做更新 UI)。
7. **UI 反馈**:安装中 loading 态;成功 → 刷新列表;失败 → 提示原因(重名 / 无 SKILL.md / clone 失败 / frontmatter 非法)。
8. **E2E**:按 `acceptance-7.md`。

## 范围

- 只动 SkillsPage 安装入口 + skill-router 新端点;**不动 agent 配置 / 虚拟通道 / 手写 CRUD**(sub-5/2/3/6)。
- 落盘仅 `~/.zero-core/skills/`(复用 sub-6 写路径护栏,拒任何越界)。
- E2E 用 `file://` 本地 fixture(可控离线),不打真实网络;真实远程 URL 仅手动验证。

## 风险

- **多 skill 布局检测**:只根 + 一层子目录,**不递归**,避免误装嵌套深层目录。根 SKILL.md + 子目录 SKILL.md 并存时都装,id 各自取。
- **重名原子性**:任一冲突整批拒;清理要干净(临时 clone 目录务必删)。
- **git 依赖**:系统无 git → 明确报错;走系统 git 凭证(用户的 SSH key / credential helper),**无私有库 token 内置**。
- **clone 安全**:不可信远程代码,UI 警示(继承 design 安全段);安装按钮旁标注「远程代码,装前请审计来源」。
- **路径安全**:落盘仅 `~/.zero-core/skills/`,resolve 后比对前缀,拒 `../` 越界 / 绝对外部路径。

## 验收

见 `acceptance-7.md`。
