# acceptance-2:`[skills]/` 读家族虚拟路径通道(Read + Glob + Grep)

对应 `sub-2.md`。

## 用例

1. **Read 虚拟路径**:workspace-scoped agent `Read [skills]/foo/SKILL.md` → 返正文(即便真实路径在 home 外)。
2. **Read 兄弟文件**:`Read [skills]/foo/reference.md` → 返内容(协议第 3 段资源加载)。
3. **`${SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 替换**:SKILL.md 含两者 → Read 返回内容都替换成 `[skills]/foo/...`。
4. **Read 路径沙箱**:`Read [skills]/foo/../../etc/passwd` → 拒(路径在 baseDir 外)。
5. **真实路径不变**:`Read <真实路径>`(非 `[skills]/` 前缀)→ readScope 照常(workspace-scoped 拒越界)。
6. **不存在的 skill**:`Read [skills]/不存在/SKILL.md` → "skill not found"。
7. **不经 readScope**:`readScope="workspace"` + `[skills]/` 前缀 → 放行(通道受信)。
8. **Glob 虚拟路径**:`Glob [skills]/foo/**` → 返回该 skill 内文件列表,**路径全为 `[skills]/foo/...` 虚拟形态**(无真实路径泄露)。
9. **Grep 虚拟路径**:`Grep <pattern> [skills]/foo/` → 命中结果,path 字段全为 `[skills]/foo/...`(含 context/`-o` 片段所附路径)。
10. **Glob/Grep 路径沙箱**:`Glob [skills]/foo/../../etc/**` → 拒/空(不越 baseDir)。
11. **Glob/Grep 单 skill 边界**:裸 `[skills]/**` 或 `[skills]/*`(不指名 skill)→ 不支持/拒(跨 skill 枚举不做)。
12. **Glob/Grep 不经 readScope**:workspace-scoped agent 对 `[skills]/<id>/` 的 Glob/Grep 放行。
13. **无存量破坏**:typecheck 三层 + vitest 全套绿;现有 Read/Glob/Grep 对非 `[skills]/` 路径零变化。

## 验证手段

- 单测:解析器(前缀识别 / 沙箱 / 不存在)+ Read 虚拟路径 + 替换 + **Glob/Grep 结果回映射(断言无真实路径泄露)**;mock skill 目录(多文件)。
- typecheck 三层 + `npm run test`。
