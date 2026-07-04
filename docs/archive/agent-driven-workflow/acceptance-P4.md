# Acceptance P4 — cron 重写 + 调度台

> **前置**:P0(crons 三模式 + cron_runs 表)。**核心**:验「三模式调度 + cron_runs + 调度台 UI + 死代码删」。

### 调度器
- [ ] once 到点触发后 enabled=false;setTimeout 调度
- [ ] alarm 按 (time, days) 触发并滚动重算下一次
- [ ] interval 每 everyMs(≥60000)触发
- [ ] missed once 启动时不补(置 disable + 记 cron_runs missed)
- [ ] alarm/interval 启动只算下一次未来时刻
- [ ] 单次触发错误不取消调度(catch + log + cron_runs failed)

### cron_runs / 回写
- [ ] 每次触发落 cron_runs(fired_at/agent_id/session_id/success/duration/tokens/cost)
- [ ] 回写 last_run_at / last_status / next_run_at

### Cron 工具
- [ ] Cron action 工具 update 后 refreshCron 重算 next_run
- [ ] list 支持 projectId/agentId/enabled 过滤
- [ ] trigger 立即运行(不计 next_run)

### 调度台 UI
- [ ] 顶级页(移出 settings):24h 时间轴 + 闹钟卡片网格 + 分组切换 + 闹钟式新建
- [ ] 卡片:下次时间/重复标签/启用 toggle/状态点/倒计时/立即运行/展开 history

### 死代码
- [ ] projects:pause/resume/updateInterval IPC + handler + REST 已删

### 时区
- [ ] once fireAt ISO 带偏移;alarm tz(IANA);UI 本地显示;触发时刻正确

### 测试(sub2 写 + 跑)
- [ ] 调度器:三模式各触发一次(假时钟/mock setTimeout)+ missed-once 不补
- [ ] alarm 跨周下一次计算正确
- [ ] cron_runs 落记录 + 回写字段
- [ ] e2e:调度台 UI 渲染 + 新建/启用/立即运行

### 边界(不验证)
- [ ] ~~cron 表结构~~ → P0
- [ ] ~~cron-analysis legacy aliases 删~~ → P9
