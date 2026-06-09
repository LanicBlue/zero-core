# 03 · 技术债清单

> 最近更新：2026-06-06

## ✅ 已解决

### ~~1. agent-loop.ts 是最大单文件（512 行）~~

**已解决**（2026-06）：hook-driven 重构。AgentLoop 从 ~587 行减至 526 行，删除 CompressionEngine/MemoryRecall 内联逻辑。功能拆到 `src/runtime/hooks/` 下 4 个独立模块（compression-hooks、memory-hooks、rag-hooks、index）。新增 `PreLLMCall` 和 `PostTurnComplete` 两个 hook 事件。

## 🟡 中优先级

### 2. session-manager.ts (421 行) / session-db.ts (583 行)

可按职责拆分，但当前可接受。

### 3. `any` 仍有 374 处

主要分布：agent-loop.ts (28)、main/ipc/core.ts (22)、mcp-handlers.ts (18)。分模块渐进改。

### 4. 预加载暴露面（85 个 IPC 方法）

[preload/index.ts](../src/preload/index.ts) 无 capability 分级。当前自用，暂不需要。

## 🟢 低优先级

### 5. 空状态 / loading / error 不一致

部分组件缺少 empty state，loading skeleton 几乎全无。

### 6. 内联样式

SearchSettings.tsx、GuidelinesSettings.tsx 有内联样式，可抽到 CSS。

### 7. IPC 频道命名不统一

`agents:list` vs `agent-tools:list` vs `chat:send`，前缀规则不一致。

## 长期项

- **R13** 双构建整合 — dist/ 用于 npm 发布 + CLI 模式，不能删
- **R14** preload capability 分级 — 等第三方插件需求时再做
- **R15** schema 定义统一 — `defineTable(name, columns)` helper，R1 self-heal 已是 safety net
