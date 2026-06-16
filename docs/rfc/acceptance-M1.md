# Acceptance M1 — cron 一等公民

> **前置**: `plan-overview.md` A0 通用前置(本文件不重复)。

- [ ] `CronRecord` 表与 `CRON_COLUMNS` 已建;字段齐全(`agentId` / `workingScope` / `schedule` / `prompt?` / `enabled`)
- [ ] `CronAnalysisManager` 调度源已从「扫 agentStore.cronSchedule」切到「扫 cron 表」;旧字段消费端已清理
- [ ] cron 触发时,`workingScope` → session bundle,经 `resolveSessionByRoleProject(agentId, projectId)` 找/建 session
- [ ] zero 的 cron 管理工具可用(create/update/delete cron)
- [ ] cron 编辑器 UI 可选 agent + scope + schedule + prompt + enabled

### 端到端验证
- [ ] 一个全局 PM agent + 两条 cron(project A hourly / project B daily)→ 各自按时触发到**两个不同 session**
- [ ] `enabled=false` 的 cron 不触发
- [ ] 删 cron 不删它引用的全局 agent(解绑,不级联删 agent)
