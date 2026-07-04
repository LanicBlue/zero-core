# plan-F4 — UI 接入(复用现有控件)+ 公共后端 + 迁移

> 节点 F4(依赖 F3)。目标:用户确认动作(pick/ready/startBuild/verify)经现有 UI 控件 → Flow action 公共后端;既有项目交付 work hook + 旧文档路径迁移。**文档查看无需新 UI**(doc 是文件,现有文件树 → DocViewerPanel 已能显示)。对应 [project-flow.md](../../design/project-flow/project-flow.md) §4/§5/§9。

## 范围(按最终模型 —— doc 是文件、不加导航、文件树跟 worktree)
1. **抽 Flow action 公共后端**:把 flow-tool execute 里的"迁态 + 写文档段 + emitTransition"(以及 verify 复合逻辑)抽成共享函数,Flow execute 与 REST 都调——单源,不分叉。
2. **REST 接 Flow 后端**:[requirement-router.ts](../../../src/server/requirement-router.ts) transition/create 等端点改调 Flow 公共后端(透传 signal + 写文档段)。
3. **UI 控件接 REST**(用户确认 = 未暴露给 agent 的 action):
   - [RequirementHeader](../../../src/renderer/components/requirements/RequirementHeader.tsx) `onTransition`(状态选择器)→ pick/ready/startBuild/verify 经 REST。
   - [CoverageJudgementModal](../../../src/renderer/components/requirements/CoverageJudgementModal.tsx) → verify(通过/打回)经 REST。
   - 看板 pending-plan Confirm/Reject → startBuild/打回 经 REST。
   - 建/选中需求入口(CreateRequirementModal 等)→ Flow.create/pick 经 REST。
4. **迁移**:
   - 既有项目交付 work hook `requirements.create` → `requirements.ready`(seedDefaultProjectWorks 只跑新项目;既有项目需一次性补 seed 或 hook manager 过渡期双认 create/ready)。
   - 旧文档路径 `.zero/requirements/{projectId}/{id}.md` → `docs/requirements/{id}.md`(docPath 更新 / 兼容读)。
5. **文档查看**:无新 UI。doc 是 `{workspace}/docs/requirements/{id}.md` 文件,现有文件树(MiddlePanel WORKSPACE 段)选中 → DocViewerPanel 渲染。文件树根跟活动 session worktree(build 期显 worktree,文档不在——可接受,决策在项目上下文做)。

## 实现步骤
1. **抽公共后端**:flow-tool 的 transition+writeDocSection+emitTransition 逻辑(及 verify 复合)抽成 management-service 方法或纯函数模块(`flow-actions.ts`),签名吃 stores/services;flow-tool execute 改调它,REST 也调。
2. **REST 改接**:requirement-router transition/create/coverage-verdict 端点 → 公共后端。
3. **UI 控件改调 REST**:RequirementHeader/CoverageJudgementModal/kanban pending-plan/CreateRequirementModal 的 transitionStatus/coverage 调用 → 走更新后的 REST(透传 signal + 写文档段)。renderer 调用点改动小,不动 ChatPanel 内联渲染。
4. **迁移脚本/逻辑**:既有 project 交付 work hook 改 ready(一次性);旧 docPath 兼容(读时 fallback)。
5. **测试**:公共后端单源(Flow execute 与 REST 走同一函数);REST → 后端 → 迁态+段+signal;UI 控件 → REST;迁移(既有 work hook 改 ready)。

## 关键文件
`requirement-router.ts` · management-service / `flow-actions.ts`(公共后端)· `flow-tool.ts`(复用)· `RequirementHeader.tsx` / `CoverageJudgementModal.tsx` / `KanbanBoard.tsx`(pending-plan)· `CreateRequirementModal.tsx` · 迁移(seed/migration)

## 不做(留 F5)
- 删旧文件(verify-tool.ts / requirement-tools.ts)/ 注释清扫 / code-graph。

## 风险
- **公共后端抽离别引入分叉**:Flow execute 与 REST 必须走同一段迁态+写段+signal 逻辑(否则 UI 和 agent 行为不一致)。
- ChatPanel 830 行 tab/CRLF——只改 transition 调用点,不动内联渲染。
- **既有 work hook 迁移**:既有项目交付 work 仍 hook=create;不改则旧项目 ready 后不 fire 交付。需一次性补(migration 或启动时 resync)。
- **旧 docPath 兼容**:既有需求 docPath 指 .zero/requirements/...;读时 fallback 或一次性迁移。
- 文件树跟 worktree:build 期文档不在 worktree 文件树——用户在项目上下文(PM/discuss)看文档;确认这点不破坏(build 期用户不靠文件树看文档)。
