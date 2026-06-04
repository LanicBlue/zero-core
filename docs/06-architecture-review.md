# 06 · 架构与技术债深度分析

> 分析日期：2026-06-04
> 范围：进程模型、IPC、运行时、数据层、UI 层全量审查

## 🔴 高优先级 — 影响正确性或可扩展性

### A1. AgentLoop 是 God Class（784 行，7+ 职责）

[src/runtime/agent-loop.ts](../src/runtime/agent-loop.ts)

**问题**：单个类承担了执行流控制、状态管理、事件发射、工具编排、子代理委派、checkpoint 管理、重试逻辑。

具体症状：
- `toolContext` 构造器内嵌 200+ 行闭包，极难扩展和测试
- 实例变量散落（`busy`, `streamText`, `thinkingText`, `resultText`），无统一状态机
- 无状态转换校验 — `abort()` 在非 busy 时调用？`run()` 并发调用？
- 重试逻辑粒度过粗 — `executeStream()` 失败后整体重试，不区分 provider 错误 vs tool 错误 vs 网络超时
- 多处 `catch { }` 静默吞错误（行 76, 335, 417, 496, 503, 665）

```
AgentLoop 当前职责：
├── 执行流控制（run/abort/resume）
├── streaming 状态管理（增量文本、thinking、tool call）
├── 事件发射（emit → UI 更新）
├── 工具编排（toolContext 构建、tool 调用）
├── 子代理委派（delegateTask, delegateTaskBackground）
├── checkpoint / turn 管理（数据库读写）
└── 重试 / 错误恢复（MAX_RETRIES 循环）
```

**建议**：拆为 3-4 个协作类：`TurnExecutor`（执行流 + 重试）、`ToolOrchestrator`（工具上下文 + 委派）、`StreamStateManager`（流式状态）、`TurnRecorder`（数据库 checkpoint）。

---

### A2. IpcContext 违反最小权限原则

[src/main/ipc/core.ts](../src/main/ipc/core.ts)

**问题**：所有 15+ 模块通过单一 `IpcContext` 暴露给所有 handler。简单 handler（只需 1 个 store）也能访问全部应用状态。

```typescript
// 每个 handler 都拿到完整上下文
typedHandle("dialog:open", ["agentService"], async (_ctx, ...) => {
  // _ctx 暴露了 sessionDb, agentStore, mcpManager, kbDb... 全部
});
```

**风险**：
- 一个 handler 的 bug 可以影响任意模块
- 测试隔离困难 — mock 一个 handler 需要构造整个 IpcContext
- 安全面过大 — preload 暴露 40+ IPC 频道，无权限模型

**建议**：handler 只接收声明的模块（`modules` 参数已有，但 `_ctx` 仍暴露全部）。加 capability 层限制 handler 访问范围。

---

### A3. 模块就绪系统无法表达失败

[src/main/ipc/module-readiness.ts](../src/main/ipc/module-readiness.ts)

**问题**：`whenReady()` 的 Promise 只有 `resolve()`，没有 `reject()`。模块加载失败后，依赖它的 handler **永远挂起**。

```typescript
resolveModule(name: ModuleName): void {
    entry.resolve();  // 只有成功路径
    // 没有 rejectModule() 方法
}
```

同时，`app:ready` 事件在模块加载完成后无条件发射，即使关键模块失败。UI 可用但功能残缺，用户无法知道哪些模块失败了。

**建议**：加 `rejectModule(name, error)` 方法，`whenReady()` 可 reject。加载完成后向 renderer 发送模块状态报告。

---

### A4. 数据库操作缺少事务边界

[src/server/session-db.ts](../src/server/session-db.ts)

**问题**：多个多语句操作没有事务包裹：

| 方法 | 操作 | 事务 |
|------|------|------|
| `updateSessionUsage()` | 更新 8 列 | ❌ 无 |
| `updateMessageContent()` | 2 条 UPDATE | ❌ 无 |
| `updateTurnContent()` | 2 条 UPDATE | ❌ 无 |
| `deleteMessage()` | DELETE + UPDATE timestamp | ❌ 无 |
| `saveTurn()` | DELETE ALL + INSERT batch | ✅ 有 |

`saveTurn()` 的 delete-all-then-insert 模式在并发调用时有数据丢失风险。

**建议**：所有多语句操作加事务。`saveTurn()` 改为 UPSERT 模式。

---

### A5. SessionDB vs SqliteStore 模式分裂

**问题**：两套数据访问模式并存：

- **SqliteStore** — 通用 CRUD，prepared statement 缓存，自动列映射
- **SessionDB** — 直接 SQL，部分用事务部分不用

新建 store 的开发者不知道该继承哪个模式。错误处理也不一致（SqliteStore 无 try-catch，SessionDB 部分有）。

**建议**：统一到一种模式。SessionDB 的特殊操作（saveTurn、recovery）用 SqliteStore 基础 + 自定义事务方法。

---

## 🟡 中优先级 — 影响可维护性

### B1. Chat Handler 每条消息重建 Provider 状态

[src/main/ipc/chat-handlers.ts](../src/main/ipc/chat-handlers.ts)

```typescript
// 每次 chat:send 都重新读全部 provider 并 setProviders
const providerConfigs = _ctx.providerStore.list().map((p: any) => ({...}));
svc.setProviders(providerConfigs, ...);
svc.sendPrompt(text, agent, sessionId);
```

**问题**：
- 性能浪费 — 每条消息重新构造 provider 列表
- 竞态 — 消息发送期间 provider 配置可能被其他操作修改
- `as any` 绕过类型检查 — provider 字段无验证

**建议**：Provider 配置变更时主动推送，而不是每条消息重读。加 Zod schema 验证 IPC 边界的 provider 数据。

---

### B2. 工具元数据用不可枚举属性存储

[src/runtime/tools/tool-factory.ts](../src/runtime/tools/tool-factory.ts)

```typescript
Object.defineProperty(toolDef, "__meta", { enumerable: false, ... });
```

**问题**：
- `console.log` / `JSON.stringify` 看不到元数据
- 需要专用 accessor 函数（`getToolMeta`, `getToolName` 等）
- 新开发者不知道这些隐藏属性的存在
- 调试时困惑 — 工具对象看起来几乎为空

**建议**：改为 Symbol key 或独立 WeakMap 存储。或者用普通属性（AI SDK 已支持自定义属性）。

---

### B3. Provider Factory 全局可变状态

[src/runtime/provider-factory.ts](../src/runtime/provider-factory.ts)

```typescript
const providerCache = new Map<string, (modelId: string) => any>();
let _concurrencyManager: ... | undefined;
```

**问题**：
- 模块级全局变量 — 测试隔离困难
- 缓存无清理机制 — provider 配置变更后旧缓存可能残留
- 无生命周期管理（健康检查、连接池、回收）

**建议**：封装为 `ProviderRegistry` 类，实例化后注入。缓存带 TTL 和显式 invalidate。

---

### B4. Token 估算过于粗糙

[src/runtime/session.ts](../src/runtime/session.ts)

```typescript
private estimateMessageTokens(msg: ModelMessage): number {
    const json = JSON.stringify(msg);
    return Math.ceil(json.length / 4);  // 粗糙近似
}
```

**问题**：误差可达 ±30%，导致：
- 低估 → 超出 context window → provider 报错
- 高估 → 过早裁剪 → 丢失有用上下文

**建议**：用 tiktoken 或 provider 报告的 usage 字段。至少按语言特征区分（中文约 1.5 字/token，英文约 4 字符/token）。

---

### B5. Renderer 缺少 Error Boundary

**现状**：仅 `AgentsPage.tsx` 有一个 ErrorBoundary。其余组件（ChatPanel、AppLayout、FileTreePanel、Settings）都没有。

**风险**：任何渲染错误直接白屏，用户无法恢复。

**建议**：AppLayout 顶层加一个，ChatPanel 和 SettingsPage 各加一个。提供重试/刷新按钮。

---

### B6. 消息列表无虚拟化

[src/renderer/components/layout/ChatPanel.tsx](../src/renderer/components/layout/ChatPanel.tsx)

**问题**：消息列表直接渲染全部消息，长对话时 DOM 节点过多。streaming 时每个 token 触发重渲染 + 自动滚动。

**建议**：消息列表加虚拟化（react-window 或自实现）。streaming 更新加 debounce。

---

### B7. 流式重试不区分失败类型

[src/runtime/agent-loop.ts](../src/runtime/agent-loop.ts)

重试循环对 `executeStream()` 的所有错误一视同仁：
- Provider API 429/500 → 应该重试
- Tool 执行错误 → 不应该重试整个 stream
- 网络超时 → 可以断点续传
- Context window 超限 → 不应该重试，应该裁剪

当前全部走同一个重试路径，浪费 token 和时间。

**建议**：错误分类后走不同策略：重试 / 裁剪重试 / 直接报错。

---

## 🟢 低优先级 — 代码质量

### C1. IPC 频道命名不统一

`agents:list` vs `agent-tools:list` vs `chat:send` vs `config:get-theme` — 前缀规则不一致。

### C2. 内联样式

`SearchSettings.tsx`、`GuidelinesSettings.tsx` 有内联样式，应抽到 CSS module。

### C3. 裁剪不可恢复

消息被裁剪后永久丢失，无归档机制。用户不知道上下文被截断了。

### C4. 无 IPC 边界验证

handler 接收的参数没有 Zod 校验。前端传 `{apiKey: undefined}` 不会在 IPC 层被拦截。

### C5. Preload 暴露面过大

85 个 IPC 方法全部暴露，无 capability 分级。当前自用可接受，开放给第三方插件时需要改造。

### C6. 列定义双源

`db-migration.ts` 的 `*_COLUMNS` 和各 Store 文件的 COLUMNS 常量是同一个列表的两份拷贝。self-heal 已兜底，但根源没解决。

---

## 依赖关系图

```
问题           影响               修复难度
─────────────────────────────────────────────
A1 AgentLoop  → 可维护性、测试     高（需要仔细拆分）
A2 IpcContext  → 安全、测试隔离     中（已有 modules 声明，加强即可）
A3 就绪系统    → 启动可靠性         低（加 reject 方法）
A4 事务边界    → 数据一致性         低（加 db.transaction()）
A5 模式分裂    → 开发者体验         中（统一模式）
B1 Provider    → 性能、竞态         中（改为推送模式）
B2 元数据      → 调试体验           低（改存储方式）
B3 全局状态    → 测试隔离           中（封装为类）
B4 Token估算   → 上下文管理         中（引入 tiktoken）
B5 Error边界   → 用户体验           低（加 React ErrorBoundary）
B6 虚拟化      → 性能               中（引入虚拟列表）
B7 重试策略    → token 浪费         中（错误分类）
```

## 建议执行顺序

1. **A3 + A4** — 模块就绪 reject + 事务边界（风险低，收益高）
2. **B5 + B6** — Error Boundary + 消息虚拟化（用户体验直接提升）
3. **A2 + B1** — IpcContext 最小权限 + Provider 缓存（中期改善）
4. **A5** — 统一 store 模式（数据层统一）
5. **A1** — AgentLoop 拆分（最大工程量，等前面稳定后再做）
