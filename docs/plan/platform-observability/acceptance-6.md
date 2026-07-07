# acceptance-6:③ 首页看板重设计

对应 `sub-6.md`。

## 用例

1. **四区渲染**:DashboardPage 渲染 顶 KPI 条 / 左 agent 栏 / 右 今日任务 / 底 Provider(横向布局,宽屏铺开)。
2. **KPI 条**:会话/运行/等待/今日 token/错误 正确(聚合数据源)。
3. **agent 栏**:列父 session(无 sessionId),status 点(running/waiting/idle)+ 相对时间 + turns;点行展开 task tree + 最近3step。
4. **今日任务**:列今日会触发的 cron(含 work/git-aware),触发时间 + 类型 + 上次结果;interval 型显频率。
5. **Provider combobox**:选一个 provider → 显示其 in-flight/queue + 统计 + 排队列表。
6. **堆叠柱状图**:日视图 = 近24h 小时柱;30天视图 = 近30d 天柱;每柱分段=模型,柱高=总量;视图切换生效。
7. **IPC crons:today**:返今日 cron 清单(nextFireMs 计算,含 workId)。

## 验证手段

- web 层 typecheck(tsc web)。
- 组件测/手测:DashboardPage 四区渲染无错;combobox 切换 + 图表视图切换。
- IPC crons:today 单测(nextFireMs 算今日 fire)。
- 数据消费正确(接 sub-4/sub-5 IPC)。
