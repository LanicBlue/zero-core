# Acceptance-3:settings/memory 补 prompt 配置

> 对应 [sub-3.md](./sub-3.md)。修 issue ②。verifier 按此写测试。

## 验收项

1. **UI 渲染两框**:MemorySettings 渲染「压缩摘要 prompt」+「记忆提取 prompt」两个 textarea,各带「恢复默认」按钮。
2. **压缩 prompt 持久化 + 生效**:填压缩 textarea + Save → `config.compression.summarySystemPrompt` 持久化;触发压缩时 [compression-trigger-hooks.ts:290-292](../../../src/runtime/hooks/compression-trigger-hooks.ts) 把它传入 `opts.summarySystemPrompt`(覆盖默认 SUMMARY_SYSTEM)。测试:读 config + mock compressOnce 断言 opts.summarySystemPrompt = 用户值。
3. **记忆提取 prompt 持久化 + 生效**:填记忆提取 textarea + Save → `config.archive.memoryPrompt` 持久化;归档 memory turn runner(`runManualArchiveMemoryTurn`/`runDelegatedArchiveMemoryTurn`)用它作为 loop.run 的 prompt(覆盖 ARCHIVE_MEMORY_PROMPT)。测试:mock AgentLoop.run,断言传入 prompt = 用户值。
4. **空 = 默认**:两框空 → config 字段 undefined/空 → 压缩用 SUMMARY_SYSTEM、memory turn 用 ARCHIVE_MEMORY_PROMPT(默认 const)。
5. **恢复默认**:点「恢复默认」→ 字段清空(= 用默认)。
6. **config 向后兼容**:加载无 `archive` 字段的旧 config → 不崩,archive.memoryPrompt = undefined → 用默认。
7. **IPC 往返**:memoryConfigGet 返回 `{ compression, archive }`;memoryConfigUpdate({compression, archive}) 持久化两块。preload 透传无需改 binding(验证)。

## 测试形态
- 单元:config-router memoryConfigGet/Update 往返 archive 块。
- 单元:memory turn runner 读 override(mock config + mock loop)。
- 回归:既有 compression 测试(sub3b)全绿 —— 读侧逻辑没动。
- UI:MemorySettings 渲染两个 textarea(组件快照或 RTL)。

## 反例(必须不成立)
- ❌ 压缩 prompt 框改了值但实际压缩仍用 SUMMARY_SYSTEM(读侧没接到 —— 读侧本就接好,只验不退步)。
- ❌ 记忆提取 prompt 框改了值但 memory turn 仍用 ARCHIVE_MEMORY_PROMPT。
- ❌ 旧 config(无 archive 字段)加载崩。
