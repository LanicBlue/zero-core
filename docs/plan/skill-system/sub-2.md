# sub-2:`[skills]/` Read 虚拟路径通道(selection 段)

> progressive disclosure 第 2 段(selection):agent 用虚拟路径直接 Read SKILL.md 正文 + 兄弟资源。协议"agent 直接读 SKILL.md"的卫生化实现(核心)。对应 design 决策 4 + 方案核心。Shell 通道(脚本)拆到 sub-3。

## 任务

1. **虚拟路径解析器**(新模块 `src/tools/skill-paths.ts`,sub-3 Shell 复用):
   - 识别 `[skills]/<id>/<rel>`(`<id>`=目录名)。
   - 经 sub-1 的 `resolveSkillByName(id)` / `getSkillIndex()` 解析 → 真实 baseDir → `resolve(baseDir, rel)`。
   - **路径沙箱**:resolve 后必须仍在 baseDir 前缀内,拒 `../` 越界。
   - 非 `[skills]/` 前缀 → 返 null(交回原 readScope 流程)。
2. **Read 接入**(`src/tools/file-read.ts`):
   - path 以 `[skills]/` 开头 → 解析器 → 真实路径 → **始终放行**(不经 `resolvePath` 的 restrictToWorkspace)。
   - 真实路径 → `resolvePath` 现有 readScope **不变**。
   - 读 skill md 内容做 **`${SKILL_DIR}` 与 `${CLAUDE_SKILL_DIR}` → `[skills]/<id>` 替换**(两变量都换——兼容 Claude 生态 + 自有通用)。
3. **多文件/资源**(协议第 3 段):agent 可 `Read [skills]/<id>/reference.md` 等,经上机制天然支持。

## 范围

- 解析器 + Read 前缀识别 + 替换。**Shell 通道拆到 sub-3**。
- **不改 prompt**(sub-4)、**不动 UI**(sub-5/6)、**不动 scanner**(sub-1)。

## 风险

- **路径沙箱关键护栏**:resolve 后比对 baseDir 前缀;软链接逃逸必要时 `realpath`。单测覆盖 `[skills]/a/../../etc`。
- **`${SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 替换边界**:只在 skill md 内容做;两变量名都匹配;不误伤偶然字面(语义本如此)。

## 验收

见 `acceptance-2.md`。
