# sub-5:② provider 观测暴露

> ② 暴露面。Platform provider 观测 resource(agent 自省)+ IPC(③ 看板消费)。对应 design ② 暴露面。依赖 sub-2(数据)+ sub-3(排队)。

## 任务

### Platform provider 观测 resource(文本)

- 新 resource 值 `'providerStats'`(或扩展 'providers';实现者择一,保持文本格式同 ①)。
- 输出 per-provider 一行(全部 provider,非单选 —— 单选 combobox 是 ③ 看板的事,Platform 给 agent 全览):
  `name · enabled · in-flight/max · queue · tokens(累计)· calls · err% · avg latency`。
- 数据:静态配置(providers 表)+ 即时并发(`concurrencySnapshot`/`getActiveCount`/`getWaitingCount`)+ 累积(`ProviderUsageStore.cumulative`,sub-2)+ latency(进程内 running,sub-2)+ 排队(`getWaiting()`,sub-3)。

### IPC(给 ③)

- `provider:stats` → 全 provider 累积统计 JSON(供 KPI/combobox 选项)。
- `provider:usage { provider, granularity: hour|day, range: 24h|30d, model? }` → 时序桶(JSON,供堆叠柱状图;模型作 series)。
- `provider:queue { provider }` → 排队 session 清单 JSON(供排队列表)。

## 范围

- 只读暴露。数据全部来自 sub-2(ProviderUsageStore)+ sub-3(getWaiting)+ 现有并发/配置。
- 不做 cost、不做余额。

## 风险

- latency 进程内 running(sub-2),重启清零 —— IPC 返当前运行期值,标注。
- per-model series:provider:usage 按 model 分组返多 series,看板堆叠用。

## 验收

见 `acceptance-5.md`。
