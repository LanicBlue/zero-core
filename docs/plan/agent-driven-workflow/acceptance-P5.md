# Acceptance P5 — project 模块 + 项目页

> **前置**:P0。**核心**:验「容器视图 + 项目页三 tab + 资源消耗 + 级联删 crons + 死代码」。

### 容器视图
- [ ] `Project(get, includeContext)` 返回 project + requirementsByStatus + crons + wikiSummary + activeSessions
- [ ] requirementsByStatus 按 status 分组正确
- [ ] crons 按 workingScope.projectId 过滤;wikiSummary 统计;activeSessions 按 context.projectId
- [ ] 容器视图**不含 agent 列表**(agent 全局)

### create 副作用
- [ ] create 同步建空 wiki 子树根(ensureProjectSubtree);project 即刻可用
- [ ] 异步 kick 扫描任务(扫描完整逻辑在 P1/P7)

### 项目页(替换看板)
- [ ] 项目页:左列表(+新建) + 右三 tab
- [ ] 仪表盘:更新情况 + 资源消耗(sessions token SUM by projectId)
- [ ] 动态:status_history + messages + cron usage 派生时间线
- [ ] 项目视图:容器视图可视化
- [ ] 看板 tab:按 status 的 requirement 列(功能不退化)

### 资源消耗
- [ ] SUM(sessions tokens/cost) WHERE context.projectId = 项目 正确
- [ ] 无 projectId 的 session(全局/zero)不计入任何 project

### 死代码 + 级联
- [ ] projects:pause/resume/updateInterval IPC + handler + REST 已删
- [ ] POST /api/projects/:id/trigger-analysis 已删
- [ ] 删除 project 级联清 requirements + task_steps + wiki 子树 + **crons**(补上)

### 测试(sub2 写 + 跑)
- [ ] 容器视图 API:聚合各表正确(snapshot)
- [ ] 级联删除:crons 也被删(当前漏,P5 补)
- [ ] 资源消耗 SUM 正确(含/不含 projectId 边界)
- [ ] e2e:项目页三 tab 渲染 + 新建项目

### 边界(不验证)
- [ ] ~~archivist 渐进扫描两阶段完整逻辑~~ → P1/P7
- [ ] ~~Cron 调度 UI~~ → P4
- [ ] ~~Wiki 浏览器~~ → P8
