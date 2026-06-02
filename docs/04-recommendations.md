# 04 · 修复建议与执行顺序

每条都标了：**难度**（S/M/L）、**风险**（执行时引入回归的可能性）、**价值**（修了之后能挡多少 bug）。

## 阶段一：止血（1-2 天）

这一阶段的目标是**确保已有路径不会再悄无声息地坏掉**。

### R1. 给所有 SqliteStore 加列同步 sanity check

**难度**：S  **风险**：低  **价值**：高

在 [SqliteStore 构造函数](../src/server/sqlite-store.ts#L34) 末尾加：

```ts
const actualCols = new Set((db.pragma(`table_info(${this.table})`) as any[]).map(r => r.name));
const expectedCols = new Set(this.allColumns);
for (const c of expectedCols) {
  if (!actualCols.has(c)) {
    throw new Error(`Schema mismatch: ${this.table} missing column ${c}`);
  }
}
```

这样如果以后有人加列忘了同步 migration 文件，构造期就 fail-fast，而不是运行期 `no such column` 崩溃。

### R2. handler modules 数组校验

**难度**：S  **风险**：低  **价值**：中

写一个 lint / 启动期自检，扫描所有 `typedHandle` 调用，对比 handler 函数体里实际访问的 `ctx.*` 字段，发现 modules 数组没声明的就警告。

最简单的版本：grep `_ctx\.\w+` 和 modules 数组对比（虽然粗糙，能挡住 chat:send 那类漏报）。

### R3. 把空 catch 改成至少 `log.warn`

**难度**：S  **风险**：极低  **价值**：中

遍历所有 `catch {}`，至少加一行 `log.warn("module", "operation failed:", err)`。dev 时不挡道，prod 时有线索。

特例：`safeAddColumn` 这种"已存在就算了"的逻辑可以保留空 catch，但加注释说明。

### R4. 清理残留文件

**难度**：S  **风险**：零  **价值**：低

- 删 `env-dump.txt`
- 删空目录 `build/`、`resources/`、`src/renderer/components/workspace/`
- 确认 `openclaw.plugin.json` 是否还需要

## 阶段二：根除反复 bug 的模式（3-5 天）

### R5. chat-store 单源化

**难度**：M  **风险**：中  **价值**：高

去掉 `messages` 字段，所有读取改成：

```ts
const messages = useChatStore(s => 
  s.activeSessionId ? s.messagesBySession[s.activeSessionId] ?? [] : []
);
```

或者保留 `messages` 作为 derived state，用 zustand 的 subscribe 同步，让两份状态永远自动一致。

**回归风险**：renderer 多处直接订阅 `messages`，要全局替换并测一遍。

### R6. IpcContext 加真类型

**难度**：M  **风险**：低  **价值**：高

把 [src/main/ipc/types.ts](../src/main/ipc/types.ts) 改成：

```ts
import type { AgentStore } from "../../server/agent-store.js";
import type { SessionDB } from "../../server/session-db.js";
// ...

export interface IpcContext {
  sessionDb: SessionDB;
  agentStore: AgentStore;
  // ...
}
```

然后修所有 `as any` 强转。这一步不会改变运行行为，纯类型重塑。

### R7. MiniMax / GLM preset

**难度**：S  **风险**：低  **价值**：中（用户体验）

在 provider 创建 UI 加 preset 按钮：
- MiniMax → type: `openai-compatible`, baseUrl: `https://api.minimaxi.chat/v1`, reasoning: 启用
- GLM → type: `openai-compatible`, baseUrl: `https://open.bigmodel.cn/api/paas/v4`, reasoning: 启用
- DeepSeek → ...

这一步不改 runtime 代码，纯 UI 层配置。

### R8. AppLayout event dispatcher 重构

**难度**：S  **风险**：中  **价值**：低（可维护性）

把 [AppLayout.tsx:62-104](../src/renderer/components/layout/AppLayout.tsx#L62) 的 switch 改成：

```ts
const handlers: Record<string, (data: any, key: string) => void> = {
  session_init: (d, key) => initSession(d.sessionId || key, { messages: d.messages || [] }),
  text_delta: (d, key) => updateAssistantText(key, d.text),
  // ...
};
const handler = handlers[data.type];
if (handler) handler(data, key);
```

## 阶段三：补测试（持续）

### R9. 单元测试基础设施

**难度**：M  **风险**：零  **价值**：高

引入 vitest，配置：
- `tests/unit/` 目录
- `npm run test:unit` 脚本（不需要 build）
- CI 跑 unit + e2e

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

### R12. 拆分 god 组件

- AgentEditor 688 行 → AgentBasicInfo / AgentTools / AgentPrompt / AgentModel 等
- SettingsPage 667 行 → ProviderSection / ThemeSection / DeviceContextSection / GuidelinesSection
- session-handlers → message-handlers + session-handlers

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
