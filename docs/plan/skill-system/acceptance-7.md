# acceptance-7:git URL 安装第三方 skill

对应 `sub-7.md`。

## 用例

1. **单 skill repo**(根 `SKILL.md`):给 `file://` URL → 安装 → 列表出现 id=repo 名的 skill;详情可读 name/desc/body。
2. **多 skill repo**(直接子目录各有 `SKILL.md`):给 URL → 全部子 skill 装上,各自 id=子目录名;列表都出现。
3. **无 SKILL.md repo**:给 URL → 报错「未检测到合法 skill」+ 不落盘 + 列表不变。
4. **重名拒绝**:目标 id 已存在 → 整批拒绝 + 报错 + 列表不变(多 skill 时一个冲突全拒,临时 clone 清理)。
5. **校验失败回滚**:`SKILL.md` 存在但 frontmatter 非法 → 回滚删目录 + 报错 + 列表不变。
6. **异步反馈**:安装中 loading 态;完成刷新列表。
7. **仅落 app 根**:所有安装落 `~/.zero-core/skills/`,不碰 `~/.claude`、`~/.agents`(只读校验)。
8. **无存量破坏**:typecheck 三层 + vitest 全套绿。

## E2E(扩 `tests/e2e/skills-page.spec.ts`)

9. **单 skill 安装**:用 `file://` 指向 tmp fixture repo(根 `SKILL.md`)→ 安装 → 列表出现 + 详情可读。
10. **多 skill 安装**:fixture 含多个子目录 skill → 安装 → 所有子 skill 出现。
11. **重名**:先装一次,再装同 URL → 拒绝 + 错误提示 + 列表条数不变。

**前置(fixture)**:测试用 `file://` 指向 tmp 里的 fixture repo(`git init` + commit,或现成目录作 URL),可控、离线、不依赖真实网络与系统 git 凭证。

## 验证手段

- 单测:auto-detect 布局解析(根 / 子目录 / 无 SKILL.md / 并存)+ 重名原子性 + 校验回滚逻辑。
- E2E:上述 9–11(`file://` fixture)。
- typecheck 三层 + `npm run test`(含 e2e)。
