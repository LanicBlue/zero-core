# sub-6:③ 首页看板重设计

> ③ 收尾。DashboardPage 横向重设计。对应 design ③。依赖 sub-4(① IPC)+ sub-5(② IPC)。

## 任务

重写 [`DashboardPage.tsx`](../../../src/renderer/components/dashboard/DashboardPage.tsx) 为横向布局(窗口宽>高):

1. **顶 KPI 条**(全宽):会话数 / 运行 / 等待 / 今日 token / 错误(聚合,消费 sessions:metrics + provider:stats)。
2. **左 `agent` 栏**(① List,~35%):每行 `状态点 · agentId · status · 相对时间 · turns`(**不显 sessionId**)。点行 → 抽屉/展开 ① Detail(task tree + 最近3step,消费 sessions:detail)。
3. **右 今日任务**(今日 cron,~65%):消费新 IPC `crons:today`。每条 `触发时间(today) · agent · 类型[work|cron|git-aware] · 标签 · 上次结果`。含 workId cron。
4. **底 Provider**(全宽):combobox 单选 provider → 显示 in-flight/queue + tokens/calls/err/latency + 排队列表(provider:stats/queue)+ **堆叠柱状图**(provider:usage,日视图小时柱 / 过去30天视图天柱,切换;每柱分段=模型,柱高=总量)。

### 新 IPC `crons:today`

- 遍历 enabled cron,用 `nextFireMs`([cron-analysis.ts:272](../../../src/server/cron-analysis.ts#L272))算今天的 fire 时间;返 `{cronId, agentId, fireTime(today), type: work|cron|git-aware, label, lastResult}`。lastResult 来自 CronRunStore。

## 范围

- 纯前端(看板)+ 一个新只读 IPC(crons:today)。数据全消费 sub-4/sub-5 + cron。
- 堆叠柱状图组件:可用现有 chart 库(若有)或轻量自绘;实现者择优。

## 风险

- 图表库依赖(若无现成,引入需评估)。
- IPC 轮询/刷新频率(KPI 实时性 vs 开销)。
- 相对时间格式统一。

## 验收

见 `acceptance-6.md`。
