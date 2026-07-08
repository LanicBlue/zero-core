# sub-6:DashboardPage 切 dispatcher + UI REST 退场(闭合 acceptance-5 #4/#5)

> 决策 4 收口。sub-5 发现的真阻塞:DashboardPage 6 个数据端点中 3 个(providerUsage/providerQueue/cronsToday)无工具底层。本 sub 补齐工具资源 → 切看板 → 删 UI REST。依赖 sub-1..5(全已落地)。

## 背景(sub-5 验证确认的真缺口)

DashboardPage(`src/renderer/components/dashboard/DashboardPage.tsx`)用 6 个 IPC/REST 端点:

| 端点 | 数据源 | sub-5 前工具覆盖 |
|---|---|---|
| `sessionsParents` | `agentService.listParentSessions()` | ✅ Platform `resource:"sessions"` |
| `sessionsDetail(id)` | `getSessionTaskTree` + `getSessionRecentSteps` | ✅ Platform `resource:"sessions", sessionId` |
| `providerStats` | `agentService.listProviderStats()` | ✅ Platform `resource:"providerStats"` |
| `providerUsage(name,gran,range)` | `agentService.getProviderUsageSeries()` | ❌ 无 |
| `providerQueue(name)` | `agentService.getProviderQueue()` | ❌ 无 |
| `cronsToday` | `cronManager.listTodaysFires()`(CronAnalysisManager) | ❌ 无 |

另:工具返 `{ok,data:{...}}`,REST 返裸数组 → 切换时 6 处调用点要 unwrap。

## 任务

### A. Platform 工具补 2 个资源(`src/tools/mcp/platform-tools.ts`)
- `resource` enum 加 `"providerUsage"` / `"providerQueue"`。
- `providerUsage`:input `{resource, provider, granularity:"hour"|"day", range:"24h"|"30d", model?}` → `getAgentService().getProviderUsageSeries(...)` → typed JSON + format(文本形态参照现有 providerStats render)。
- `providerQueue`:input `{resource, provider}` → `getAgentService().getProviderQueue(provider)` → typed JSON + format。
- data shape export(sub-5 dispatcher 消费)。

### B. Cron 工具补 `today` action(`src/tools/cron-tool.ts`)
- action enum 加 `"today"`。
- `getCronAnalysisManager()/setCronAnalysisManager()` 单例(`src/server/cron-analysis.ts` 加模块级 `_inst`;`src/server/index.ts` 启动注册,时序早于任何工具调用)。
- `today` action → `getCronAnalysisManager().listTodaysFires()` → typed JSON + format。
- (若 CronAnalysisManager 不便单例化,可把 listTodaysFires 暴露到 ManagementService/AgentService 复用其单例——实现者判断哪种干净。)

### C. 切 DashboardPage 到 dispatcher
- 6 处数据获取(`sessionsParents/sessionsDetail/providerStats/providerUsage/providerQueue/cronsToday`)全改 `api().toolRun({tool, input})`。
- unwrap:`toolRun` 返 `{ok, result}` → `result.data.{rows/stats/series/queue/items}` 取裸数据,喂现有渲染逻辑(渲染不改,只改数据获取 + unwrap)。
- 行为不回归(看板显示同今天)。

### D. UI REST 退场
- 删 6 个 UI 用 REST/IPC:`sessions/parents`、`sessions/detail/:id`、`providers/stats`、`providers/usage`、`providers/queue`、`crons/today`(分布在 cron-router / agent-router / 等;grep 定位)。
- 对应 IPC preload 暴露 + preload-types + WindowApi 类型同步删。
- **先 grep 确认无外部消费者**(只有 renderer + tests)——sub-5 已确认无外部,本 sub 复核。
- `/api/tool-execute` / `/api/tool-run`(dispatcher 入口)保留。

## 范围

- 只动看板数据获取层 + 删 UI REST;不改看板渲染/布局(platform-observability ③ 看板重设计是另一回事)。
- 不影响 agent 路径(Platform/Cron 工具经 buildTool wrapper,新资源/action 自动可用)。

## 风险

- unwrap 形态错位 → 看板空白/报错。逐端点核对 data shape。
- CronAnalysisManager 单例时序(同 sub-2 注册时序坑)。
- 删 REST 漏删 IPC/preload 残留 → 类型错或死代码。

## 验收

见 `acceptance-6.md`。
