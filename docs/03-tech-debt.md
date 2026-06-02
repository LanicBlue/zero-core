# 03 · 技术债清单

> 最近重写：2026-06（清理已修复项 + 重扫指标）
> 按严重程度分级：🔴 高（影响正确性）／🟡 中（影响可维护性）／🟢 低（清理类）

## 🔴 高优先级

*全部已修复 — 见 [04-recommendations.md](04-recommendations.md) R1-R8 + [05-known-bugs.md](05-known-bugs.md) B1-B8。本章保留作为历史参考。*

### 1. SQLite migration 列同步问题 ✅ 已 self-heal（2026-06）

[sqlite-store.ts ensureTable](../src/server/sqlite-store.ts) 构造时检测缺失列并自动 ALTER ADD COLUMN。即使 db-migration.ts 的 `*_COLUMNS` 漏写，store 自己补齐。

长期目标：让 db-migration.ts 直接 import 各 store 的 COLUMNS 常量（见 R15）。

### 2. IpcContext 全 `any` ✅ 已修复（2026-06 R6）

[src/main/ipc/types.ts](../src/main/ipc/types.ts) 15 个字段全部改成真类型，连带修复 3 个被 `any` 掩盖的 bug（kb:add-files 返回类型、config:get-theme null 语义、logs:get-config globalLevel 推断）。

仍残留：`registerCrud({ store: () => ctx.X as any })` 强转 — CrudStore 接口与 store 签名不兼容。

### 3. handler 声明的依赖不准确 ✅ 已修（2026-06 R2）

[scripts/check-handler-modules.ts](../scripts/check-handler-modules.ts) AST 校验脚本扫所有 handler，`npm run check:handlers` 跑。新加 handler 漏写 modules 数组会 fail。

### 4. `activeSessionId` 同步路径脆弱 ✅ 已修（2026-06 R5）

chat-store 改为单源（`messagesBySession` + `streamingSessions` Set），`messages` / `isStreaming` 通过 selector 派生。

### 5. 单元测试几乎为零 ✅ 部分缓解（2026-06 R9/R10）

引入 vitest，覆盖纯逻辑模块：chat-store（23）、agent-utils（26）、default-prompt（4）、provider-factory（14）、session-metrics（18）。共 85 测试。

未覆盖：依赖 better-sqlite3 的模块（NODE_MODULE_VERSION 限制）、agent-loop（依赖太多，ROI 低）。

### 6. `any` 在 public API 上 ✅ 关键路径已修

- IpcContext — R6
- `parseThinkingTags` — ThinkingBlock[]
- `files:tree` — FileTreeNode[]
- `search-provider:get/set` — SearchProviderConfig
- `todos:get` — 已删除（事件推流替代）

**剩余 `any` 分布**：348 处（195 `: any` + 153 `as any`），主要集中在：
1. `agent-loop.ts` (28)
2. `main/ipc/core.ts` (22)
3. `mcp-handlers.ts` (18)
4. `kb-handlers.ts`、`main/ipc/types.ts` 各 16（types.ts 内的 `as any` 已是 registerCrud 强转，无法用纯类型替换解决）

### 7. 错误吞噬 ✅ 关键路径已修

205 个 catch 块，已处理真正静默的 5 处（R3）+ MCP reconnect（B4）+ KV migration（B8）。其余 catch 均有注释说明意图（best-effort 路径）。

## 🟡 中优先级

### 8. god 文件

| 文件 | 行数 | 状态 |
|------|------|------|
| [agent-loop.ts](../src/runtime/agent-loop.ts) | 784 | 单 turn 执行 + retry + streaming + tool 调度 — 拆分 ROI 低 |
| [ChatPanel.tsx](../src/renderer/components/layout/ChatPanel.tsx) | 436 | session 切换 + 输入 + 消息渲染，可拆但当前可接受 |
| [AgentEditor.tsx](../src/renderer/components/agents/AgentEditor.tsx) | 337 (was 688) | ✅ 已拆 — 5 个 section 组件 + agent-editor-types.ts |
| [session-manager.ts](../src/server/session-manager.ts) | 399 | 状态机 + TTL + metrics，按职责分可拆 |
| [session-db.ts](../src/server/session-db.ts) | 435 | SQLite 操作大杂烩 |
| [SettingsPage.tsx](../src/renderer/components/settings/SettingsPage.tsx) | 119 (was 667) | ✅ 已拆 — 7 个 satellite 组件 |
| [template-handlers.ts](../src/main/ipc/template-handlers.ts) | 47 (was 188) | ✅ 已拆 — github preview/import 拆到 [github-template-handlers.ts](../src/main/ipc/github-template-handlers.ts) |

### 9. AppLayout 巨型 switch ✅ 已修（2026-06 R8）

[AppLayout.tsx](../src/renderer/components/layout/AppLayout.tsx) 改为 dispatcher map。新增 event type 只动 handlers object。

### 10. 双构建系统（保留）

`tsc` (dist/) + `electron-vite` (out/) 并存。**已确认 dist/ 用于 npm 发布 + CLI 模式 + HTTP server 模式，不能删**。

### 11. 预加载暴露面太宽

[preload/index.ts](../src/preload/index.ts) 暴露 85 个 IPC 方法 + 4 个事件订阅，无 capability 分级。

**修复建议**：当前自用，暂不需要。如果未来开放给第三方插件，按页面/角色分级暴露。

### 12. 硬编码 URL 和 magic number ✅ 已完成（2026-06）

主要 URL 与常量已抽到 [src/core/constants.ts](../src/core/constants.ts)：
- `EXEC_MAX_BUFFER_BYTES` (10 MB) — 替换 6 处
- `OUTPUT_TRUNCATION_CHARS` (50_000) — 替换 3 处
- `DEFAULT_URLS.{ollama, searxng, openai}` — 替换 KB / search / provider 默认 URL
- `DEV_SERVER_URL` — 替换 main/index.ts 中的 vite dev URL

未抽的（暂留）：200 max steps（已是 SessionConfig）、各类动画/重试超时（散落、收益低）、MCP SSE / API server 端口（路径未启用）。

### 13. Provider 类型与 UI 选项不匹配（用户决定跳过）

[provider-factory.ts](../src/runtime/provider-factory.ts) 没有 `minimax` / `glm` / `deepseek` 原生 case。用户走 `openai-compatible` 路径。

**修复建议**：
- 短期：UI 层加 preset（自动填 baseURL + 启用 reasoning）— R7 主动跳过，用户判定不值得做
- 长期：加原生 case，支持厂商特有功能

## 🟢 低优先级（清理类）

### 14. 残留文件 ✅ 已清理（2026-06）

已删：`env-dump.txt`、`openclaw.plugin.json`。`.gitignore` 加 `test-results/` 和 `.env`。

仍存在（无害）：`src/renderer/components/workspace/`、`build/`、`resources/`（空目录，git 不追踪）

### 15. 空状态 / loading / error 不一致

部分组件有完整 empty state（ChatPanel），部分没有（agent list、template list）。loading skeleton 几乎全无。

### 16. 内联样式

[SearchSettings.tsx](../src/renderer/components/settings/SearchSettings.tsx)、[GuidelinesSettings.tsx](../src/renderer/components/settings/GuidelinesSettings.tsx) 都有内联样式。可抽到 CSS。

### 17. 命名混用

- 表名 snake_case（合理，SQL 惯例）
- TS 文件 kebab-case（合理）
- 但 IPC 频道既有 `chat:send` 也有 `sessions:list`，前缀规则不统一（`agents:list` vs `agent-tools:list` vs `chat:send`）

## 统计（2026-06 重扫）

| 维度 | 数值 |
|------|------|
| 总文件数（src/） | 212 |
| 总行数 | ~24,550 |
| `any` 出现 | 348（195 `: any` + 153 `as any`） |
| catch 块总数 | 205 |
| 真·静默 catch | 0（已清理） |
| 单元测试 | 85（5 个 test 文件） |
| E2E 测试 | 2 个 spec |
| 硬编码 URL（核心默认值） | 0（已抽常量） |
| IPC 频道 | 85 |
| IPC handler 文件 | 14 个 register + 6 个 infra |
