# Plan M1 — cron 一等公民

> **依赖**: M0(bundle + routing)。
> **对应 RFC**: §2.4 / §4.3(CronRecord)/ §5 服务层。
> **验收**: `acceptance-M1.md`(前置见 `plan-overview.md` A0)。

## 设计细节要求

1. `CronRecord` 新表:`{ id, agentId, workingScope:{projectId?, workspaceDir, wikiRootNodeId}, schedule, prompt?, enabled, createdAt, updatedAt }`(RFC §4.3)。`schedule` 取值 `"off" | "hourly" | "daily" | "weekly" | string`;**同步 `CRON_COLUMNS`**。
2. `CronAnalysisManager` **调度源切换**:从「扫 agentStore.cronSchedule」切到「扫 cron 表」(多条 cron,各带 scope)(RFC §5 服务层)。旧的 agent cronSchedule 字段已在 M0 删除,这里只是消费端切源。
3. **scope → session bundle 解析**:cron 触发时,`workingScope` 即 session 上下文 bundle;调 M0 的 `resolveSessionByRoleProject(agentId, projectId)` 找/建 `{agentId, scope}` session → 跑(决策 41/42)。
4. **同 agent 配 N 条 cron = N 个 scope**:全局 PM 服务多个 project,各 project 一条 cron(决策 6)。`workingScope.wikiRootNodeId` 项目 cron = project 子树根;全局观察 cron = 全局根。
5. zero 的 **cron 管理工具**(create/update/delete cron,指定 agent + scope + schedule)(决策 24)。
6. **cron 编辑器 UI**:选 agent + scope(projectId/workspace/wikiRoot)+ schedule + prompt(可选)+ enabled toggle。

## 验收指针

一个全局 PM agent + 两条 cron(project A hourly / project B daily)→ 各自按时触发到两个不同 session;`enabled=false` 不触发;删 cron 不删它引用的全局 agent。
