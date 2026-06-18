# Plan P5 — project 模块 + 项目页

> **依赖**:P0(wiki/sessions/crons schema)。可与 P4/P6 并行。
> **对应规范**:§8。**验收**:`acceptance-P5.md`。
> **文件**:`src/server/project-store.ts`、`src/server/project-router.ts`、`src/main/ipc/project-handlers.ts`、`src/renderer/components/requirements/KanbanPage.tsx`(→ 项目页)、`src/renderer/store/project-store.ts`。

**为什么独立**:Project 是容器视图 + UI 重构,依赖 P0 schema,不依赖 wiki/agent 运行时逻辑。可并行。

## 设计细节要求

### Project action 工具 + 容器视图(§8.2 / §8.4)

1. `Project` get(includeContext) 返回容器视图:`project + requirementsByStatus + crons + wikiSummary + activeSessions`。
2. requirementsByStatus:RequirementStore.listByProject 按 status 分组。
3. crons:CronStore 按 workingScope.projectId 过滤。
4. wikiSummary:WikiStore.listByProject 统计(nodeCount/lastUpdated/scanProgress)。
5. activeSessions:SessionDB 按 context.projectId 过滤(含 agentId/name/sessionId)。

### create 副作用(§8.3)

6. create 同步 `ensureProjectSubtree`(空根 wiki-root:<projectId>);异步 kick archivist 渐进扫描(archivist 扫描逻辑完整版见 P1 的注入 + P7 的 archivist 行为;本阶段先接「建空根 + 触发扫描任务」)。

### 项目页(§8.5,替换看板页)

7. KanbanPage → 项目页:左栏项目列表(+新建) + 右栏三 tab:
   - 仪表盘+动态:更新情况(wiki 扫描进度/git main HEAD/sync 时间)+ 资源消耗(sessions token SUM by projectId)+ 动态时间线(status_history + messages + cron usage 派生)。
   - 项目视图:容器视图可视化(requirements/crons/wiki/sessions)。
   - 看板:现有 kanban 按 status 的 requirement 列(内嵌)。
8. 资源消耗:`SUM(sessions.{input/output/total_tokens, estimated_cost_usd}) WHERE context.projectId = ?`。无 projectId 的(全局/zero)不计入任何 project。

### 死代码(§8.6)

9. 删 `projects:pause/resume/updateInterval` IPC + project-handlers:51-72 + REST(P4 已删调度通道,本阶段补 REST/router 侧)。
10. 删 `POST /api/projects/:id/trigger-analysis`(扫描归 archivist)。
11. 级联删除补「删该 projectId 的 crons」(当前漏)。

## 风险

- **容器视图聚合性能**:每次 get 查 requirements+crons+wiki+sessions 多表;大项目慢——考虑缓存或按需子查询。
- **资源消耗 SUM**:sessions 表无 projectId 索引时按 context.projectId(JSON)过滤慢;可能要加索引或冗余列。
- **项目页替换看板**:看板有既有用户,替换要保证看板 tab 功能不退化。
- **activeSessions 定义**:活跃 = 最近 N 分钟有 turn?还是所有 context.projectId 匹配的?明确避免列表膨胀。

## 不在本阶段

- archivist 渐进扫描的完整两阶段逻辑 → P1(注入)/ P7(archivist 行为);本阶段只接 create 副作用触发。
- Cron 调度 UI → P4。
- Wiki 浏览器 → P8。
