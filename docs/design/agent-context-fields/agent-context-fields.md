# Design:Agent 上下文字段接通(从死字段到运行时生效)

> 状态:**Draft,讨论中**。
> 一句话:`AgentRecord` 上有三个 UI 可编辑、DB 持久化、但 **Electron 运行时路径零消费** 的字段(contextConfig / skillPolicy / knowledgeBaseIds)。本努力界定每个字段的真实现状、决定哪些值得接通、以及怎么接。
> 起源:runtime-push-ui-sync N4 实现时核实这三个字段为"死字段",编排者与用户决策:接通它们另起本 effort,不在 N4 范围。详见 [runtime-push-ui-sync.md §5](../runtime-push-ui-sync/runtime-push-ui-sync.md)。

---

## 1. 背景:为什么有"死字段"

`AgentRecord`([shared/types.ts](../../../src/shared/types.ts) L37–54)定义了一组"上下文/能力"字段,有 DB 列([agent-store.ts](../../../src/server/agent-store.ts) COLUMNS)、UI 可编辑([AgentEditor](../../../src/renderer/components/agents/AgentEditor.tsx) / [PromptSection](../../../src/renderer/components/agents/PromptSection.tsx)),但运行时跑 agent 时**根本不读它们**:

- **Electron 路径**([agent-service.ts createLoopForSession](../../../src/server/agent-service.ts#L588) L601–612):`systemPrompt = agent?.systemPrompt ?? ""`(原始),`guidelines` 取自**全局** `this.config.systemPrompt.guidelines`,`model/provider/thinkingLevel/toolPolicy/subagents/wikiAnchors` 取自 agent。**完全不传** contextConfig/skillPolicy/knowledgeBaseIds。

后果:用户在 UI 改这些字段,UI 显示新值,但运行时我行我素——**所见≠所跑**(正是 runtime-push 不变量 1 想消的缝隙,只是这几个字段连"所跑"都没有)。

## 1.5 已确认:运行时真正的 prompt 从哪来(消除"两套系统"错觉)

实地追踪(2026-07-04):Electron 运行时的 prompt 由**两套运行时机制**组合,**都不是** `core/buildSystemPrompt`:

1. **system prompt 本体** = [promptAssembler.assemble()](../../../src/runtime/agent-loop.ts#L790)([agent-loop.ts:790](../../../src/runtime/agent-loop.ts#L790))。各 section(base = `config.systemPrompt` = `agent.systemPrompt`,+ wiki system-channel 锚点…)拼成,作为 `system:` 字段送 LLM(L745)。
2. **每 turn `<context>` 块** = [buildContextMessage(...)](../../../src/runtime/context-message.ts) —— 环境 + guidelines + current-task + memory/wiki-anchors + todos,每 turn 插在最后一条 user 消息前(L667/729)。

而 [core/buildSystemPrompt](../../../src/core/system-prompt.ts) 是**旧 composer**(组合 device + prompt + snippets + skills),现在**只有 headless CLI**([cli.ts:196](../../../src/cli.ts#L196))在用,并从 [index.ts:37](../../../src/index.ts#L37) re-export。**Electron 运行时完全不调它**——是改迁没删干净的旧系统,造成"两套 prompt 组装"的错觉。

→ 直接后果:contextConfig 的 toggle 在 Electron **全无效**,因为 `buildContextMessage` 根本不读 contextConfig——环境块(`buildEnvironmentBlock`)永远注入、guidelines(全局)非空就永远注入、memory 走 hook(workflow-context)不走 toggle。

**遗留清理项(待决策)**:`core/buildSystemPrompt` + `SystemPromptContext` 是 CLI-only legacy。选项:(a) 保留(CLI 还在用);(b) 把 CLI 也迁到 runtime 的 promptAssembler/buildContextMessage,统一后删 core/buildSystemPrompt;(c) 若 CLI 已不活跃,直接删。需确认 CLI 是否为活跃路径再定。

## 2. 三字段不是一类,得分开看

| 字段 | DB 列 | UI 可编辑 | 运行时消费点 | 真实性质 |
|---|---|---|---|---|
| `contextConfig.useDeviceContext` | ✓ | ✓ | **无**(Electron 环境块永远注入,不读此 toggle;CLI 的 buildSystemPrompt 读) | **Electron 全死**(toggle 被忽略) |
| `contextConfig.useGuidelines` | ✓ | ✓ | **无**(Electron guidelines 走全局 config;buildSystemPrompt 无此参数) | **全死** |
| `contextConfig.useMemoryContext` | ✓ | ✓ | **无**(buildContextMessage 的 memoryContext 走 hook,非 toggle) | **全死** |
| `skillPolicy.enabledSkills` | ✓ | ✓ | **无**(skill 尚未正式接入运行时;CLI 的 buildSystemPrompt 会列清单) | **全死**(官方确认未接入) |
| `knowledgeBaseIds` | ✓ | ✓ | **无**(知识库已合并进 wiki;字段还没接 wiki 选择/注入) | **死字段,但有消费目标**(wiki) |

→ "接通死字段"是 **3 个性质不同的工作**,下文逐个界定。

## 3. 逐字段方案(讨论稿)

### 3.1 contextConfig(prompt 组合开关)

**现状**(见 §1.5):Electron 的 `buildContextMessage` 不读 contextConfig——环境永远在、guidelines(全局)非空永远在、memory 走 hook。三个 toggle 在 app 路径全无效果。

**核心产品决策(待定)**:
- **Q1(已答)**:Electron 不需要"改用 buildSystemPrompt"——它有更新更完整的 `promptAssembler + buildContextMessage`。要做的不是迁移,而是**让 contextConfig 的 toggle 真正门控 buildContextMessage 的对应段落**(per-agent 开/关 device/guidelines/memory)。
- **Q2**:`useGuidelines` 的预期语义?per-agent 开关(关掉 = 这个 agent 不注入全局 guidelines)?还是 per-agent guidelines **内容**?(目前 guidelines 只有全局,无 per-agent 内容存储。)
- **Q3**:`useMemoryContext` 的预期语义?门控 memory/wiki-anchor 注入?还是门控 workflow-context hook?若界定不清,**建议从 UI 摘掉**这两个 toggle,避免继续误导。
- **遗留清理**:是否把 `core/buildSystemPrompt` 删掉/统一(见 §1.5 清理项)。

**建议路径(供讨论)**:
- 短期:把 contextConfig 接进 `buildContextMessage`(per-agent 门控 device/guidelines/memory 段)。`useGuidelines`/`useMemoryContext` 语义未界定前**先从 UI 移除或标灰**(诚实 > 假装可控)。
- 顺带:决定 core/buildSystemPrompt 的去留(§1.5)。

### 3.2 skillPolicy.enabledSkills(skills 注入)

**现状**:[skill-scanner.ts](../../../src/server/skill-scanner.ts) 扫描 `~/.claude/skills` / `~/.agents/skills` / `~/.zero-core/skills` 的 `SKILL.md` → [skill-router.ts](../../../src/server/skill-router.ts) 暴露 REST 给 [SkillsPage](../../../src/renderer/components/skills/SkillsPage.tsx) 展示。**官方确认:skill 尚未正式接入运行时**——Electron 完全不消费,CLI 的 buildSystemPrompt 也只是把 enabledSkills 列成清单(不加载正文)。

→ 本字段属于"**已知未接入的功能**",不是退化 bug。接通它是**新功能开发**,优先级由产品定。

**核心产品决策(待定)**:
- **Q4**:skill 接入运行时的形态?三选一(可组合):
  - (a) **清单提示**:把 enabled skills 列进 prompt(轻,agent 知道有这些能力但得自己用文件工具读 SKILL.md)。
  - (b) **正文注入**:把 enabled skills 的 SKILL.md 正文注入 context(中,占 context)。
  - (c) **skill 即工具**:每个 skill 包成一个工具(重,需要 skill 执行运行时)。
- **Q5**:agent 配置时怎么选 skill?核实 [AgentEditor](../../../src/renderer/components/agents/AgentEditor.tsx) 是否有 skillPolicy.enabledSkills 的多选器,还是只能手填 id。

**建议路径**:作为独立功能 effort(可叫 "skill 接入"),不在本 contextConfig 努力里强行塞。先做 (a) 清单注入成本最低。

### 3.3 knowledgeBaseIds(知识库 = wiki 子树)

**现状(用户澄清 2026-07-04)**:**知识库已合并进 wiki**。所以 `knowledgeBaseIds: string[]` 的消费目标 = **选择 wiki 节点/子树注入 agent context**。运行时已有 wiki 注入基建([wiki-anchor-injection.ts](../../../src/runtime/wiki-anchor-injection.ts) 的 `renderContextAnchors` / system-channel 锚点),knowledgeBaseIds 可复用这套,把选中的 wiki 节点作为锚点注入。

→ 这不再是 greenfield(原 §3.3 的判断已修正),而是**给已有 wiki 注入机制加一个"按 knowledgeBaseIds 选节点"的入口**。

**核心产品决策(待定)**:
- **Q6(已答)**:知识库 = wiki。knowledgeBaseIds 指向 wiki 节点 id。
- **Q7**:knowledgeBaseIds 与现有 `wikiAnchors`(AgentRecord 上已生效的字段)什么关系?是同一回事(知识库 = wikiAnchors 的别名/超集),还是正交(knowledgeBaseIds 选内容子树、wikiAnchors 选结构锚点)?若重叠,可能应**合并字段**而非接两个。
- **Q8**:UI 上 knowledgeBaseIds 选择器现状?(核实是否有 wiki 节点多选器。)

**建议路径**:核实 Q7(与 wikiAnchors 的关系)→ 若正交,按 wiki 节点选择注入实现;若重叠,合并字段。复用 wiki-anchor-injection 基建。

## 4. 建议节点拆分(讨论收敛后再定稿 plan/acceptance)

| 节点 | 主题 | 依赖 | 体量 |
|---|---|---|---|
| **C1** | contextConfig 接进 `buildContextMessage`(per-agent 门控 device/guidelines/memory)+ 热更 | Q2/Q3 语义 | 小~中 |
| **C2** | `useGuidelines`/`useMemoryContext` 语义界定或从 UI 移除 | Q2/Q3 | 小 |
| **C3** | 清理 `core/buildSystemPrompt`(删/统一/留)——核实 CLI 活跃度 | §1.5 清理项 | 小~中 |
| **C4** | knowledgeBaseIds → wiki 节点选择注入(核实与 wikiAnchors 关系) | Q7/Q8 | 中 |
| **SKILL**(独立 effort) | skill 正式接入运行时(清单/正文/工具) | Q4/Q5 | 中~大,另起 |

> 每个节点都应顺带把对应字段补进 `applyConfigUpdate`(runtime-push N4 模式),保证忙时改也下轮生效。

## 5. 待产品决策清单(讨论用)

- **Q1**(已答)Electron 用 promptAssembler+buildContextMessage,非 buildSystemPrompt;要做的是让 contextConfig 门控 buildContextMessage。
- **Q2** `useGuidelines` 的预期语义?(或移除)
- **Q3** `useMemoryContext` 的预期语义?(或移除)
- **Q4** skill 运行时形态:清单 / 正文注入 / skill 即工具?
- **Q5** skillPolicy UI 选择器现状?(核实)
- **Q6**(已答)知识库 = wiki;knowledgeBaseIds 指向 wiki 节点。
- **Q7** knowledgeBaseIds 与 wikiAnchors 的关系?(正交 / 重叠 → 合并?)
- **Q8** knowledgeBaseIds UI 选择器现状?(核实)
- **Q9** core/buildSystemPrompt 去留?(CLI 是否活跃?)
- **Q10** skill 接入是否单开 effort?(建议是)

## 6. 不在本努力范围

- skill 接入运行时的实际实现(单开 effort,等 Q4)。
- runtime-push-ui-sync 的推送/UI 同步(已落地;字段接通后其 UI 同步走 runtime-push 已建的数据:changed 通道)。

## 7. 相关

- [runtime-push-ui-sync.md §5](../runtime-push-ui-sync/runtime-push-ui-sync.md) 不变量 1(本 effort 是它的字段接通延伸)。
- 现状代码权威:[agent-service.ts](../../../src/server/agent-service.ts)、[agent-loop.ts assembleSystemPrompt/buildContextMessage](../../../src/runtime/agent-loop.ts)、[context-message.ts](../../../src/runtime/context-message.ts)、[wiki-anchor-injection.ts](../../../src/runtime/wiki-anchor-injection.ts)、[skill-scanner.ts](../../../src/server/skill-scanner.ts)。
