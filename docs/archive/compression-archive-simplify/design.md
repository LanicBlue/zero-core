# Design:compression-archive-simplify

> 状态:**Ready,可进 plan**。
> 对应 issue:[`./issue.md`](./issue.md)(同目录,随文件夹流转)。
> 范围说明:本 effort 除压缩/归档外,顺带**调整 wiki 注入默认根**(memory+project/global 进 system prompt + 冻结快照;**保留 free wikiAnchors 可配锚点**)——因为它直接决定 memory-turn 的 cache 行为。

## 问题回顾(详见 ./issue.md)

压缩+记忆耦合外部多 loop extractor(ExtractorA),慢/可中断/不可恢复;每次压缩归档机械写 wiki;死代码/假配置面堆积;归档非原子/不可逆/静默丢数据;wiki 注入默认根走 context 通道(每轮重算,in cached prefix → wiki 写 invalidate cache)。

## 关键事实(审计,决策依赖)

1. **ExtractorA 可连根拔**:活跃消费者只有 `compression-core.ts:438` + `archive-service.ts:243`;`extraction-hooks.ts` 退役 no-op。拆这 2 处 → ExtractorA 整体可删。
2. **持久化 hook 驱动** → ephemeral turn = `persist:false` flag 穿过持久化 hook。
3. session 已有 wiki 写工具,memory=wiki 不需新工具。
4. 摘要已是单 loop `generateText`;慢的是挂的 ExtractorA。
5. fresh-tail 边界复制两份;3 区 + FIFO-3 + stubbed 中段可收敛 2 区。
6. 归档缺保险:export+delete 非事务、无 restore、final compression 静默。
7. **wiki 注入现状(核对后)**:per-agent memory 默认 `inject:"context"`(renderContextAnchors,每轮重算,prepend 进 messages,**在 cached prefix 区**);project 默认 `inject:"system"`(cached system prompt);"Recalled Memories" channel = 空占位;free wikiAnchors = UI 可配每锚点 inject。**结论:context 通道在 cached prefix,wiki 写入会 invalidate cache**——改默认根进 system + 冻结快照的根因。

## 参考印证(hermes-agent)

- 干净记忆路径 = session 用 `memory` 工具自写(无 extractor);重型后台 fork extractor 是额外加的,正是我们要砍的。方向印证。
- 滚动摘要:`_previous_summary` + update(旧+新)而非重述 → 印证 O6。
- **借鉴三机制**:① **冻结 memory 快照**(采用——默认 wiki 根进 system prompt + 冻结,保 prefix cache);② 摘要 handoff 前缀(防陈旧泄漏);③ DB per-session 锁(并发,仅归档用)。

## 已对齐决策(全部已定)

- **D1**:memory = wiki,session 自写,替代 ExtractorA。
- **D2**:摘要外部单 loop;**prompt 在 settings/memory 可调可改**(默认现 SUMMARY_SYSTEM;输出 sections 契约固定;改坏 fallbackSections 兜底)。
- **D3/Q5b**:session 自然结束时写 memory(子 agent task-finish / 手动归档前),ephemeral。
- **D4/Q4**:归档无 final compression;Q4 定时出库窗口砍掉。
- **Q2 / GAP1(双机制双阈值)**:
  - **Force 档**(cold / hot+hard):hook 变**信号**,AgentLoop 协调 → 跑 memory ephemeral turn(persist:false)→ `compressSession`。强制。
  - **Remind 档**(hot+soft):注入 appendMessage 提示 → agent **自写 memory + 自判是否压缩**(沿用现 remind 语义,扩展到 memory)。软。
- **Archive = (I) export+delete 即时原子**(选 export 不选软标记:DB 涨代价真实,export 无 LLM 廉价;保险靠原子写+JSON 备份)。
- **Wiki 注入(最小改动)**:**默认注入根** = memory-root + (project-root | global-root-if-zero),统一 doc+一层 summary,都进 **system prompt + 冻结快照**(session 开始 / 压缩后刷新);即 memory-root 默认 inject 从 context 改 system,zero 的 global-root 从 scope-only 改注入。**保留 free wikiAnchors + per-anchor inject UI**(用户仍可加自定义锚点;inject:system 也享冻结快照,inject:context 仍每轮重算——用户显式选择,接受其 cache 行为)。
- **GAP2(已定:退化 re-activate)**:`fireOnTaskTerminal` 后对**从没压缩过**的短 session re-activate 跑一轮 memory turn;**压缩过的长 session 已在 compression memory turn 写过 wiki**,归档直接 export。
- **O1**:ephemeral turn = `persist:false`。
- **O3**:归档用现有 `archived` 列作瞬态 mark,无需新列。
- **O6**:滚动摘要 update(旧+被压 steps)+ handoff 前缀 + **长度上限**(maxOutputTokens 预算,防累积膨胀)。
- **O7**:压缩模型配置改名 `compression.provider/model`。

## 核心原则

**写记忆 = session 自写 memory(wiki)的 ephemeral turn**,两触发点:① 压缩阈值(Q2 双机制)② session 结束/归档(Q5b)。砍 ExtractorA(整体可删);默认 wiki 根进 system + 冻结快照(保 cache);压缩双机制 + 2 区滚动摘要 + handoff;归档 = 自写 memory + 即时原子 export。

---

## 方案

### 零、Wiki 注入默认根调整(新,前置,最小改动)

- **默认注入根** memory-root + (project-root | global-root-if-zero)outline → **system prompt**(SystemPromptAssembler wiki-anchors section),**冻结快照**:session 开始定格,只在**压缩后**(cache 本就 reset)刷新。
- `resolveAnchors` 默认根:memory-root(inject 从 context 改 **system**)+ project-root(system);zero(无 project)用 global-root 代替 project(从 scope-only 改**注入**,doc+一层,受 cap 有界)。
- **保留 free wikiAnchors + per-anchor inject UI**(AgentRecord.wikiAnchors / agent-registry / settings 不动);inject:system 的也享冻结快照,inject:context 仍走 `renderContextAnchors` 每轮重算(用户显式选择)。
- mid-session wiki 写**不触发** system 锚点 snapshot 刷新 → cache 稳定;新内容下个 session / 压缩后可见。即时看新节点用 docRead。

### 一、Ephemeral turn 机制(核心基建)

注入提示 → session 用 wiki 工具写 → **step 不落盘**(只留 wiki 副作用)。
- `persist:false` flag 穿过持久化 hook(TurnStart appendStep / StepEnd seal 跳过)。
- 中断 → 无脏状态,wiki 写独立(部分=少几条),重试安全。

### 二、压缩流程(新,双机制)

- **Force 档**(cold / hot+hard 阈值):compression-trigger hook 检测到 → 不直接 compress,改为 **signal AgentLoop**;Loop 跑 memory ephemeral turn(await)→ `compressSession`:
  - 单 loop generateText:滚动摘要 = **update(旧摘要 + 被压 steps)**,handoff 前缀
  - 用新摘要替换 [旧摘要 + 被压 steps];游标前进(原子事务)
- **Remind 档**(hot+soft):hook 注入 appendMessage 提示("上下文偏大,可写 memory;若认为该压缩就表示")→ agent 自写 memory + 自判压缩。(agent 如何"请求压缩"——ack 解析 vs Compress 工具——plan 细化。)
- **数据模型 3 区 → 2 区**:`[滚动摘要(handoff)] + [fresh tail]`。删 FIFO-3 / stubbed 中段 / 复制边界 / prompt_too_long 双触发。
- fresh-tail 边界**去重一份** + **按 step 原子切,不劈开 tool_use/result 对**。
- DB 锁:**仅归档并发**用;压缩仍用内存 `inFlight` guard。

### 三、归档流程(新,(I) 即时 export)

```
session 自然结束(子 agent task-finish / 手动归档)
  → memory ephemeral turn(自写 wiki)        ← Q5b,LLM 慢动作
  → mark(archived=1,瞬态崩溃检查点)
  → 原子 export(tmp+rename+校验可解析)+ 删行   ← 无 LLM,廉价
```
- 子 agent(GAP2 已定):`fireOnTaskTerminal` 后,**从没压缩过**的短 session → re-activate 跑一轮 memory turn → export;**压缩过**的长 session(compression memory turn 已写 wiki)→ 直接 export。
- 手动归档:活跃 session 先跑 memory ephemeral turn → mark → export。
- 保险:原子写(校验通过才删)+ JSON 备份 + optional restore + optional 轮转。
- 可恢复:mark→export 间崩 → 重启扫 `archived=1 且仍有行` 的 session 重跑 export。
- 砍 final compression、`buildFinalCompressOpts` 复制、ExtractorA archive 耦合。

### 四、死代码 / 假配置清理(纯减法)

- 删 `compaction.ts` + `context-manager.ts` + re-export + `context.*` 配置面;`compaction.*` 被 D2 可配 prompt 取代。
- 删 `steps.compressed` 列 + migration。
- `compression.enabled`(未读)删;模型配置改名 `compression.provider/model`。
- **删 ExtractorA**:`extractor-a-service.ts` + 两 lazy import + `buildExtractorA` wiring + 退役 `extraction-hooks.ts` stub(确认 ExtractorB 不受影响)。
- (wiki 注入只改默认根 + 加冻结快照,**不删** free wikiAnchors / renderContextAnchors。)

### 五、保险

- 归档原子化 + JSON 备份 + optional restore/轮转;DB 锁(归档并发);final compression 移除(去静默)。
- 默认根冻结快照 → cache 稳定(默认 wiki 写不 invalidate;free context-锚点写仍会,用户显式选择)。

## 推荐

核心 = "session 自写 memory 的 ephemeral turn" 替代外部 ExtractorA(整体可删)。默认 wiki 根进 system + 冻结快照(保 cache,保留可配锚点)。压缩双机制(force 协调 / remind 自判)+ 2 区滚动摘要 + handoff。归档 = 自写 memory + 即时原子 export。死代码独立减法。

## 风险

- **ephemeral turn 新基建**:验 session 不落盘 step 能正常跑工具(wiki 写跨进程/in-process)。关键路径。
- **Force 档协调**:hook→signal + Loop 协调跑 turn 是压缩触发流程的结构改动(hook 不能跑嵌套 turn,必须 Loop 协调)。
- **Remind 档压缩请求机制**:agent 自判压缩的触发(ack vs 工具)plan 定。
- **注入调整**:frozen snapshot 使 mid-session 默认根 wiki 写当轮 system prompt 不可见(用 docRead 兜);zero 的 global-root outline 受 cap 有界但跨项目可能偏大。free wikiAnchors 保留,无用户面回归。
- **滚动摘要失真**:memory turn 兜跨会话事实,handoff 防泄漏,必要时从原始 steps 重生。
- **ExtractorA 删除回归**:`extractDelta` legacy + `buildExtractorA` 全调用点 + 测试。
- **export 边界**:大 session 全量读+写占内存,可流式,无 LLM 仍廉价。

## sub 拆分建议(进 plan 细化)

0. **Wiki 注入默认根调整**(前置,独立)——默认根(memory+project/global)进 system + 冻结快照 + zero global-root 注入;保留 free wikiAnchors。
1. **ephemeral turn 基建**(`persist:false`)——前驱。
2. **压缩流程**(拆 sub-3a/3b/3c,顺序依赖):
   - **3a** 数据模型 3区→2区 + fresh-tail 边界去重/不切对 + 去 prompt_too_long 双触发。
   - **3b** 滚动摘要 update + handoff + cap + prompt 可配 + ExtractorA compression 拆除。
   - **3c** 双机制 Force/Remind + memory ephemeral turn 协调。
3. **归档**(Q5b + GAP2 re-activate + 即时原子 export + DB 锁)。
4. **死代码清理**(并行)。

## 下一步

`/effort plan` 拆 sub(每个配 acceptance)。
