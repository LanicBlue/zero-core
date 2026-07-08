# Issue:skill-system

- **状态**:① issues(问题记录)
- **提出**:2026-07-08
- **类型**:改进(机制加固 / 架构)

## 问题

框架内已有一个**轻量 skill 扫描器**(只读扫描 `~/.claude/skills` 等目录的 SKILL.md,注入系统提示词的 "Available Skills" 章节),但 skill 还不是一等公民:无 CRUD 管理、无项目级 skill、运行时只把名字塞进 prompt(没有真正的"调用 / 加载 skill 正文 / 执行 skill 步骤"语义)。"skill 系统落地"指把 skill 从"prompt 里一行提示"升级为可管理、可项目隔离、运行时可被 agent 主动调用的完整机制。

## 现状 / 真相源 / 影响面

### skill 扫描(已存在,只读)
- `src/server/skill-scanner.ts:31-38` — `DiscoveredSkill` 接口。
- `src/server/skill-scanner.ts:45-52` — 扫描三个目录:`~/.claude/skills`、`~/.agents/skills`、`~/.zero-core/skills`。
- `src/shared/types.ts:619-626` — `DiscoveredSkill` 类型(仅 name/description/source 等元数据)。

### 运行时注入(仅 prompt 一行)
- `src/core/system-prompt.ts:33-38` — `SystemPromptContext` 含 `skills` / `enabledSkills` 字段。
- `src/core/system-prompt.ts:64-74` — `buildSystemPrompt` 把 skills 拼成 "## Available Skills" 章节(只列名字 + 描述,不加载正文)。
- `src/shared/types.ts:49-51` — `AgentRecord.skillPolicy.enabledSkills` 配置开关。

### UI / 路由(只读浏览)
- `src/server/skill-router.ts:30-43` — `/api/skills` REST(只读)。
- `src/renderer/components/skills/SkillsPage.tsx` — 发现 + 浏览页;`L72-73` 提示用户手动装到 `~/.claude/skills/`。

### 等价物(框架重心所在)
- `src/server/template-store.ts:33-50` — `BUILT_IN_TEMPLATES`(PromptTemplate 画廊,有 CRUD)。
- `src/tools/` — 40+ 工具(可复用能力的主要载体)。
- `docs/arch/09-extension-points-and-adrs.md:555-576` — ADR-020:工作流知识下沉 wiki playbook,机制(ag ents/tools/cron)留代码。

### gap(待 design 定)
- skill **无 CRUD**(对比 PromptTemplate 有 template-store 全套),只能手动放文件。
- skill **无项目级隔离**:扫描的是全局 home 目录,没有 project-scoped skill(对比 wiki 已有 project 沙箱)。
- skill 运行时**只注入名字**,agent 不会"调用 skill → 读其正文 → 按 skill 步骤执行"——更像提示,不像机制。

## 下一步

进② design 细化方案(`/effort design`)。design 要定:
- skill 的运行时语义(prompt 提示 vs 可调用资产 vs 可执行步骤脚本)。
- skill 来源层级(user 级 / app 级 / **project 级**——是否复用 wiki project 沙箱)。
- skill 管理 CRUD(是否复用 template-store 模式)与 SkillsPage 升级。
- skill 正文加载时机(懒加载 vs 全量注入)与 token 预算。
