# acceptance-6:DashboardPage 切 dispatcher + UI REST 退场

对应 `sub-6.md`(闭合 acceptance-5 #4/#5)。

## 用例

1. **Platform providerUsage 资源**:`toolRun({tool:"Platform", input:{resource:"providerUsage", provider, granularity, range}})` 返 typed JSON(PlatformProviderSeries)+ format 文本。
2. **Platform providerQueue 资源**:`toolRun({tool:"Platform", input:{resource:"providerQueue", provider}})` 返 typed JSON(PlatformProviderQueueEntry[])+ format。
3. **Cron today action**:`toolRun({tool:"Cron", input:{action:"today"}})` 返 typed JSON(PlatformCronTodayItem[])+ format。
4. **DashboardPage 全切 dispatcher**:6 处数据获取(sessionsParents/sessionsDetail/providerStats/providerUsage/providerQueue/cronsToday)全走 `api().toolRun`;unwrap 正确;看板显示同今天(行为不回归)。
5. **UI REST 退场**:6 个 UI 用 REST/IPC(sessions/parents、sessions/detail、providers/stats、providers/usage、providers/queue、crons/today)删;preload/preload-types/WindowApi 同步清。grep 0 命中(或仅 dispatcher 入口 tool-run/tool-execute 保留)。
6. **无外部消费者**:删的 REST grep 确认只有 renderer + tests 用(无外部)。
7. **agent 路径不回归**:Platform providerUsage/queue、Cron today 经 buildTool wrapper 在 agent 运行中可用(format 文本喂 LLM)。
8. **三 host 同 execute**:dispatcher / agent wrapper 调同一 getToolExecute。

## 验证手段

- 单测:Platform providerUsage/queue 返 JSON + format;Cron today 返 JSON + format。
- 单测/手测:DashboardPage 经 dispatcher 拿 6 类数据,unwrap 后形态正确。
- grep:6 个 UI REST/IPC 已删;`cronManager.listTodaysFires` 仍被 today action 调用(不是被删 REST 调)。
- typecheck 三层(含 web)+ build:lib(tsc)+ vitest(主 cwd)全套。
