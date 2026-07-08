# sub-2:`[skills]/` 读家族虚拟路径通道(Read + Glob + Grep,selection 段)

> progressive disclosure 第 2 段(selection):agent 用虚拟路径直接 Read SKILL.md 正文 + 兄弟资源,并可在 skill 内 Glob/Grep。协议"agent 直接读 SKILL.md"的卫生化实现(核心)。对应 design 决策 4 + 方案核心。Shell 通道(脚本)拆到 sub-3,Write/Edit 拆到 sub-8。

## 任务

1. **虚拟路径解析器**(新模块 `src/tools/skill-paths.ts`,sub-3 Shell / sub-8 Write 复用):
   - 识别 `[skills]/<id>/<rel>`(`<id>`=目录名)。
   - 经 sub-1 的 `resolveSkillByName(id)` / `getSkillIndex()` 解析 → 真实 baseDir → `resolve(baseDir, rel)`。
   - **路径沙箱**:resolve 后必须仍在 baseDir 前缀内,拒 `../` 越界。
   - 非 `[skills]/` 前缀 → 返 null(交回原 readScope 流程)。
2. **Read 接入**(`src/tools/file-read.ts`):
   - path 以 `[skills]/` 开头 → 解析器 → 真实路径 → **始终放行**(不经 `resolvePath` 的 restrictToWorkspace)。
   - 真实路径 → `resolvePath` 现有 readScope **不变**。
   - 读 skill md 内容做 **`${SKILL_DIR}` 与 `${CLAUDE_SKILL_DIR}` → `[skills]/<id>` 替换**(两变量都换——兼容 Claude 生态 + 自有通用)。
3. **Glob 接入**(`src/tools/glob.ts` 或对应实现):
   - pattern / path 以 `[skills]/<id>/` 开头(必须指名某 skill)→ 解析器 → 真实 baseDir → 在真实路径跑 glob。
   - **结果路径回映射**:命中真实路径在 baseDir 下的 → 替换回 `[skills]/<id>/...` 再返回(防真实路径泄露)。
   - **始终放行**(读类),不经 readScope。
   - **仅限单 skill**(`[skills]/<id>/...`);跨 skill 枚举(`[skills]/**`)不支持(列 skill id 是 scanner metadata 的活)。
4. **Grep 接入**(`src/tools/grep.ts` 或对应实现,ripgrep):
   - path 以 `[skills]/<id>/` 开头 → 解析器 → 真实 baseDir → ripgrep 在真实路径跑。
   - **结果路径回映射**:结构化输出里的 path(及 context/-o 片段所附路径)在 baseDir 下 → 替换回 `[skills]/<id>/...`。
   - 始终放行;仅限单 skill。
5. **多文件/资源**(协议第 3 段):agent 可 `Read [skills]/<id>/reference.md`、`Grep [skills]/<id>/ ...`、`Glob [skills]/<id>/**`,经上机制天然支持。

## 范围

- 解析器 + Read/Glob/Grep 前缀识别 + md 替换 + Glob/Grep 结果回映射。**Shell 通道拆到 sub-3,Write/Edit 拆到 sub-8**。
- **不改 prompt**(sub-4)、**不动 UI**(sub-5/6/7)、**不动 scanner**(sub-1)。

## 风险

- **路径沙箱关键护栏**:resolve 后比对 baseDir 前缀;软链接逃逸必要时 `realpath`。单测覆盖 `[skills]/a/../../etc`(Read/Glob/Grep 三处)。
- **结果回映射正确性**:Glob/Grep 返回的每条真实路径都要映射成 `[skills]/<id>/...`,不能漏泄一条真实路径;注意 Grep 多行/`-o`/context 里的路径字段。
- **单 skill 边界**:Glob/Grep 的 path 必须 `[skills]/<id>/` 起头;裸 `[skills]/` 或 `[skills]/**` → 拒/不支持(避免跨 skill 枚举泄露)。
- **`${SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 替换边界**:只在 skill md 内容做;两变量名都匹配。

## 验收

见 `acceptance-2.md`。
