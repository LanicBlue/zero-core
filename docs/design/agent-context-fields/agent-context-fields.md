# Design:Agent 上下文字段接通(从死字段到运行时生效)

> 状态:**Draft,讨论中**。
> 一句话:`AgentRecord` 上有三个 UI 可编辑、DB 持久化、但 **Electron 运行时路径零消费** 的字段(contextConfig / skillPolicy / knowledgeBaseIds)。本努力界定每个字段的真实现状、决定哪些值得接通、以及怎么接。
> 起源:runtime-push-ui-sync N4 实现时核实这三个字段为"死字段",编排者与用户决策:接通它们另起本 effort,不在 N4 范围。详见 [runtime-push-ui-sync.md §5](../runtime-push-ui-sync/runtime-push-ui-sync.md)。

---

## 1. 背景:为什么有"死字段"

`AgentRecord`([shared/types.ts](../../../src/shared/types.ts) L37–54)定义了一组"上下文/能力"字段,有 DB 列([agent-store.ts](../../../src/server/agent-store.ts) COLUMNS)、UI 可编辑([AgentEditor](../../../src/renderer/components/agents/AgentEditor.tsx) / [PromptSection](../../../src/renderer/components/agents/PromptSection.tsx)),但运行时跑 agent 时**根本不读它们**:

- **Electron 路径**([agent-service.ts createLoopForSession](../../../src/server/agent-service.ts#L588) L601–612):`systemPrompt = agent?.systemPrompt ?? ""`(原始拼接),`guidelines` 取自**全局** `this.config.systemPrompt.guidelines`(非 per-agent),`model/provider/thinkingLevel/toolPolicy/subagents/wikiAnchors` 取自 agent。**完全不传** contextConfig/skillPolicy/knowledgeBaseIds。
- 只有 **headless CLI 路径**([cli.ts](../../../src/cli.ts) ~L196)调 [buildSystemPrompt](../../../src/core/system-prompt.ts),而 `buildSystemPrompt` 只用 `useDeviceContext` + `enabledSkills`,且不用 `useGuidelines`/`useMemoryContext`(见 §3.1)。

后果:用户在 UI 改这些字段,UI 显示新值,但运行时我行我素——**所见≠所跑**(正是 runtime-push 不变量 1 想消的缝隙,只是这几个字段连"所跑"都没有)。

## 2. 三字段不是一类,得分开看

| 字段 | DB 列 | UI 可编辑 | 运行时消费点 | 真实性质 |
|---|---|---|---|---|
| `contextConfig.useDeviceContext` | ✓ | ✓ | buildSystemPrompt(CLI only) | **半死**:CLI 生效,Electron 没接 |
| `contextConfig.useGuidelines` | ✓ | ✓ | **无**(buildSystemPrompt 无此参数;Electron 用全局 guidelines) | **全死**:无任何消费 |
| `contextConfig.useMemoryContext` | ✓ | ✓ | **无**(SystemPromptContext 声明了但函数体没用) | **全死**:连 CLI 都没用 |
| `skillPolicy.enabledSkills` | ✓ | ✓ | buildSystemPrompt 列 skill(CLI only) | **半死**:skill 有扫描器+UI,运行时不消费 |
| `knowledgeBaseIds` | ✓ | ✓ | **无** | **不存在**:整个 knowledge-base 系统都没建 |

→ "接通死字段"其实是 **3 个性质不同的工作**,不能一锅炖。下文逐个界定。

## 3. 逐字段方案(讨论稿)

### 3.1 contextConfig(prompt 组合开关)

**现状细查**([buildSystemPrompt](../../../src/core/system-prompt.ts)):
- 组合顺序:deviceContext → originalPrompt → toolSnippets → skills。
- `useDeviceContext !== false && ctx.deviceContext` → 进 deviceContext 段。
- `useMemoryContext`:interface 里有,**函数体没引用** → 死开关。
- `useGuidelines`:interface 里**根本没有这个字段** → 死开关(guidelines 走另一条全局 config 路径,不归 buildSystemPrompt)。

**核心产品决策(待定)**:
- **Q1**:Electron 路径要不要改用 `buildSystemPrompt`(组合 device+prompt+snippets+skills)替代现在的"原始 systemPrompt 拼接"?这是把 CLI/Electron 两条 prompt 组装路径**统一**(架构统一,契合 runtime-push 不变量 4),但会**改变所有现有 agent 的实际 prompt**(原本只发原始 systemPrompt,改后多出 device/skill 段)→ 可能影响现有 agent 行为,需评估。
- **Q2**:`useGuidelines` 的语义是什么?per-agent guidelines 开关?还是 per-agent guidelines **内容**来源?(目前 guidelines 是全局 config,没有 per-agent guidelines 内容存储。)
- **Q3**:`useMemoryContext` 的语义是什么?(memory 注入开关?现在 memory 走 wiki/contextBundle,跟这个 toggle 怎么对应?)若界定不清,**建议从 UI 摘掉**这两个 toggle,避免"配了不生效"继续误导用户。

**建议路径(供讨论)**:
- 短期:把 `useDeviceContext` 接进 Electron(复用 device context 组装),`useGuidelines`/`useMemoryContext` 语义未界定前**先从 UI 移除或标灰**(诚实 > 假装可控)。
- 中期:统一 CLI/Electron 的 prompt 组装(buildSystemPrompt 共用),顺带把 guidelines 改成 per-agent 可覆盖。

### 3.2 skillPolicy.enabledSkills(skills 注入)

**现状**:[skill-scanner.ts](../../../src/server/skill-scanner.ts) 扫描 `~/.claude/skills` / `~/.agents/skills` / `~/.zero-core/skills` 的 `SKILL.md` → [skill-router.ts](../../../src/server/skill-router.ts) 暴露 REST 给 [SkillsPage](../../../src/renderer/components/skills/SkillsPage.tsx) 展示。**运行时不消费**:Electron 不列 skill,CLI 只在 buildSystemPrompt 里把 enabledSkills 列成"## Available Skills"清单(id/name/description),**不加载 skill 正文**。

**核心产品决策(待定)**:
- **Q4**:skill 在运行时该以什么形态出现?三选一(可组合):
  - (a) **清单提示**:像 CLI 那样把 enabled skills 列进 system prompt(轻,agent 知道有这些能力但得自己用文件工具去读 SKILL.md)。
  - (b) **正文注入**:把 enabled skills 的 SKILL.md 正文注入 context(中,agent 直接拿到 skill 内容,但占 context)。
  - (c) **skill 即工具**:把每个 skill 包成一个工具(agent 调用触发 skill 执行)(重,需要 skill 执行运行时)。
- **Q5**:enabledSkills 的 id 取自 skill-scanner 的 DiscoveredSkill.id;agent 配置时怎么选(现在 UI 怎么编辑 skillPolicy.enabledSkills?需要核实 [AgentEditor](../../../src/renderer/components/agents/AgentEditor.tsx) 是否有 skill 多选器,还是只能手填 id)。

**建议路径**:先做 (a) 清单注入(最低成本,对齐 CLI 既有行为),把 skillPolicy 从死字段变活;正文注入/工具化作为后续增强。

### 3.3 knowledgeBaseIds(知识库)

**现状**:**全代码库零消费**(grep 仅命中类型 + DB 列)。没有知识库存储、没有摄取/索引、没有检索、没有注入。`knowledgeBaseIds: string[]` 指向的"知识库"**根本不存在**。

**这不再是"接通字段",是"新建功能"**:
- 需要先回答 **Q6:什么是"知识库"?**(向量库?markdown 文档集?wiki 子树?web 抓取?),才能谈 ids 指向什么、怎么检索、怎么注入。
- 这是一个独立的大功能努力,体量远超 contextConfig/skillPolicy。

**建议路径**:**先从本 effort 拆出去**。本 effort 只负责 contextConfig + skillPolicy(有现成基建可接);knowledgeBaseIds 单开一个设计 effort,先把"知识库"概念定清楚再谈实现。在那之前,UI 上的 knowledgeBaseIds 选择器**建议标灰或隐藏**(同样是诚实 > 误导)。

## 4. 建议节点拆分(讨论收敛后再定稿 plan/acceptance)

| 节点 | 主题 | 依赖 | 体量 |
|---|---|---|---|
| **C1** | `useDeviceContext` 接进 Electron(复用 device context 组装)+ 热更 | 无 | 小 |
| **C2** | `useGuidelines`/`useMemoryContext`:界定语义或从 UI 移除(产品决策驱动) | Q2/Q3 结论 | 小~中 |
| **C3** | `skillPolicy.enabledSkills` 清单注入 Electron prompt(对齐 CLI)+ 热更 + UI 选择器核实 | 无 | 中 |
| **C4**(可选) | 统一 CLI/Electron prompt 组装(共用 buildSystemPrompt) | C1/C2/C3 | 中(有回归风险) |
| **KB**(独立 effort) | 知识库系统设计 + 实现 | Q6 结论 | 大,另起 |

> 每个节点都应顺带把对应字段补进 `applyConfigUpdate`(runtime-push N4 模式),保证忙时改也下轮生效。C1/C3 的热更会复用 N4 已建的 applyConfigUpdate 模式。

## 5. 待产品决策清单(讨论用)

- **Q1** Electron 是否统一用 buildSystemPrompt(改变现有 agent prompt)?
- **Q2** `useGuidelines` 的预期语义?(或移除)
- **Q3** `useMemoryContext` 的预期语义?(或移除)
- **Q4** skill 运行时形态:清单 / 正文注入 / skill 即工具?
- **Q5** skillPolicy UI 选择器现状?(核实)
- **Q6** "知识库"是什么?(决定 KB 是否单开 effort)

## 6. 不在本努力范围

- 知识库系统的实际实现(另起 effort,等 Q6)。
- runtime-push-ui-sync 的推送/UI 同步(已落地;本努力的字段接通后,其 UI 同步走 runtime-push 已建的数据:changed 通道即可)。

## 7. 相关

- [runtime-push-ui-sync.md §5](../runtime-push-ui-sync/runtime-push-ui-sync.md) 不变量 1(本 effort 是它的字段接通延伸)。
- 现状代码权威:[agent-service.ts](../../../src/server/agent-service.ts)、[system-prompt.ts](../../../src/core/system-prompt.ts)、[skill-scanner.ts](../../../src/server/skill-scanner.ts)。
