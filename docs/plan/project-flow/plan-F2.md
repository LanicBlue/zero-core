# plan-F2 — 迁移 action + 显式命名 hook 信号

> 节点 F2(依赖 F1)。目标:Flow 补全**简单迁移 action**(pick/ready/plan/startBuild/finishBuild),每个 = transitionStatus + 写文档段 + 显式发命名信号;扩展 data-change-hub 加 `emitTransition`、ProjectWorkHookManager 匹配命名信号。对应 [project-flow.md](../../design/project-flow/project-flow.md) §2/§3/§9。
> **verify(复合)+ worktree + work 重配 + 替换旧工具 留 F3。**

## 范围
- Flow 加 action:`pick` / `ready` / `plan` / `startBuild` / `finishBuild`(每个 transitionStatus + 写文档段 + 发命名信号)。
- **显式命名信号机制**(已定方案 A):data-change-hub 加 `emitTransition(collection, signal, id, record)`;Flow action 迁态后调它发 `requirements.<signal>`。
- ProjectWorkHookManager 扩展:事件名既匹配 `${collection}.${op}`(create/update/delete),也匹配 `${collection}.${signal>`(命名迁移)。
- 各 action 写对应文档段到 `{workspace}/docs/requirements/{id}.md` **文件**(不入 DB)。

## 实现步骤
1. **核实状态机**:读 [requirement-state-machine](../../../src/server/) 拿全状态串(found/discuss/ready/plan/build/verify/closed)与合法迁移;Flow action 只走合法迁移(非法 → 友好错误)。
2. **emitTransition(data-change-hub.ts)**:新增 `emitTransition(collection, signal, id, record?)`——发一个事件名为 `${collection}.${signal}` 的 data-change(coalesce 同现有 emitDataChange)。与现有 op=create/update/delete 路径并存。**不**改现有 emitDataChange 签名。
3. **ProjectWorkHookManager 扩展**:`handleDataChange` 收到事件时,事件名可能是 `requirements.ready` 等(命名迁移)——按 work.hooks[].event 匹配(现已是 `${collection}.${op}` 字符串匹配,命名信号同款字符串,天然兼容;确认 record.projectId 过滤仍生效)。
4. **Flow 迁移 action**(每个 = transitionStatus + 写文档段 + emitTransition):
   - `pick`(Found→Discuss):transitionStatus("discuss") + 写文档 **Summary 段**(文件已存,append/更新 Summary)。发 `picked`。
   - `ready`(Discuss→Ready):transitionStatus("ready")。发 `ready`。
   - `plan`(Ready→Plan):transitionStatus("plan") + 写文档 **Plan 段**。发 `planned`。(worktree 创建留 F3;本阶段 plan 只迁态+写段+发信号。)
   - `startBuild`(Plan→Build):transitionStatus("build")。发 `buildStarted`。
   - `finishBuild`(Build→Verify):transitionStatus("verify") + 写文档 **Coverage 段**。发 `buildFinished`。
5. **文档段写入**:抽一个写段工具(读现有 docs/requirements/{id}.md → 替换/追加对应 `## <Section>` 段 → 写回)。服务端 fs,不入 DB。
6. **capability 注入**:核实哪些 action 需 leadService/pmService(F2 暂不接 verify,需求主要 requirementStore + 写文件 + workspace 解析)。

## 关键文件
`flow-tool.ts` · `data-change-hub.ts`(emitTransition)· `project-work-hook-manager.ts`(命名信号匹配)· `requirement-store.ts`(transitionStatus,既有)

## 不做(留 F3)
- **verify**(复合:delegate PM + merge + 发 verified/rejected)。
- **worktree 创建**(plan 的 worktree,集中化到 ~/.zero-core/projects/...)。
- 默认 work 重配(交付→ready)。
- 替换 CreateRequirement/CreateRequirementWithDoc/verify。

## 风险
- emitTransition 与现有 emitDataChange 共存:确认 hub 的 coalesce/flush 不互相干扰;命名信号事件能被 onDataChange 订阅者收到。
- 文档段写入:并发写同一文件风险(requirement 串行,低);段替换逻辑要稳(找 `## Section` 到下一 `##` 或 EOF)。
- transitionStatus 的 triggeredBy/comment:Flow action 通用,用 ctx.agentId ?? "tool";F3 统一。
- workspace 解析:复用 F1 的 resolveWorkspaceDir(contextBundle.workspaceDir ?? ctx.workingDir)。
