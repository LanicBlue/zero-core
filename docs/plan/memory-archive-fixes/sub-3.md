# Sub-3:settings/memory 补 prompt 配置

> 所属 effort:[memory-archive-fixes](./design.md)。修 issue ②。

## 目标
[MemorySettings.tsx](../../../src/renderer/components/settings/MemorySettings.tsx) 暴露两个可配 prompt:
1. **压缩摘要 prompt**(默认 `SUMMARY_SYSTEM`)—— 读侧已接好([compression-trigger-hooks.ts:290-292](../../../src/runtime/hooks/compression-trigger-hooks.ts) 转 `config.compression.summarySystemPrompt` 进 opts),只差 UI。
2. **记忆提取 prompt**(默认 `ARCHIVE_MEMORY_PROMPT`)—— 决策 4 = 做。新 config 字段 + memory turn runner 读它覆盖。

## 机制

### 压缩摘要 prompt(纯 UI)
- MemorySettings 加 `<textarea>` 绑 `compression.summarySystemPrompt`。空 = 用默认。
- save 时随 `memoryConfigUpdate({ compression })` 整块存(既有,config-router 整块存 [config-router.ts:207-209](../../../src/server/config-router.ts))。
- 读侧无需改(compression-trigger-hooks 已转发)。
- 加「恢复默认」按钮(清空字段)。

### 记忆提取 prompt(新字段 + 接线)
- config schema([config.ts](../../../src/core/config.ts))加 `archive?: { memoryPrompt?: string }`(默认空)。
- config-router memoryConfigGet/Update:交换 `archive` 块(同 compression 模式)。
- agent-service 的两个 memory turn runner:
  - `runManualArchiveMemoryTurn` [agent-service.ts:~1130](../../../src/server/agent-service.ts)
  - `runDelegatedArchiveMemoryTurn` [agent-service.ts:1040](../../../src/server/agent-service.ts)
  - 现 `await loop.run(ARCHIVE_MEMORY_PROMPT, {ephemeral:true})` → 改 `await loop.run(memoryPromptOverride ?? ARCHIVE_MEMORY_PROMPT, {ephemeral:true})`。override 从 config.archive.memoryPrompt 读(trim 后空 = undefined → 用默认 const)。
- MemorySettings 加第二个 textarea 绑 `archive.memoryPrompt` + 恢复默认。
- preload `memoryConfigGet`/`memoryConfigUpdate` 已是整块交换,无需改 IPC 形状(确认 archive 字段随 compression 一起往返)。

## 改动文件
- [MemorySettings.tsx](../../../src/renderer/components/settings/MemorySettings.tsx):加 2 个 textarea + 恢复默认按钮 + state 扩 archive。
- [config.ts](../../../src/core/config.ts):schema 加 `archive.memoryPrompt`。
- [config-router.ts](../../../src/server/config-router.ts):memoryConfigGet/Update 交换 archive 块。
- [agent-service.ts](../../../src/server/agent-service.ts):两处 memory turn runner 读 override。
- 验证 preload IPC 形状(memoryConfigGet 返回 {compression, archive})。

## 范围边界(不做)
- 不改 SUMMARY_SYSTEM / ARCHIVE_MEMORY_PROMPT 默认文案。
- 不加 prompt 模板变量/变量插值(纯覆盖整段)。
- 不做 prompt 校验(改坏 = 行为变差,用户自担;压缩侧已有 fallbackSections 兜底契约)。

## 风险
- **config 形状向后兼容**:新加 `archive` 字段默认空,旧 config 无此字段 → 默认 const,无破坏。
- **preload IPC**:确认 memoryConfigGet 返回对象能多带 archive 字段(preload 透传,通常是 `{...configData}` 整块,应无需改 preload binding —— 验证之)。
