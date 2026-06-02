# 04 · 修复建议与执行顺序

每条都标了：**难度**（S/M/L）、**风险**（执行时引入回归的可能性）、**价值**（修了之后能挡多少 bug）。

## 阶段一：止血（1-2 天）

这一阶段的目标是**确保已有路径不会再悄无声息地坏掉**。

### R1. 给所有 SqliteStore 加列同步 sanity check ✅ 已完成（2026-06-02）

**实际做法比原计划更稳**：不只是 sanity check 报错，而是 self-heal。修改 [sqlite-store.ts ensureTable](../src/server/sqlite-store.ts#L75) 在 CREATE TABLE IF NOT EXISTS 之后，对每个声明的列检查 table_info，缺失就 ALTER ADD COLUMN。

这意味着即使 db-migration.ts 的 *_COLUMNS 漏了某列，store 自己会补齐。运行期更稳，长期再优化双源问题（见 R15）。

### R2. handler modules 数组校验 ✅ 已完成（2026-06-02）

**自动化**：[scripts/check-handler-modules.ts](../scripts/check-handler-modules.ts) — 用 TS compiler API 扫 `src/main/ipc/*.ts` 里所有 `typedHandle` / `registerCrud` 调用，对比声明的 modules 数组和 handler 内 `ctx.*` 访问，漏报就 fail。

跑法：`npm run check:handlers`。当前所有 handler 通过。

**实现要点**：
- 用 `ModuleName` union 限定只检查真实模块字段（避免 `ctx.win`、`ctx.modulesReady` 等非模块字段误报）
- 同时处理 `ctx.X` PropertyAccess 和 `const { foo, bar } = ctx` 解构
- `registerCrud({ module, store: () => ctx.X })` 也检查 store factory

**限制**：
- 仅扫字面量访问，动态属性 (`ctx[someVar]`) 不会报告
- 只检 `src/main/ipc/*.ts`；如果将来 handler 散到其他位置需扩 glob

**之前手动修过的漏报**（也是这个脚本会发现的）：
- `chat:send` 现在声明 `["agentService", "workspaceConfig", "providerStore", "agentStore"]`
- `chat:abort` 现在声明 `["agentService"]`
- `config:get-theme` / `config:set-theme` 现在声明 `["sessionDb"]`

### R3. 把空 catch 改成至少 `log.warn` ⚠️ 部分完成（2026-06-02）

已处理 5 处真正静默或标注 "ignore" 但属于真实错误的：
- agent-loop.ts:334 retry 删 turn 失败 → log.warn
- template-handlers.ts:54 GitHub cache 保存失败 → log.warn
- AgentEditor.tsx:266 UI autoSave 失败 → console.error
- session-manager.ts:140 metrics 持久化失败 → log.warn
- mcp-manager.ts:134 transport close 失败 → log.warn

**保留**：safeAddColumn、file-log-sink、renameSync 等已有明确注释说明意图的 catch。

### R4. 清理残留文件 ⚠️ 部分完成（2026-06-02）

- ✅ 删 `env-dump.txt`
- ✅ `.gitignore` 加入 `test-results/` 和 `.env`
- ✅ 删 `openclaw.plugin.json`（原计划做成 Pi Agent 插件，现已独立 harness）
- 空目录（`build/`、`resources/`、`src/renderer/components/workspace/`）git 不追踪，磁盘无害，暂留

## 阶段二：根除反复 bug 的模式（3-5 天）

### R5. chat-store 单源化 ✅ 已完成（2026-06-02）

**做法**：[src/renderer/store/chat-store.ts](../src/renderer/store/chat-store.ts) 移除 `messages` 和 `isStreaming` 两个字段，改成 derived selector：

```ts
const EMPTY_MESSAGES: ChatMessage[] = [];
export const selectActiveMessages = (s) =>
  s.activeSessionId ? (s.messagesBySession[s.activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
export const selectIsStreaming = (s) =>
  s.activeSessionId !== null && s.streamingSessions.has(s.activeSessionId);
```

所有 setter 不再维护双状态，只写 `messagesBySession` 和 `streamingSessions`。

**消费者更新**：
- [ChatPanel.tsx](../src/renderer/components/layout/ChatPanel.tsx) 改成 `useChatStore(selectActiveMessages)` / `useChatStore(selectIsStreaming)`
- [AppLayout.tsx](../src/renderer/components/layout/AppLayout.tsx) 之前 destructure 了 `messages`/`isStreaming` 但实际没用，移除

**踩过的坑（已修）**：初版 selector 写成 `?? []` 字面量，每次调用返回新的空数组引用，zustand 视为状态变化触发重渲染 → React error #185（无限更新）。修复：用模块级 `EMPTY_MESSAGES` 常量保证引用稳定。

**测试**：原本 23 个 chat-store 测试改写为 25 个（去掉 dual-state 不变量、加上 single-source 不变量）。Mutation 测试仍有意义：破坏 `addMessage` 让 `messagesBySession` 不更新，对应测试失败。

### R6. IpcContext 加真类型 ✅ 已完成（2026-06-02）

**实际做法**：把 [src/main/ipc/types.ts](../src/main/ipc/types.ts) 的 15 个 `any` 字段全部改成真类型：

```ts
import type { SessionDB } from "../../server/session-db.js";
import type { AgentStore } from "../../server/agent-store.js";
// ...

export interface IpcContext {
  sessionDb: SessionDB;
  agentStore: AgentStore;
  agentToolStore: AgentToolStore;
  providerStore: ProviderStore;
  // ...
}
```

为支持类型化，[agent-service.ts](../src/server/agent-service.ts) 把 `class AgentService` 改成 `export class`。

**顺带暴露并修复了 3 个被 `any` 掩盖的 bug**：
- `kb:add-files` 在 KB 不存在时返回 `{ error }` 单对象，与 IPC 类型 `KbFileIngestResult[]` 不匹配 — 改为返回每个文件一个 error 结果
- `config:get-theme` 返回 `customPrimaryColor?: string`（undefined）但 IPC 类型是 `string | null` — 显式把 undefined 转 null
- `logs:get-config` 默认值的 `globalLevel: "debug"` 被推断为 `string` 而非 `"debug" | "info" | "warn" | "error"` — 加 `as const`
- preload 实现 `onSessionLifecycle` 但 `WindowApi` 没声明 — 补声明

**清理**：移除 kb-handlers.ts 和 agent-tool-handlers.ts 里所有 `_ctx.kbStore as any` / `_ctx.kbDb as any` / `_ctx.providerStore as any` 强转。

**未做**：agent-handlers.ts 和 agent-tool-handlers.ts 里 `registerCrud` 的 `store: () => ctx.agentStore as any` 强转保留 — 因为 CrudStore 接口的 `update(id, Update)` 与实际 store 的 `update(id, Partial<Omit<...>>)` 类型不兼容，需要先重构 CrudStore 接口或 store 签名，不属于 R6 范围。

### R7. MiniMax / GLM preset

**难度**：S  **风险**：低  **价值**：中（用户体验）

在 provider 创建 UI 加 preset 按钮：
- MiniMax → type: `openai-compatible`, baseUrl: `https://api.minimaxi.chat/v1`, reasoning: 启用
- GLM → type: `openai-compatible`, baseUrl: `https://open.bigmodel.cn/api/paas/v4`, reasoning: 启用
- DeepSeek → ...

这一步不改 runtime 代码，纯 UI 层配置。

### R8. AppLayout event dispatcher 重构 ✅ 已完成（2026-06-02）

把 [AppLayout.tsx onAgentEvent](../src/renderer/components/layout/AppLayout.tsx) 内的 8-case switch 改成 dispatcher map：

```ts
const handlers: Record<string, (data: any, key: string) => void> = {
  session_init: (d, key) => initSession(d.sessionId || key, { messages: d.messages || [] }),
  text_delta: (d, key) => updateAssistantText(key, d.text),
  // ...
};
const handler = handlers[data.type];
if (handler) handler(data, key);
```

顺带把 `JSON.stringify(..., null, 2)` 抽成 `stringify()` helper（tool_start / tool_end 共用）。新增 event type 现在只改 handlers map，不再动 switch 主体。55 单测 + 2 E2E 通过。

## 阶段三：补测试（持续）

### R9. 单元测试基础设施 ✅ 已完成（2026-06-02）

**实际范围比原计划窄但有侧重**。引入 vitest 4.1，配置：
- `tests/unit/` 目录
- `npm run test:unit` 脚本（不需要 build）
- `vitest.config.ts` 顶层配置

**已覆盖**（85 个测试）：
- `chat-store.ts`（23 个）— 每个 action 的状态转换 + dual-state 不变量断言。mutation 测试验证：破坏 `addMessage` 的 dual-state 同步会让 12 个测试失败。
- `agent-utils.ts`（26 个）— `classifyError` / `isTransientError` / `userFriendlyMessage` / `parseThinkingTags`
- `default-prompt.ts`（4 个）— 模板生成
- **`provider-factory.ts`（14 个，2026-06-02）** — `getContextWindow`（含 fallback / 名字归一化）、`resolveModel` 错误路径（provider 缺失 / 禁用 / 无 apiKey）、mock provider 实例化、缓存行为、`clearProviderCache`
- **`session-metrics.ts`（18 个，2026-06-02）** — `RunningStats`（Welford 算法、sample variance 用 n-1、边界值）、`SessionMetricsHolder`（构造、`recordTokenUsage` 累积可选字段、`toSessionMetrics` 防御性 Map 拷贝）

**未覆盖**：依赖 `better-sqlite3` 的模块（db-migration、recovery、kb-search、session-manager 等）—— native 模块编译给 Electron 的 Node 版本（NODE_MODULE_VERSION 145），普通 Node 进程加载失败。E2E 已覆盖关键 SQL 路径。

**未来扩展**：若想测 SQL 模块，要么在 tests 目录装第二份 better-sqlite3 重编译给 Node，要么改用 sqlite3 纯 JS 包并重写 SqliteStore，要么注入 DB 抽象层——成本都高于当前收益。

### R10. 高优先级单元测试

按 ROI 排序：

| 优先级 | 模块 | 测试要点 |
|--------|------|----------|
| P0 | [chat-store.ts](../src/renderer/store/chat-store.ts) | addMessage/initSession/setActiveAgent 的状态转换，单源真理不变量 |
| P0 | [db-migration.ts](../src/server/db-migration.ts) | fresh DB 创建 + 升级路径 |
| P0 | [agent-loop.ts](../src/runtime/agent-loop.ts) | retry、context pruning、tool 调用顺序 |
| P1 | [recovery.ts](../src/server/recovery.ts) | 中断 turn 恢复 |
| P1 | [provider-factory.ts](../src/runtime/provider-factory.ts) | 每个 type 都能实例化 |
| P1 | [session.ts](../src/runtime/session.ts) | turn reconstruction |
| P2 | [kb-search.ts](../src/server/kb-search.ts) | cosine similarity、top-K |
| P2 | [buildDefaultPrompt](../src/core/default-prompt.ts) | 模板生成 |

### R11. E2E 扩展

加几个 critical 路径：
- 多 session 并发（A streaming 时切到 B，A 事件仍更新 store）
- recovery（kill 进程后重启，未完成 turn 恢复）
- 工具调用完整链路（mock tool + fixture）
- thinking / reasoning block 流式

## 阶段四：架构演进（长期）

### R12. 拆分 god 组件（部分完成）

**已完成（2026-06-02）**：
- `session-handlers.ts` (113 行 / 9 ops) → 拆为 [message-handlers.ts](../src/main/ipc/message-handlers.ts) (3 ops) + [session-handlers.ts](../src/main/ipc/session-handlers.ts) (6 ops + metrics)
- 改动机械、零行为变化，全部通过现有测试网（55 单测 + 2 E2E）

**已完成（2026-06-02 第二批）**：SettingsPage 拆分
- [SettingsPage.tsx](../src/renderer/components/settings/SettingsPage.tsx) 667 → 119 行（纯 orchestrator）
- 拆出 6 个 satellite 组件（同目录）：
  - [ProviderCard.tsx](../src/renderer/components/settings/ProviderCard.tsx)
  - [ProviderEditor.tsx](../src/renderer/components/settings/ProviderEditor.tsx)（modal 表单 + Fetch from API）
  - [DeviceContextSettings.tsx](../src/renderer/components/settings/DeviceContextSettings.tsx)
  - [GuidelinesSettings.tsx](../src/renderer/components/settings/GuidelinesSettings.tsx)
  - [WorkspaceSettings.tsx](../src/renderer/components/settings/WorkspaceSettings.tsx)
  - [ThemeSettings.tsx](../src/renderer/components/settings/ThemeSettings.tsx)
- 全部通过 55 单测 + 2 E2E，typecheck 干净

**已完成（2026-06-02 第三批）**：AgentEditor 拆分
- [AgentEditor.tsx](../src/renderer/components/agents/AgentEditor.tsx) 688 → 304 行（state + orchestrator）
- 共享类型抽到 [agent-editor-types.ts](../src/renderer/components/agents/agent-editor-types.ts)（`FormState` / `Section` / `DEFAULT_ENABLED_TOOLS` / `agentToForm` / `templateToForm` / `defaultForm` / `formatTokens` / `shorten` / `kebab`）
- 拆出 5 个 satellite 组件：
  - [BasicSection.tsx](../src/renderer/components/agents/BasicSection.tsx) — name / workspace / model / thinking
  - [PromptSection.tsx](../src/renderer/components/agents/PromptSection.tsx) — system prompt editor + context sections
  - [ToolsSection.tsx](../src/renderer/components/agents/ToolsSection.tsx) — tool list grouped，本地 `expandedTool` state 一并下放
  - [ExposeAsToolSection.tsx](../src/renderer/components/agents/ExposeAsToolSection.tsx) — 已有 inline function 提为独立文件
  - [PermissionsSection.tsx](../src/renderer/components/agents/PermissionsSection.tsx) — readScope / executionMode
- [ConfirmModal.tsx](../src/renderer/components/common/ConfirmModal.tsx) 提到 `common/`（可复用）
- Form state 留在 AgentEditor（避免 state 提升风险），section 组件纯 props → JSX
- 全部通过 55 单测 + 2 E2E，typecheck 干净

### R13. 双构建整合

如果 `dist/` 不实际用于 npm 发布，删除 `build:lib` 步骤 + `tsconfig.cli.json` + `vite.config.ts`（如果只是给 lib 用）。

### R14. preload capability 分级

如果未来对扩展 / 第三方插件开放 renderer，需要把 preload 暴露面按 capability 分级。当前自己用，可暂缓。

### R15. schema 定义统一

长期目标：每个 SqliteStore 的 COLUMNS 是 single source of truth，db-migration 自动派生 schema。可以从一个 `defineTable(name, columns)` 函数开始。

## 不建议做的事

- **全面替换状态管理**（zustand → redux / jotai）：当前 zustand 已经够用，不是问题源
- **微服务化 / IPC 拆服务**：Electron 单机应用没必要
- **Tauri 重写**：之前讨论过，纯好奇性质，没实际收益
- **把所有 `any` 一次性消光**：性价比低，分模块渐进改更稳

## 时间投入估算

| 阶段 | 工作量 | 累计 |
|------|--------|------|
| 阶段一（止血） | 1-2 天 | 1-2 天 |
| 阶段二（根除模式） | 3-5 天 | 4-7 天 |
| 阶段三（测试） | 持续 | 持续 |
| 阶段四（架构演进） | 2-3 周 | 视进度 |

阶段一 + 阶段二是最高 ROI，建议先做。阶段三伴随每个修复 PR 加测试。阶段四是季度级别规划。
