# Issue:platform-observability

- **状态**:① issues(问题记录)
- **提出**:2026-07-07
- **类型**:改进

## 问题

平台管理视角单薄:session 运行状态、provider 运行观测、首页看板三块都缺一个面向"平台管理"的统一观测视角,且首页看板的重设计依赖前两块的接口/数据先就位。

## 现状 / 真相源 / 影响面

三块(③ 依赖 ①②):

### ① session 观测

- 数据层已有,但无面向父 session 的观测口:
  - `agent-service.ts` `runStates`(sessionId→{isBusy,waiting,streamingText,toolCalls},:590/:1002/:1591)、`activeSessions`(agentId→activeSessionId,:142/:437)、`isSessionRunning(sessionId)`(:576)、`db.getMainSession(agentId)`、`listDelegatedTasks({parentSessionId})`(:798)、`session_kind` chat/delegated。
  - `Platform` 工具([platform-tools.ts](../../../src/runtime/mcp-tools/platform-tools.ts))有 info/logs/config/providers 四个 resource,**无 session resource** —— agent 无法自省"父 session(agent-general / agent-project)现在 running/waiting/idle、跑到哪个 turn、派了几个子"。
- 首页看板 `DashboardPage.tsx` 有 per-session `SessionMetrics`(inputTokens/outputTokens/totalTurns/errorCount/lifecycleState)+ busy/idle 汇总计数,但**不是面向父 session 的清单+钻取视角**,也不供 agent 自省。

### ② provider 观测

- `Platform` 'providers' resource([platform-tools.ts:128](../../../src/runtime/mcp-tools/platform-tools.ts#L128))只读静态配置(name/type/enabled/modelCount/baseUrl/redacted apiKey)。
- `DashboardPage.tsx` 有 `ConcurrencyInfo`(per provider active/waiting 即时并发数)。
- usage(tokens)在 `agent-loop.ts:1367` `finalizeOneStep` 按 **step/session** 捕获(含 cacheRead/cacheWrite/reasoning),但**未按 provider 聚合** —— 缺 provider 维度的运行观测(用量/成本/错误率/延迟/quota)。
- 影响:无法判断哪个 provider 在烧 token、哪个出错率高、哪个该换。

### ③ 首页看板页重设计(依赖 ①②)

- 现有 `DashboardPage.tsx` 以 SessionMetrics token 统计 + 并发快照为主,组织轴不是"平台管理"。
- 缺把 ① session 运行状态 + ② provider 运行观测 组织成的看板视角;且 ③ 的数据/接口依赖 ①② 先落地。

## 下一步

进② design 细化方案(`/effort design`)。三块耦合(③ 依赖 ①②),design 时定接口边界 + 实施顺序。
