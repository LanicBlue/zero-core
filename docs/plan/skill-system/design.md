# Design:skill-system

> 状态:**Decided(协议忠实方案,扩范围修订版 —— 含 git 安装 + agent 自建 + Glob/Grep 适配)**。
> 对应 issue:[`./issue.md`](./issue.md)(同目录,随文件夹流转)。

## 问题回顾(详见 ./issue.md)

skill 现在只是系统提示词里一行 `- **name**: description`,agent 看不到 skill 正文;无 CRUD、无 per-agent 配置入口;也无第三方 skill 安装、agent 自建链路。"落地"= 让 skill 正文/资源**按协议(progressive disclosure)按需到达 agent 手里**,并对齐 [Anthropic Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) / [Claude Code skills](https://code.claude.com/docs/en/skills) 标准。

## 关键事实(审计)

- 扫描器:`skill-scanner.ts:149-150` 只取 frontmatter name/description,**body 从不读取**(本设计保持——progressive disclosure 要 body 懒加载)。
- identity:`DiscoveredSkill.id` = 目录名(`skill-scanner.ts:154-161`);display name = `parsed.name || manifestEntry?.name || entryName`(目录名兜底)——**已符合协议**(协议:目录名=调用主键,frontmatter name=显示名,缺省取目录名)。
- 优先级 bug:`getSkillSources()` 顺序 `[.claude, .agents, .zero-core]` + `merged.set` 后覆盖前(`skill-scanner.ts:167-180`)→ app(`~/.zero-core`)**覆盖** personal(`~/.claude`)。但协议规定 **personal > bundled/app**。**方向反了,须修**。
- 注入:`system-prompt.ts:64-74` 注 `- **name**: description` 一行。
- per-agent 开关:`AgentRecord.skillPolicy.enabledSkills: string[]`(`shared/types.ts:49-51`),按它过滤(`system-prompt.ts:66-69`)。
- Read scope:`file-read.ts:57` `restrictToWorkspace` 时拒 workingDir 外路径;`readScope` 由 `toolPolicy.readScope`(`shared/types.ts:41-48`)决定。

## 标准 skill 模型(progressive disclosure,本设计严格遵循)

协议三段式([来源](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)):

1. **metadata**:启动时把每个 skill 的 name+description 预载进系统提示词(框架已做)。
2. **selection**:任务匹配时,agent **直接 Read SKILL.md 正文**进上下文(协议原文:"Claude triggers the PDF skill by invoking a Bash tool to read the contents of `pdf/SKILL.md`")。
3. **resource**:skill 可 bundle 兄弟文件/脚本,agent 按需 Read 兄弟文件、Shell 跑脚本("skills can bundle additional files within the skill directory and reference them by name")。

→ 第 1 段保留;**本 effort 补第 2/3 段(agent 直接读 skill 文件)+ per-agent 配置 + UI + 第三方安装 + agent 自建**。

## 方案:`[skills]/` 虚拟路径通道(读 + 写 + 执行)

协议的直读机制 + 我们的卫生化适配:agent 用**虚拟路径** `[skills]/<name>/<rel>` 访问/编写/检索任意 skill 文件,不接触真实磁盘路径。**读/写/执行类基本工具(Read/Glob/Grep/Write/Edit/Shell)都做 `[skills]/` 前缀适配,不新造专用 skill 工具。**

### 解析与权限
- **Read / Glob / Grep / Write / Edit / Shell** 识别 `[skills]/<name>/<rel>` 前缀 → 复用 sub-2 解析器(`skill-paths.ts`)→ 按 `<name>`(目录名=id)经 scanner 索引解析到真实 baseDir → join `<rel>` → 真实路径。
- **读**(Read/Glob/Grep):`[skills]/` 通道**始终放行**(受信 skill 读取入口),**不经 readScope**。Glob/Grep 限定 `[skills]/<id>/...`(指名单 skill,不做跨 skill 枚举),且**结果路径回映射**真实→`[skills]/<id>/...`(防真实路径泄露)。
- **写**(Write/Edit):`[skills]/` 通道**按 per-agent 权限门禁**——仅 `skillPolicy.canAuthorSkills === true` 的 agent 可写;无权限→拒绝(决策 11)。写新 skill 一律落 `~/.zero-core/skills/<id>/`(app 根);写已存在的外部来源 skill(`~/.claude` 等)→ 拒绝(外部只读)。
- **真实路径访问不变**:`readScope="workspace"` 的 agent 用真实路径越界照样拒(`file-read.ts:57` 不动)。虚拟通道是唯一的 skill 受信入口。
- 路径沙箱:`<rel>` resolve 后必须仍在该 skill baseDir 内,拒 `../` 越界(防借 `[skills]/a/../../etc` 逃逸)。**写新 skill**(基目录尚不存在)时,基目录 = `~/.zero-core/skills/<id>`,且 id 须 path-safe + 不与已有冲突。

### `${SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 替换(可移植自引用)
- 协议(Claude 生态)用 `${CLAUDE_SKILL_DIR}/reference.md` 可移植引用本 skill 文件;我们通用形式用 `${SKILL_DIR}`。**两个都替换**成 `[skills]/<id>`——既兼容 Claude 生态 skill(不改可用),又支持自有通用形式。
- 读 skill 内容(md)时做替换,agent 看到的全是具体虚拟路径。
- 所以 skill 所有文件访问(md + 脚本)**统一走 `[skills]/` 虚拟路径**:Read 读正文/资源,Glob/Grep 在 skill 内列举/检索,Shell 跑 `${SKILL_DIR}/scripts/x.py`(替换后 = `[skills]/<id>/scripts/x.py`),Write/Edit 经 `[skills]/` 写(agent 自建)。

### git URL 安装(第三方 skill 分发)
协议:skill = 目录,安装 = 落盘;无包管理器、无 install hook。我们提供 git URL 拉取 UX(sub-7):
- 用户在 SkillsPage 给 git URL → 系统 `git clone` 到临时区 → **auto-detect 两种布局**:repo 根有 SKILL.md(单 skill,id=repo 名)**和/或** 直接子目录各有 SKILL.md(多 skill,id=子目录名),全部安装;一个都没→报错。
- **原子性**:任一 id 与已有同名 → 整批拒绝 + 清理临时 clone(对齐 A2)。
- clone 后跑 scanner 校验每个 skill 合法(有 SKILL.md + 合法 frontmatter),失败→回滚删目录。
- 走**系统 git**(用户 git 凭证/SSH key),不内置 token;私有库本机 git 能拉就能装。
- 更新(pull)v1 defer(clone 后保留 `.git`,删了重装)。
- 安全:不可信远程代码,安装时 UI 警示(继承协议「用前审计」)。

### agent 运行时自建 skill
协议**未覆盖**(skill 是 author-time 产物)。我们用 per-agent 写权限门禁实现(sub-8),**复用基本工具,不造新工具**:
- per-agent `skillPolicy.canAuthorSkills: boolean`(默认 false),toggle 在 SkillsSection。
- agent 用**基本 Write/Edit 工具**经 `[skills]/<id>/SKILL.md` 虚拟路径写(无专用 skill 工具);写由上述 flag 门禁,无权限的 agent 写 `[skills]/` → 拒绝。
- 写入仅落 `~/.zero-core/skills/<id>/`;写已存在的外部来源 skill(`~/.claude` 等)→ 拒绝(外部只读)。
- id path-safe + 重名拒绝(复用 sub-6 护栏)。
- 溯源:agent 自建 skill 的 SKILL.md 打 frontmatter `author: agent:<agentId>`(UI 可选展示「由 agent X 创建」)。
- prompt 引导:canAuthorSkills=true 的 agent 提示「当流程确有复用价值时,可写成 skill」(sub-4 扩展,文案克制防滥建)。
- **不做审批队列**——权限即门禁;用户审计发生在「给哪个 agent 开写权限」时,符合协议「用前审计」。

### 否决的替代
- ❌ 专用 `skill` 工具(读**或**写):协议**没有**专用 loader,agent 直接用基本工具;自造工具偏离协议 + 多余抽象。**读和写都不造专用工具**——统一 `[skills]/` 虚拟路径适配基本工具(Read/Glob/Grep/Write/Edit/Shell)。作废。
- ❌ 真实路径白名单(放行 skill 根目录到 readScope):削弱真实路径安全 + 泄露真实路径。作废。
- ❌ frontmatter name 作 identity:协议明确 identity=目录名,name 是显示名。作废(消解 G1 改名断 enable——id 稳定,改 name 不影响 identity)。
- ❌ agent 自建走审批队列 / 隔离根:用户选 per-agent 写权限门禁(更简,权限即审计点)。
- ❌ Glob/Grep 跨 skill 枚举(`[skills]/**`):列 skill id 是 scanner metadata 的活(已在 prompt);跨 skill 内容检索 v1 不做,仅 `[skills]/<id>/...` 单 skill 内 Glob/Grep。

## 已定决策

1. **identity = 目录名(id)**;display name = frontmatter `name` || 目录名。enabledSkills 持久化 **id(目录名)**(稳定,扛 frontmatter name 改动)。**prompt 每个 skill 条目必须带 `[skills]/<id>/SKILL.md` 路径**(agent 自行 Read,需知道 id 才能寻址;display name ≠ id 时,光给 display name agent 构造不出路径)。
2. **重名处理 = 层级优先级覆盖**(协议):personal(`~/.claude`、`~/.agents`)> app/bundled(`~/.zero-core`),高层覆盖低层、不报错。修 scanner 优先级方向 bug(sub-1)。
3. **scanner 不读 body**:元数据扫描(name+desc+paths),body 由 agent 经 `[skills]/` 按需 Read(progressive disclosure)。
4. **`[skills]/` 虚拟路径通道(读 + 写 + 执行)**:Read/Glob/Grep/Write/Edit/Shell 识别前缀、复用 sub-2 解析器;**读(Read/Glob/Grep)始终放行、写(Write/Edit)按 `canAuthorSkills` 门禁**;Glob/Grep 限单 skill + 结果路径回映射;`${SKILL_DIR}` 与 `${CLAUDE_SKILL_DIR}` 都替换成 `[skills]/<id>`;真实路径 readScope 不变;**不造专用 skill 工具**。
5. **新 agent 默认全不开**(`enabledSkills = []`、`canAuthorSkills = false`)。`system-prompt.ts:66-69` 的 `undefined` 分支不动(legacy agent 兼容,undefined=注入全部);显式 `[]`=空。
6. **作用域 = agent 级**(非 project):`AgentEditor` 加 `SkillsSection`(镜像 `ToolsSection.tsx`)。
7. **UI = 左列表 + 右详情**:`SkillsPage` 双栏,按来源分组(本软件置顶、外部其下)。
8. **可编辑边界**:只有"本软件 skills"(`~/.zero-core/skills/`)可新建/编辑/删除;外部来源**只读**(agent 写也拒)。
9. **本软件 skill 正文 = 分字段编辑**(name/description frontmatter 字段 + body textarea)。
10. **git URL 安装**:auto-detect 根 + 一层子目录多 skill 布局;重名整批拒绝 + 清理(对齐 A2);走系统 git 不内置 token;clone 后 scanner 校验失败回滚;更新(pull)defer。
11. **agent 自建 skill**:per-agent `canAuthorSkills` 门禁(toggle 在 SkillsSection,默认 false);用基本 Write/Edit 经 `[skills]/` 虚拟路径写(**不造新工具**);仅落 `~/.zero-core/skills/`,拒写外部来源;id path-safe + 重名拒绝;frontmatter `author: agent:<id>` 溯源;无审批队列;prompt 文案克制引导。
12. **Glob/Grep `[skills]/` 适配**:读类,始终放行,限 `[skills]/<id>/...` 单 skill(不做跨 skill 枚举),结果路径回映射真实→虚拟防泄露。

## 我们的边界(协议有、v1 不做;合理偏离)

- **nested/parent 目录发现**(`.claude/skills/`):不做(agent-scoped 非 project-scoped)。
- **live change detection**(watch 目录):defer(scanner 每次读盘,正确但低效)。
- **plugin skill 命名空间 / 集中式 marketplace**:不在范围(git URL 安装覆盖第三方分发需求;集中式 marketplace defer)。
- **`disable-model-invocation` frontmatter**:v1 不实现。
- **`allowed-tools` frontmatter**(协议:skill 限定可用工具):v1 defer。
- **Glob/Grep 跨 skill 枚举**(`[skills]/**`、列所有 skill 内容):v1 defer(仅单 skill 内 `[skills]/<id>/...` Glob/Grep;列 skill id 走 scanner metadata)。
- **git skill 更新(pull)**:v1 defer(删了重装)。

## 安全(协议指引,不造机制)

协议明确"只装可信来源、用前审计"。外部 skill(`~/.claude`)只读但可加载,其脚本可指示 agent 跑 bash → 不可信代码执行面(框架本就允许 bash,非新增能力)。**git 安装 + agent 自建同理**:git 拉的是不可信远程代码,agent 自建是「不可信代码生成方产出的 skill」——都继承协议指引,文档警示,不造额外机制。agent 自建的审计点 = 用户决定「给哪个 agent 开写权限」时(而非每次写)。Glob/Grep 是受信 skill 内只读检索,无新增风险面。

> **未来沙盒的前置**:`[skills]/` 虚拟路径天然标识"skill 发起的执行",给后续脚本沙盒一个干净拦截点 + 路径限定基础。沙盒本身(进程/网络隔离,平台成本高,尤其 Windows)复杂度高,已另开 [`skill-script-sandbox`](../../issues/skill-script-sandbox/issue.md) issue,不在本 effort。

## 下一步

→ `/effort plan`,8 sub 各配 acceptance(原 sub-2 拆为读家族/Shell;新增 sub-7 git 安装、sub-8 agent 自建):
1. scanner 协议对齐(优先级 fix + id→dir 索引 + getSkillRoots + display name)
2. `[skills]/` **读家族**(Read + Glob + Grep)虚拟路径通道(解析器 + 前缀识别 + 始终放行 + 路径沙箱 + Glob/Grep 结果回映射 + `${SKILL_DIR}`/`${CLAUDE_SKILL_DIR}` 替换;真实路径 readScope 不变)— **selection 段,核心;解析器被 sub-3/8 复用**
3. `[skills]/` Shell 虚拟路径通道(复用解析器 + Windows 反斜杠 + `SKILL_DIR` env;命令注入防护)— resource 段(脚本),**可后置**
4. prompt 注入(name+desc + 每条目带 `[skills]/<id>/SKILL.md` 路径 + 加载/资源/脚本指引)+ 默认全不开
5. `SkillsSection`(agent 配置,enabledSkills 存 id)
6. `SkillsPage` 双栏 UI + 本软件 skill 手写 CRUD(目录形态;v1 管 SKILL.md 入口)
7. **git URL 安装**(SkillsPage「从 git 安装」入口 + 后端 clone 端点 + 多 skill auto-detect + 重名整批拒绝 + scanner 校验回滚)— 新增
8. **agent 自建 skill**(SkillsSection `canAuthorSkills` toggle + Write/Edit `[skills]/` 适配 + 写门禁 + 仅落 app 根 + 拒写外部 + id 护栏 + author 溯源 + prompt 引导)— 新增,**不造新工具,复用 sub-2 解析器**

**依赖序**:sub-1(地基)→ sub-2(读家族核心,解析器)→ sub-4(prompt,至此 skill 读链路可用);sub-3(Shell 脚本)、sub-5(SkillsSection)、sub-6(SkillsPage CRUD)可并行/后置(sub-5/6 仅依赖 sub-1);**sub-7 依赖 sub-6(UI)+ sub-1(scanner 校验);sub-8 依赖 sub-2(解析器)+ sub-4(prompt 引导)+ sub-5(SkillsSection toggle 位置)**。
