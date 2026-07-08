# Design:skill-system

> 状态:**Decided,可进 plan**。
> 对应 issue:[`./issue.md`](./issue.md)(同目录,随文件夹流转)。

## 问题回顾(详见 ./issue.md)

skill 现在只是系统提示词里一行 `- **name**: description`,agent 永远看不到 skill 正文;无 CRUD、无 per-agent 配置入口。"落地"= 让 skill 正文能按需到达 agent 手里,并对齐通用 skill 使用规则。

## 关键事实(审计)

- 扫描器只取 frontmatter:`skill-scanner.ts:149-150` 用 `parsed.name || manifestEntry?.name`,**body 从不读取**;`DiscoveredSkill` 无 body 字段(`skill-scanner.ts:31-38`)。
- 注入只一行:`system-prompt.ts:71` `"- **${s.name}: ${s.description}"`。
- 来源三层(全局):`getSkillSources()` 硬编码 3 个 home 目录(`skill-scanner.ts:45-52`),其中 `~/.zero-core/skills` 已标 `source:"app"` 但未实际使用。
- per-agent 开关已存在:`AgentRecord.skillPolicy.enabledSkills: string[]`(`shared/types.ts:49-51`),系统提示词按它过滤(`system-prompt.ts:66-69`)。对照 `toolPolicy.tools: Record<string,{enabled}>`(`shared/types.ts:41-48`)+ `ToolsSection.tsx` 分组开关 UI——**skill 配置应对齐这个模式**。
- 工具层已解耦(tool-decoupling 已合并 master):新增一个工具 = 注册纯函数 + callerCtx,干净。

## 标准 skill 模型(progressive disclosure,本设计遵循)

[Anthropic Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) 的三段式:

1. **metadata 阶段**:扫描所有 SKILL.md,把 name+description 注入系统提示词(框架**已做**)。
2. **selection 阶段**:任务匹配某 skill 描述时,agent **查询并加载完整 SKILL.md 正文**(框架**缺**)。
3. **resource 阶段**:按需加载 skill 目录里的附带资源(本设计 **deferred**)。

→ 第一段保留;**本 effort 主要补第二段(body 按需加载)+ per-agent 配置 + UI**。

## 方案(分叉点 = body 加载机制)

### A — 专用 `skill` 工具(推荐)
新增一个工具 `skill`(或 `load_skill`):输入 skill id/name → 返回 SKILL.md 正文(经 tool-decoupling 的纯函数层注册,UI/MCP/agent 三 host 共享)。系统提示词仍只注 name+desc,并在 "Available Skills" 段尾提示"需要时调 `skill` 工具读正文"。

- **优点**:语义明确、显式"查询";复用现成工具层(无新 IPC/通道);per-agent 经 `toolPolicy` 控制谁能用;token 经济(只有 name+desc 常驻);与标准模型 selection 阶段一一对应。
- **缺点**:多一轮 tool round-trip;依赖 agent 自己判断何时加载(能力弱的模型可能该读不读——靠 description 写得好缓解)。

### B — 走现有 file-read 直读
提示 agent "skill 正文在 `<baseDir>/SKILL.md`",agent 用 `file-read` 工具读。

- **优点**:零新工具。
- **缺点**:要把 skill 磁盘路径泄露进 prompt(外部来源路径如 `~/.claude/skills/...` 暴露给 LLM,不雅且耦合宿主环境);file-read 受 readScope 限制可能读不到 home 目录;多个 skill 路径污染提示词。**作废**。

### C — 全量正文常注(原 design 草案 A)
scanner 读 body,系统提示词注入完整正文(非 name+desc 一行)。

- **缺点**:违反 progressive disclosure(每 turn 常驻所有 enabled skill 正文),skill 多时 token 浪费严重;且不符合用户要的"通用 skill 规则"。**作废**(用户明确否决)。

## 推荐

**A — 专用 `skill` 工具**。理由:符合标准模型 selection 阶段;复用 tool-decoupling 落地的工具层(注册一个纯函数即可,三 host 共享);per-agent 可控;token 经济。

## 其它已定项(用户拍板)

1. **作用域 = agent 级,非 project 级**。skill 不按项目隔离,按 agent 配置。扩展 `skillPolicy` + 在 `AgentEditor` 加 `SkillsSection`(镜像 `ToolsSection.tsx` 的分组开关 UI)。
2. **UI = 左列表 + 右详情**。`SkillsPage` 改双栏:左列表按来源分组(最上"本软件 skills",其下外部来源);右详情显示选中 skill 的正文。
3. **可编辑边界**:只有"本软件 skills"(`~/.zero-core/skills/`)可新建/编辑/删除;外部来源(`~/.claude/skills`、`~/.agents/skills`)**只读**,绝不破坏。
4. **本软件 skills 目录 = `~/.zero-core/skills/`**(scanner 已扫此路径并标 `source:"app"`,直接用起来)。

## 已定决策(design→plan 闸门通过)

1. **`skill` 工具入参 = `name`**(通用规则)。标准模型里 skill 由 frontmatter 的 `name` 标识、agent 按 name 引用;目录名只是存储位置。→ **scanner 去重从"按目录名 id"切到"按 name"**(最高优先级 source 覆盖),保证 prompt 里 name 唯一、agent 的 name 引用必解析。`DiscoveredSkill.id` 保留(= 目录名,作磁盘定位),但工具入参与 prompt 展示用 name。
2. **skillPolicy 保持 `enabledSkills: string[]`**(string[] of names)。
3. **新 agent 默认全不开**(`enabledSkills = []`)。**注意**:`system-prompt.ts:66-69` 现有 `enabled ? filter : skills` 分支——`undefined` 时注入全部。plan 需核对:新 agent 显式写 `[]` 走 filter→空(undefined 分支不动,保 legacy 兼容);或评估是否把 undefined 也改成"全不开"(倾向**不动 undefined**,避免破坏存量 agent)。
4. **本软件 skill 正文 = 分字段编辑**(name / description / 其它 frontmatter 字段 + body textarea),写回 `~/.zero-core/skills/<name>/SKILL.md`,保留 frontmatter + body。
5. **`skill` 工具进 tool 系统 = 方案 B(系统工具·自动开)**:注册进 `ALL_TOOLS` + ToolDescriptor(新 category `system`),**不经 `toolPolicy` 手动开关**;`buildToolsSet` 在 `skillPolicy.enabledSkills` 非空时**自动纳入**激活集(杜绝"有 skill 没 loader"坏状态)。ToolsPage 归 "system" 分组,可见可测但非 per-agent 勾选。否决 A(普通可开关工具,坏状态风险)与 C(特殊注入,丧失 tool-decoupling 三 host 共享)。
6. **多文件 skill 支持(折进 sub-2,不 defer)**:标准协议([Claude Code skills](https://code.claude.com/docs/en/skills)、[Anthropic Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills))下 skill = 目录(SKILL.md 入口 + 兄弟 md + scripts/ + 资源),不是单 md。`skill` 工具加可选 `file` / `list` 参数覆盖:`skill({name})` 取 SKILL.md 入口、`skill({name,file})` 取兄弟文件、`skill({name,list:true})` 枚举目录;`file` 路径沙箱(相对 baseDir,resolve 后比对前缀,拒 `../` 越界)。脚本不由 skill 工具执行——工具只做纯检索,agent 读源码后用 bash 跑。**defer 的仅**"单超大 md 的 chunked offset/limit 阅读"(罕见,入口 md 本就该精炼)。

## 下一步

→ `/effort plan` 拆 sub(每个 sub 配对 acceptance)。预想 5 个 sub:
1. scanner 读 body + 类型扩展 + 去重切 by name
2. `skill` 系统工具(按 name 查询;多文件 file/list 参数 + 路径沙箱;enabledSkills 非空自动激活)
3. 系统提示词 "Available Skills" 加调用提示(含 file 资源加载)+ 默认全不开语义
4. `SkillsSection`(agent 配置,skillPolicy checkbox)
5. `SkillsPage` 双栏 UI + 本软件 skill CRUD(目录形态;v1 管 SKILL.md 入口)
