# acceptance-2:`[skills]/` Read 虚拟路径通道

对应 `sub-2.md`。

## 用例

1. **Read 虚拟路径**:workspace-scoped agent `Read [skills]/foo/SKILL.md` → 返正文(即便真实路径在 home 外)。
2. **Read 兄弟文件**:`Read [skills]/foo/reference.md` → 返内容(协议第 3 段资源加载)。
3. **`${SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 替换**:SKILL.md 含两者 → Read 返回内容都替换成 `[skills]/foo/...`。
4. **路径沙箱**:`Read [skills]/foo/../../etc/passwd` → 拒(路径在 baseDir 外)。
5. **真实路径不变**:`Read <真实路径>`(非 `[skills]/` 前缀)→ readScope 照常(workspace-scoped 拒越界)。
6. **不存在的 skill**:`Read [skills]/不存在/SKILL.md` → "skill not found"。
7. **不经 readScope**:`readScope="workspace"` + `[skills]/` 前缀 → 放行(通道受信)。
8. **无存量破坏**:typecheck 三层 + vitest 全套绿;现有 Read 对非 `[skills]/` 路径零变化。

## 验证手段

- 单测:解析器(前缀识别/沙箱/不存在)+ Read 虚拟路径 + 替换;mock skill 目录。
- typecheck 三层 + `npm run test`。
