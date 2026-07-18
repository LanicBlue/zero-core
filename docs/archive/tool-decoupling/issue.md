# Issue:tool-decoupling

- **状态**:① issues(问题记录)
- **提出**:2026-07-08
- **类型**:改进(架构)

## 问题

工具与 agent loop 耦合:工具通过 per-loop 的 `ctx`(`ToolExecutionContext`)依赖袋拿数据,把**两类东西混在一个袋子里**——app 级服务(db/stores/agentService)与调用者身份(sessionId/agentId)。导致:同一份业务逻辑要维护**两条入口**(agent 走工具经 ctx、UI 走 REST 直读),且 per-loop 注入易漏(已发 bug)。目标方向(待 design 细化):工具 = 纯函数 `f(input) -> output`,在哪调都一样;loop 对工具只做权限闸 + 把调用者身份作为 input 传入;UI 与 agent 共用同一工具。

## 现状 / 真相源 / 影响面

### 工具-ctx 耦合现状
- 工具签名 `execute(input, ctx)`,ctx = `ToolExecutionContext`([types.ts](../../../src/runtime/types.ts))。工具内部读 ctx.db / ctx.wikiStore / ctx.platformObserver / ctx.sessionId … 拿依赖。
- ctx 由 server 建 loop 时拼装(`agent-service.ts` `createLoopForSession` [:995](../../../src/server/agent-service.ts#L995)、`sendProjectPrompt` [:1271](../../../src/server/agent-service.ts#L1271)、`buildSessionConfigForEviction` [:855](../../../src/server/agent-service.ts#L855)),再镜像到 ctx([agent-loop.ts:311](../../../src/runtime/agent-loop.ts#L311) 附近)。

### 两类东西混在 ctx
- **app 级服务**:db / wikiStore / platformObserver / management / requirementStore …(全 app 一份)
- **调用者身份**:sessionId / agentId(随调用变)
- 二者混进同一个 ctx → 工具结果依赖"在哪个 loop 里调",不是纯函数。

### 两条入口(同一逻辑两份适配)
同一 agentService 方法被两种入口调:
- agent 入口:Platform 工具(`platform-tools.ts`)→ `ctx.platformObserver.listParentSessions()`(经 ctx,文本输出)
- UI 入口:REST router([session-router.ts](../../../src/server/session-router.ts) / [provider-router.ts](../../../src/server/provider-router.ts))→ `agentService.listParentSessions()`(直读,JSON 输出)
- 逻辑一份(agentService 方法),入口两份 + 工具入口的 ctx 注入舞。

### 已发 bug(per-loop 注入易漏)
- `platformObserver` 注入在 `createLoopForSession`([:1099](../../../src/server/agent-service.ts#L1099))和 `buildSessionConfigForEviction`([:897](../../../src/server/agent-service.ts#L897)),但**漏了 `sendProjectPrompt`**([:1271](../../../src/server/agent-service.ts#L1271),work/cron 路径)→ work/cron agent 调 Platform `sessions` 拿到 "Session observer not available" 兜底文案。
- 这类"某条 loop 创建路径漏注入"的坑,只要工具还靠 per-loop ctx 注入,**结构性会再冒**。

### 权限层(已在对的地方)
- toolPolicy / `buildToolsSet` 已在 loop 侧做权限闸(autoApprove / blockedTools / tools 可见性)—— 这层**已经符合目标模型**(loop 只管权限)。
- 缺的是把"工具内部依赖"从 ctx 拆成:**app 级服务 → app 单例(工具直读)** + **调用者身份 → 显式 input**。

### 工具分类(影响迁移形态)
- **app 级数据工具**(Platform info/logs/sessions/providers、Wiki 读、Cron 列表、Read/Grep/Bash(OS 类)):纯函数化顺畅,无 session 作用域纠结。
- **session 作用域工具**(TodoWrite 写本 session todos、Task 工具操作调用方 registry、Wait):需 "哪个 session" 作为**显式 input 字段**(loop 自动填),而非藏 ctx。

## 下一步

进② design 细化方案(`/effort design`):定单例服务暴露形态、input 字段约定(sessionId 等)、UI 与 agent 共用工具的调用契约、增量迁移顺序(Platform 先行 / app 级工具 / session 作用域工具)、文本 vs JSON 输出形态统一。
