# Issue:compression-archive-simplify

- **状态**:② design(用户直接进 design;问题记录如下)
- **提出**:2026-07-13
- **类型**:机制加固 + 改进

## 问题

压缩(compression)与归档(archive)机制过于复杂,实际运行问题多:
1. 压缩与"写 wiki 记忆"耦合在一个**外部多 loop extractor agent**(ExtractorA)里——慢、可中断、**中断后无法恢复**。
2. 每次压缩/归档都机械地把摘要合并进 wiki,**没必要且增加复杂度**。
3. 存在大量**死代码 / 假配置面**(看着能配其实不生效)。
4. 归档**非原子、不可逆、无轮转、final compression 失败静默丢数据**。

## 现状 / 真相源 / 影响面(证据)

### 压缩侧
- 压缩触发全在 hook:`compression-trigger-hooks.ts`(TurnStart/StepEnd/PreLLMCall/OnLLMError),触发状态是**内存 Map,重启即丢**→ 重启后超阈值就再压(`:125`)。
- 压缩核心 `compression-core.ts`:单 loop `generateText` 生成摘要(`:390`),**但每个 segment 还 fire-and-forget 喂 ExtractorA 多步 agent 合并进 wiki**(`:438`)——这就是慢/可中断/不可恢复的源头。
- 数据模型 3 区:`[FIFO-3 摘要] + [stubbed 中段] + [fresh tail]`(`session.ts:608-664`);FIFO cap=3 硬编码,最旧摘要**永久驱逐**(`session-db.ts:662`)。
- fresh-tail 边界逻辑**复制两份**且互称"必须同步":`compression-core.ts:228` + `session.ts:704`。
- `prompt_too_long` 时**两套压缩都触发**:hook 压一遍 + loop 再 `aggressivePrune(0.5)`(`agent-loop.ts:1722`)。
- 摘要有效性靠**中英文正则**校验(`compression-core.ts:208`)。

### 死代码 / 假配置面
- `compaction.ts` + `context-manager.ts`:**零生产调用**,仅 doc 生成器引用。
- `compaction.*` / `context.*` 配置面(`config.ts:65-125`):**只喂上面两个死模块**,settings UI 里看着像活的。
- `compression.enabled/provider/model`(`config.ts:140`):文档有,**触发 hook 根本不读**;默认 `enabled:false` 却不禁用压缩。模型实际来自 `extractors.A.*`。
- `steps.compressed` 列(`session-db.ts:220`):有 schema **无写入**,纯噪声。

### 归档侧
- 归档管线 `archive-service.ts`:导出 `~/.zero-core/archives/<agentId>/<sessionId>.json` + 删 DB 行。
- **非原子**:写 JSON 与删行两步无事务(`:442-449`);**不可逆**(明确无 restore 通路,`:37-41`);**无轮转**(文件永久累积)。
- final compression **best-effort,失败只 warn 然后继续删行**→ 残留 step 记忆静默丢失(`:344-352`)。
- `archive-service.ts:202-263` 的 `buildFinalCompressOpts` 是 trigger hook opts builder 的**近复制**,会漂移。
- 归档也调 ExtractorA(`:243`)——同源问题。

### ExtractorA 消费者审计
- 活跃消费者**只有 2 处**:compression-core:438 + archive-service:243(都是 `mergeSummaryIntoWiki`)。
- `extraction-hooks.ts` 已**退役为 no-op stub**(sub-7 决策 53)。
- → 拆掉这 2 处后,**ExtractorA 多步 agent 可整体删除**(ExtractorB 留,是 tool telemetry 独立数据流)。

## 下一步

design 已开始,见 [./design.md](./design.md)。
