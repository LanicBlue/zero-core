# acceptance-2:`[skills]/` 虚拟路径通道

对应 `sub-2.md`。

## 用例

1. **Read 虚拟路径**:workspace-scoped agent `Read [skills]/foo/SKILL.md` → 返 SKILL.md 正文(即便真实路径在 home 外、readScope=workspace)。
2. **Read 兄弟文件**:`Read [skills]/foo/reference.md` → 返该文件内容(协议第 3 段资源加载)。
3. **`${SKILL_DIR}` 替换**:SKILL.md 含 `${SKILL_DIR}/reference.md` → Read 返回内容里已替换成 `[skills]/foo/reference.md`(agent 看到具体虚拟路径)。
4. **Shell 虚拟路径**:agent `Shell python [skills]/foo/scripts/x.py` → 命令里 `[skills]/foo/scripts/x.py` 解析成真实路径 → 脚本执行。
5. **路径沙箱**:`Read [skills]/foo/../../etc/passwd` → 拒(路径在 baseDir 外);`[skills]/foo/scripts/../../etc` 同拒。
6. **真实路径不变**:`Read /home/.../etc/passwd`(非 `[skills]/` 前缀)→ 仍按 readScope(workspace-scoped 拒)。
7. **不存在的 skill**:`Read [skills]/不存在/SKILL.md` → 明确错误 "skill not found"。
8. **不经 readScope**:`readScope="workspace"` + `[skills]/` 前缀 → 放行(通道受信);真实路径越界仍拒。
9. **无存量破坏**:typecheck 三层 + vitest 全套绿;现有 Read/Shell 行为对非 `[skills]/` 路径零变化。

## 验证手段

- 单测:解析器(前缀识别/沙箱/不存在)+ Read 虚拟路径 + Shell token 替换 + `${SKILL_DIR}` 替换;mock skill 目录。
- typecheck 三层 + `npm run test`。
