# sub-2:`[skills]/` 虚拟路径通道

> progressive disclosure 第 2/3 段(selection + resource):agent 用虚拟路径直接 Read skill 正文/资源、Shell 跑脚本。这是协议"agent 直接读 SKILL.md"机制的卫生化实现。对应 design 决策 4 + 方案核心。

## 任务

1. **虚拟路径解析器**(新模块,如 `src/tools/skill-paths.ts`):
   - 识别 `[skills]/<id>/<rel>` 前缀(`<id>`=目录名)。
   - 经 sub-1 的 `resolveSkillByName(id)` / `getSkillIndex()` 解析到真实 baseDir → `resolve(baseDir, rel)`。
   - **路径沙箱**:resolve 后必须仍在 baseDir 前缀内,拒 `../` 越界(防 `[skills]/a/../../etc/passwd`)。
   - 不识别/非 `[skills]/` 前缀 → 返 null(交回原 readScope 流程)。

2. **Read 接入**(`src/tools/file-read.ts`):
   - path 以 `[skills]/` 开头 → 走解析器 → 真实路径 → **始终放行**(不经 `resolvePath` 的 restrictToWorkspace 检查)。
   - 真实路径(path 不以 `[skills]/` 开头)→ `resolvePath` 现有 readScope 逻辑**不变**。
   - 读 skill md 内容时做 **`${SKILL_DIR}` → `[skills]/<id>` 替换**(返回前字符串替换),让协议可移植自引用解析成具体虚拟路径。

3. **Shell 接入**(`src/tools/bash.ts`):
   - 命令里扫描 `[skills]/<id>/<rel>` token → 解析成真实路径 → 替换进命令 → 执行。
   - 真实路径命令不变(Shell 现有 autoApprove/scope 流程)。

4. **多文件/资源**(协议第 3 段):agent 可 `Read [skills]/<id>/reference.md`、`Read [skills]/<id>/forms.md`(任意兄弟文件)。本 sub 经上面机制天然支持,无需额外代码。

## 范围

- 加解析器 + Read/Shell 前缀识别 + `${SKILL_DIR}` 替换。
- **不改 prompt 文案**(sub-3 告知 agent 用法)、**不动 UI**(sub-4/5)、**不动 scanner**(sub-1)。

## 风险

- **路径沙箱是关键护栏**:必须 resolve 后比对 baseDir 前缀;软链接逃逸必要时 `realpath`。单测必覆盖 `[skills]/a/../../etc`、绝对路径注入。
- **Shell token 替换**:命令解析要稳健(引号、变量);只替换 `[skills]/...` token,不动其它。先做朴素正则匹配 + 单测边界。
- **`${SKILL_DIR}` 替换边界**:只在 skill 内容(md)上做;不误伤正文里偶然出现的 `${SKILL_DIR}` 字面(可接受,语义本就如此)。

## 验收

见 `acceptance-2.md`。
