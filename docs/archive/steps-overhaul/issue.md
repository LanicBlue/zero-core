# Issue:steps-overhaul

- **状态**:① issues(问题记录)
- **提出**:2026-07-09
- **类型**:改进(架构 / 存储 / UX)
- **关联**:[`../multimodal-input/`](../multimodal-input/)(multimodal-input 会给 turns 表加 `attachments` 列,本 effort 若改表名/结构需协调顺序)
- **scope 扩大(2026-07-10)**:含**压缩策略重整**(压缩与表结构强耦合)+ **吸收 session-archive-memory issue**(后台 session 跑完自动归档 + 提记忆;归档 = 压缩记忆之上加导出 JSON + 删库,父/子 agent 通用)。原 `docs/issues/session-archive-memory/` 已并入本 effort。

## 问题

session 的 step 存储层(`turns` 表)+ 压缩 + 体积感知三件事各自不顺手,合在一起整治:

1. **表名 `turns` 名不副实**:表按 **step** 持久化(`seq`/`turn_group`/token),TS API 也早已叫 step(`getSteps`/`appendStep`/`upsertStep`/`cachedTurns`),唯独表名还叫 `turns`,且与 compression 里"turn = 一组 step"的概念(`TurnBoundary`/`identifyTurns`)混淆。应正名为 `steps`。
2. **chat UI 缺 session 内容量的清晰展示/确认**:现有 `context-usage` 条只显示 token `used/window`(ChatPanel.tsx:742-767),用户看不出"这个 session 累积了多少 step、多大、离压缩还多远"。需要一个更明确的 session 内容量确认(show step 数 / 体积 / 压缩余量)。
3. **压缩是反应式,缺"预压缩"**:`compression-hooks.ts` 在 PreLLMCall 跑,`contextUsage > l1Threshold(0.7)` 才触发 `compressIfNeeded`(L1 压最旧 turn / L2 抽 memory,`keepRecentTurns 5`)。问题:用户撞到阈值时压缩在请求路径上**同步**发生 → 首字延迟;且没有"提前/后台"压缩,体验是"突然压一下"。想要**预压缩**(主动/提前/后台,而非被动撞墙)。

## 现状 / 真相源

### 表(`turns`,实存 step)
- `src/server/session-db.ts:144-158` — `turns` 表(`id/session_id/seq/role/content/compressed/turn_group/input_tokens/output_tokens/total_tokens`)。按 step 存(`seq`)。
- TS API 已 step 化:`getSteps`/`appendStep`/`upsertStep`/`getCachedTurns`/`rebuildFromTurns`。表名是唯一不一致点。
- compression 的"turn"是另一个概念(`TurnBoundary`/`identifyTurns`,`src/runtime/compression-engine.ts:106`)—— 改表名不能动它。

### 压缩(反应式)
- `src/runtime/hooks/compression-hooks.ts:78-103` — PreLLMCall hook,`contextUsage <= l1Threshold(0.7)` 直接 return,否则 `engine.compressIfNeeded`。
- `src/runtime/compression-engine.ts` — L1(压最旧 turn)+ L2(抽 memory 节点);`keepRecentTurns`(默认 5)、`l1Threshold`(0.7)、`l2Threshold`(0.5)。
- **同步在请求路径**:压缩完成才放行 LLM call → 撞阈值当轮有延迟。
- 无"预压缩/后台压缩"机制。

### 内容量展示
- `src/renderer/components/layout/ChatPanel.tsx:742-767` — `context-usage` 条:model 名 + `usedTokens/contextWindow` + in/out token + 进度条。**无 step 数 / 体积 / 压缩余量**。

## 影响面

- 表名改动:跨切面(`session-db.ts` 建表/查询 + 老库 `ALTER TABLE turns RENAME TO steps` 迁移 + 注释);不动 compression 的 turn 概念。
- 预压缩:改压缩触发模型(从 PreLLMCall 反应式 → 主动/后台),影响首字延迟与压缩时机语义;需防与现 L1/L2 冲突。
- 内容量 UI:新增展示(读 `turns` 表 step 数 + 现有 token + 压缩阈值算余量)。
- 与 multimodal-input 协调:multimodal-input 给 turns 加 `attachments` 列;若本 effort 先改表名,顺序上"先改名再加列"更干净(或合并迁移)。

## 下一步

进② design 细化(`/effort design`)。design 要定:
- 表改名迁移策略(`ALTER TABLE RENAME` + 索引;与 multimodal-input 加列的顺序)。
- 预压缩模型:何时触发(阈值前置?后台周期?step 数达到 N?)、同步 vs 异步、与现 L1/L2 阈值的关系、避免与请求路径争抢。
- 内容量 UI:展示哪些指标(step 数 / token / 压缩余量 / 已压缩步数)、放哪(context-usage 条扩展 or 独立)、数据来源。
- 是否需要新列(压缩元数据:预压缩标记 / 压缩级别 / 预压缩时间)。
