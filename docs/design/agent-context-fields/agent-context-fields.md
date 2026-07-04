# Design:Agent 上下文字段接通(从死字段到运行时生效)

> 状态:**C1/C2/C3 已实现并合入 master;SKILL 接入待单开 effort**。
> 一句话:`AgentRecord` 上有三个 UI 可编辑、DB 持久化、但 Electron 运行时零消费的字段(contextConfig / skillPolicy / knowledgeBaseIds)。本努力界定真实现状并接通/清理。
> 起源:runtime-push-ui-sync N4 核实这三个字段为"死字段",接通另起本 effort。详见 [runtime-push-ui-sync.md §5](../runtime-push-ui-sync/runtime-push-ui-sync.md)。

---

## 0. 已锁定决策(2026-07-04 用户拍板)

- **Q2/Q3 → 可以**:`useGuidelines` / `useMemoryContext` 从 UI 移除(语义界定不清,诚实 > 假装可控)。
- **Q7 → 合并**:`knowledgeBaseIds` 并入 `wikiAnchors`(知识库 = wiki;两个字段重叠,合并而非接两个)。
- **Q9 + 全局约束 → 不影响当前 system + context 两块 prompt**:不改 `promptAssembler` system 块与 `buildContextMessage` context 块的**现有行为**;`core/buildSystemPrompt`(CLI legacy)维持原样不清理。新增/移除只走"默认等价"路径。

## 1. 背景:为什么有"死字段"

`AgentRecord`([shared/types.ts L37–54](../../../src/shared/types.ts))有 contextConfig / skillPolicy / knowledgeBaseIds 三组字段:DB 有列、UI 可编辑、运行时零消费。
Electron 路径([agent-service.ts createLoopForSession L601–612](../../../src/server/agent-service.ts#L601)):`systemPrompt = agent?.systemPrompt ?? ""`,`guidelines` 取全局,完全不传这三组字段 → **所见≠所跑**。

## 1.5 运行时真正的 prompt 从哪来(消除"两套系统"错觉)

实地追踪:Electron 运行时 prompt 由两套机制组合,**都不是** `core/buildSystemPrompt`:

1. **system 本体** = [promptAssembler.assemble()](../../../src/runtime/agent-loop.ts#L790)(base = `agent.systemPrompt` + wiki system-channel 锚点…)。
2. **每 turn `<context>` 块** = [buildContextMessage(...)](../../../src/runtime/context-message.ts)(环境 + guidelines + current-task + memory/wiki-anchors + todos)。

[core/buildSystemPrompt](../../../src/core/system-prompt.ts) 是旧 composer,**只剩 headless CLI**([cli.ts:196](../../../src/cli.ts#L196))在用。→ 改迁没删干净的 legacy,造成"两套 prompt 组装"错觉。**按 Q9 决策维持原样不清理**(清理可能动 CLI prompt,且对 Electron 无收益)。

直接后果:contextConfig toggle 在 Electron 全无效——`buildContextMessage` 不读它们(环境永远注入、guidelines 全局非空永远注入、memory 走 hook)。

## 2. 三字段现状(决策后)

| 字段 | 决策 | 处理 |
|---|---|---|
| `contextConfig.useDeviceContext` | 保留 + 接通 | 接进 buildContextMessage 作 per-agent 门控(默认开 = 当前行为) |
| `contextConfig.useGuidelines` | 移除 | UI 摘除;字段废弃(见 C2) |
| `contextConfig.useMemoryContext` | 移除 | UI 摘除(已标 reserved);字段废弃(见 C2) |
| `skillPolicy.enabledSkills` | 未接入(官方确认) | 不在本 effort;单开 SKILL effort(见 §5 Q4) |
| `knowledgeBaseIds` | 合并进 wikiAnchors | 字段废弃,UI 指向 wikiAnchors 选择器(见 C3) |

## 3. 逐项方案

### 3.1 useDeviceContext 接通(C1)
- 在 [buildContextMessage](../../../src/runtime/context-message.ts) 的 `buildEnvironmentBlock` 注入点加门控:`useDeviceContext !== false` 才推环境段(对齐 CLI buildSystemPrompt 的 `useDeviceContext !== false` 语义)。
- **默认等价(满足全局约束)**:Electron 现 `useDeviceContext` 未传 = undefined → `!== false` = true → 环境段照旧注入。只有用户显式关才不注入。现有 agent 行为零变化。
- contextConfig 须经 SessionConfig 传到 agent-loop(目前没传)。补 `sessionConfig.contextConfig` + agent-service createLoopForSession 传 `agent.contextConfig`。
- 热更:applyConfigUpdate 补 contextConfig 写回(N4 模式)。promptAssembler base 不受影响(只门控 context 块的环境段,不动 system 块)。

### 3.2 移除 useGuidelines / useMemoryContext(C2)
- UI:[PromptSection.tsx L98-107](../../../src/renderer/components/agents/PromptSection.tsx#L98) 删 Guidelines + Memory(reserved)两个 checkbox,只留 Device Context。
- 类型:`AgentRecord.contextConfig` 收窄为只剩 `useDeviceContext?`(从 [types.ts L37-40](../../../src/shared/types.ts#L37))。
- DB:`context_config` 列是 JSON 单列,收窄类型即可,旧数据里的 useGuidelines/useMemoryContext 键读回后被忽略(向前兼容,无需 migration)。
- **不动 system/context prompt 现有行为**:这俩 toggle 本来就没消费,移除零影响。

### 3.3 knowledgeBaseIds 合并进 wikiAnchors(C3)
- 知识库 = wiki(Q6);knowledgeBaseIds 与 wikiAnchors 重叠(Q7 → 合并)。
- 废弃 `knowledgeBaseIds` 字段([types.ts L54](../../../src/shared/types.ts#L54))。UI 上原本选 knowledgeBaseIds 的入口改为指向 `wikiAnchors` 选择器(已生效字段,inject/depth)。
- wikiAnchors 已是 live(runtime 经 wiki-anchor-injection 注入),合并后"选 wiki 节点注入"统一走 wikiAnchors。
- DB:`knowledge_base_ids` 列保留(向前兼容),store 不再 round-trip(类 role_tag 模式)。
- 核实:[AgentEditor](../../../src/renderer/components/agents/AgentEditor.tsx) / agent-editor-types 里 knowledgeBaseIds 的 UI 接法,改为复用 wikiAnchors 选择器或直接删该输入。

## 4. 节点拆分

| 节点 | 主题 | 体量 | 状态 |
|---|---|---|---|
| **C1** | useDeviceContext 接通(buildContextMessage 门控 + SessionConfig 传参 + applyConfigUpdate 热更) | 小 | ✅ 已实现 |
| **C2** | 移除 useGuidelines/useMemoryContext(UI + 类型收窄) | 小 | ✅ 已实现 |
| **C3** | knowledgeBaseIds 合并进 wikiAnchors(字段废弃 + COLUMNS 移除,DB 列保留) | 小 | ✅ 已实现 |
| ~~C4~~ | ~~清理 core/buildSystemPrompt~~ | **取消**(Q9 约束) | — |
| **SKILL** | skill 正式接入运行时(独立 effort) | 另起 | 待启动 |

> C1/C2/C3 互相独立、都小,可一起做。每个走 runtime-push N4 的验收模式(三层 tsc + build:lib + vitest + applyConfigUpdate 热更用例)。

## 5. 待决策/开放项

- **Q1**(已答)Electron 用 promptAssembler + buildContextMessage。
- **Q2/Q3**(已答)移除 useGuidelines/useMemoryContext。
- **Q4**(开放)skill 运行时形态:清单/正文/工具 → SKILL 独立 effort。
- **Q5**(开放)skillPolicy UI 选择器现状 → SKILL effort 核实。
- **Q6**(已答)知识库 = wiki。
- **Q7**(已答)合并 knowledgeBaseIds → wikiAnchors。
- **Q9**(已答)core/buildSystemPrompt 不动。
- **Q10**(建议)skill 接入单开 effort。

## 6. 不在本努力范围

- skill 接入实现(单开 effort,等 Q4)。
- runtime-push 推送/UI 同步(已落地;字段接通后 UI 同步走 data:changed)。

## 7. 相关

- [runtime-push-ui-sync.md §5](../runtime-push-ui-sync/runtime-push-ui-sync.md) 不变量 1。
- 代码权威:[agent-service.ts](../../../src/server/agent-service.ts)、[agent-loop.ts](../../../src/runtime/agent-loop.ts)、[context-message.ts](../../../src/runtime/context-message.ts)、[PromptSection.tsx](../../../src/renderer/components/agents/PromptSection.tsx)、[types.ts](../../../src/shared/types.ts)。
