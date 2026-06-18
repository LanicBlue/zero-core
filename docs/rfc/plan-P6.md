# Plan P6 — 角色 template 改名 + prompt + fresh-DB seed

> **依赖**:P0(AgentRecord 字段)+ P2(runtime 不读 roleTag)。可与 P4/P5 并行。
> **对应规范**:§7.1 / §7.2 / §12。**验收**:`acceptance-P6.md`。
> **文件**:`src/runtime/role-presets.ts`→`role-templates.ts`、`src/server/preset-router.ts`→`template-router.ts`、`src/server/zero-admin-service.ts`(buildAgentFromPreset→Template)、`src/server/index.ts`(seed 点)。

**为什么独立**:template 改名 + prompt 是自包含的文字工作,依赖 P0 字段,不依赖 wiki/流程逻辑。可并行。

## 设计细节要求

### Preset → Template 改名(§7.2)

1. `role-presets.ts` → `role-templates.ts`;`ROLE_PRESETS` → `ROLE_TEMPLATES`;`getPreset/listPresets` → `getTemplate/listTemplates`;`buildAgentFromPreset` → `buildAgentFromTemplate`;`RolePreset` 类型 → `RoleTemplate`。
2. `preset-router.ts` → `template-router.ts`;路由 `/api/presets` → `/api/templates`;IPC `presets:*` → `templates:*` + ROUTE_MAP 同步(契约 1.1)。
3. zero-admin-service / zero-admin-tools 引用同步。
4. **buildAgentFromTemplate 不再拷 roleTag 到 AgentRecord**(P0 已删该字段)。Template 类型可保留 `roleTag` 字段(template 自己的组织元数据),但不传给 agent。

### §12 prompt 原地改(§12,在现有模板基础上)

5. zero/pm/lead/archivist/developer/reviewer/qa 的 system prompt 按 §12 适配 v0.8:
   - lead:verify 是提交门(等 PM 判)、不合并、自己 plan(无 planner 硬依赖)。
   - PM:verify 接收 lead 提交判覆盖、不碰合并。
   - archivist:引用文档为叶、管 main、PM 触发合并、渐进扫描。
   - **把混进 system prompt 的任务规则/输出格式挪到工具**(§12 三层:任务在工具/风格在角色/对象在调用)——dev/reviewer/qa 的 Rules/Output format 移到调用 prompt(工具/dispatch 模板)。
6. **analyzer/planner 模板保留不动**(抽象定义,不用,代码原样)。

### fresh-DB seed(§7.1)

7. `startServer`(`src/server/index.ts`)内,所有 store 建好后、restoreAllSessions 之前,检查 `agentStore.list().length === 0` → seed:
   - 一个 zero agent(workspaceDir=`~/.zero-core`,从 zero template 实例化)。
   - wiki `knowledge/software-dev` 节点(正文 = software-dev 工作流配置:需要哪些角色、谁委派谁、谁配 cron)。
8. 两者 **protected 不可删**:Agent(delete: zero) 和 Wiki(delete: software-dev 节点) reject。
9. seed 是启动期特权写入,绕过运行时 scope guard(P1 守卫对 seed 路径放行)。

## 风险

- **改名牵连广**:role-presets 被多处 import;漏改导致 import 断。改前 grep 全部引用。
- **prompt 改动影响行为**:lead/PM prompt 改动大,可能短期行为回退;依赖 P7 端到端测试兜底。
- **software-dev seed 内容**:节点正文要写「完整工作流配置」——本阶段先写一个合理的 software-dev playbook 草稿(角色清单 + subagents 关系 + cron 建议),后续可 refine。
- **protected 误伤**:delete reject 要精确(只拦 zero agent id 和 software-dev 节点 id),别拦正常删除。

## 不在本阶段

- AgentRecord 字段(P0 已做);runtime roleTag 清理(P2 已做)。
- software-dev playbook 的精细内容 → 可后续 refine(本阶段草稿够 seed)。
- 4 action 工具里的 Agent delete protected 判断 → P3(本阶段 store 层直接拦)。
