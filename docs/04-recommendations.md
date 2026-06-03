# 04 · 修复建议与执行顺序

> 最近重写：2026-06（标记已完成项、删除不再做的项）

## 阶段一：止血 ✅ 全部完成（2026-06）

### R1. SqliteStore 列同步 self-heal ✅

[sqlite-store.ts ensureTable](../src/server/sqlite-store.ts#L75) 构造时检测缺失列并自动 ALTER ADD COLUMN。fresh DB 不再靠 db-migration 的 `*_COLUMNS` 列表完整。

### R2. handler modules 数组 AST 校验 ✅

[scripts/check-handler-modules.ts](../scripts/check-handler-modules.ts) — TS compiler API 扫 `src/main/ipc/*.ts`，对比声明的 modules 数组和 handler 内 `ctx.*` 访问。`npm run check:handlers` 跑。

实现要点：
- `ModuleName` union 限定 14 个真实模块字段
- 同时处理 `ctx.X` PropertyAccess 和 `const { foo } = ctx` 解构
- `registerCrud({ module, store: () => ctx.X })` 也校验

### R3. 空 catch 加 log.warn ✅

5 处真正静默或标 "ignore" 但属于真实错误的已修：agent-loop.ts retry 删 turn、template-handlers GitHub cache、AgentEditor autoSave、session-manager metrics、mcp-manager transport close。其余 catch 已有注释说明意图。

### R4. 残留文件清理 ✅

`env-dump.txt` 已删、`test-results/` 和 `.env` 加入 `.gitignore`、`openclaw.plugin.json` 已删（Pi Agent 插件方向废弃）。

## 阶段二：根除反复 bug 的模式 ✅ 全部完成（2026-06）

### R5. chat-store 单源化 ✅

[src/renderer/store/chat-store.ts](../src/renderer/store/chat-store.ts) 移除 `messages` 和 `isStreaming` 双源字段，改为 derived selector：

```ts
const EMPTY_MESSAGES: ChatMessage[] = [];
export const selectActiveMessages = (s) =>
  s.activeSessionId ? (s.messagesBySession[s.activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
export const selectIsStreaming = (s) =>
  s.activeSessionId !== null && s.streamingSessions.has(s.activeSessionId);
```

踩过的坑（已修）：初版 `?? []` 字面量每次产生新数组引用，触发 React error #185。修复用模块级常量 `EMPTY_MESSAGES`。

### R6. IpcContext 加真类型 ✅

[src/main/ipc/types.ts](../src/main/ipc/types.ts) 15 个 `any` 字段全部改成真类型。顺带修了 3 个被 any 掩盖的 bug：
- `kb:add-files` 返回类型与 IPC 类型不匹配
- `config:get-theme` undefined vs null 语义
- `logs:get-config` globalLevel 类型推断

未做：registerCrud 调用处的 `as any` 强转保留 — CrudStore 接口与 store 签名不兼容。

### R7. MiniMax / GLM preset ❌ 主动跳过

用户判定：纯 UI 体验问题，不影响正确性。需要时回来做。

### R8. AppLayout event dispatcher 重构 ✅

[src/renderer/components/layout/AppLayout.tsx](../src/renderer/components/layout/AppLayout.tsx) 改为 dispatcher map，9 种 event type 各自 handler。新增 type 只动 handlers object，不动主体。

## 阶段三：补测试 ✅ 基础设施完成（2026-06）

### R9. 单元测试基础设施 ✅

引入 vitest 4.1。已覆盖 85 个测试：
- `chat-store.ts`（23）— 单源不变量、每个 action 的状态转换
- `agent-utils.ts`（26）— classifyError / isTransientError / userFriendlyMessage / parseThinkingTags
- `default-prompt.ts`（4）— 模板生成
- `provider-factory.ts`（14）— getContextWindow、resolveModel 错误路径、mock provider、缓存
- `session-metrics.ts`（18）— Welford 算法、RunningStats 边界、SessionMetricsHolder

**未覆盖**：依赖 `better-sqlite3` 的模块（native 版本限制）、agent-loop（依赖太多，ROI 低）。E2E 已覆盖关键 SQL 路径。

### R10. 高优先级单元测试 ✅

`provider-factory.ts` + `session-metrics.ts` 已完成（32 个测试）。其余 P0/P1：
- `db-migration.ts` / `recovery.ts` / `kb-search.ts` — better-sqlite3 限制，留给 E2E
- `agent-loop.ts` — ROI 低，留给 E2E

### R11. E2E 扩展 ✅ 首批完成（2026-06）

新增 5 个 E2E 测试（共 7 个）：
- 多轮对话：3 轮连续消息，验证 user/assistant 气泡按序出现
- error banner：首条消息失败时出现、手动关闭、5 秒自动消失
- session 删除：非活跃 session 删除后活跃 session 消息保留

mock-language-model 扩展支持 error fixture (`error: { message }` 字段，doStream/doGenerate 直接 throw）。

剩余可加：
- 多 session 并发（A streaming 时切到 B）
- recovery（kill + restart 后未完成 turn 恢复）
- 工具调用完整链路（mock tool + fixture）
- thinking / reasoning block 流式
- 多 agent 场景（B7）


## 阶段四：架构演进（部分完成 / 长期）

### R12. 拆分 god 组件 ✅

四批拆分全部完成：
- session-handlers.ts → 拆出 message-handlers.ts
- SettingsPage.tsx 667 → 119 + 6 个 satellite（2026-06 第二批）
- AgentEditor.tsx 688 → 337 + 5 个 section 组件 + agent-editor-types.ts（2026-06 第三批）
- template-handlers.ts 188 → 47 + github-template-handlers.ts（2026-06 第四批）

剩余可拆：agent-loop.ts (784)、session-manager.ts (399)、session-db.ts (435) — ROI 低，暂留。

### R13. 双构建整合 ❌ 主动保留

`dist/` 用于 npm 发布 + CLI 模式 + HTTP server 模式，**不能删**。`build:lib` 脚本和 `tsconfig.cli.json` 保留。

### R14. preload capability 分级 ❌ 暂不需要

当前自用，无第三方插件。如未来开放给扩展，按页面/角色分级暴露。

### R15. schema 定义统一（长期）

长期目标：让 db-migration.ts 直接 import 各 store 的 COLUMNS 常量。可以从 `defineTable(name, columns)` helper 开始。当前 R1 self-heal 已是 safety net，不阻塞。

## 不建议做的事

- **全面替换状态管理**（zustand → redux / jotai）：当前 zustand 已经够用
- **微服务化 / IPC 拆服务**：Electron 单机应用没必要
- **Tauri 重写**：之前讨论过，没实际收益
- **把所有 `any` 一次性消光**：性价比低，分模块渐进改更稳

## 时间投入估算

| 阶段 | 工作量 | 状态 |
|------|--------|------|
| 阶段一（止血） | 1-2 天 | ✅ 完成 |
| 阶段二（根除模式） | 3-5 天 | ✅ 完成 |
| 阶段三（测试） | 持续 | ✅ 基础设施完成，扩展持续 |
| 阶段四（架构演进） | 2-3 周 | ✅ R12 完成，R13-R15 长期 |

## 已完成额外项（不在原 R 列表）

- **#6** public API 的 `any` 替换（parseThinkingTags、files:tree）
- **#12** 硬编码 URL / magic number 抽到 [src/core/constants.ts](../src/core/constants.ts)
- **todos 渲染补完**（AppLayout dispatcher + ChatPanel render TodosList，删 dead `todos:get` IPC）
- **search-provider 配置**（WorkspaceConfig 字段、IPC handler、Settings > Search UI、启动初始化）
- **B3** stuck pending turn 自动清理（24h cutoff，包含 pending）
- **B4** MCP reconnect 错误 log.warn
- **B9** error banner（chat-store lastError 状态 + ErrorBanner 组件 + mock error fixture）
- **B8** KV migration 单个失败 try/catch + log.warn
