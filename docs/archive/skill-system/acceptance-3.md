# acceptance-3:`[skills]/` Shell 虚拟路径通道(脚本)

对应 `sub-3.md`。依赖 sub-2 解析器。

## 用例

1. **Shell 虚拟路径**:`Shell python [skills]/foo/scripts/x.py` → 命令 token 解析成真实路径 → 脚本执行。
2. **Windows 反斜杠**:win32 下解析出的真实路径(含 `\`)进 bash 命令不破坏(引号包裹/转正斜杠)。
3. **`SKILL_DIR` env**:跑 skill 脚本时子进程环境含 `SKILL_DIR=<真实 baseDir>`。
4. **真实路径命令不变**:普通 Shell 命令(无 `[skills]/`)走现有 autoApprove/scope。
5. **路径沙箱**:命令含 `[skills]/foo/../../etc/x` token → 拒/不替换越界。
6. **命令注入防护**:解析后路径含空格/特殊字符 → 替换进命令正确转义,不执行意外命令。
7. **无存量破坏**:typecheck 三层 + vitest 全套绿;现有 Shell 对非 `[skills]/` 命令零变化。

## 验证手段

- 单测:Shell token 替换 + Windows 路径 + env + 注入边界;mock skill 目录。
- typecheck 三层 + `npm run test`。
