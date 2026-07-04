# plan-F3 — verify 接入(复合)+ worktree 集中化 + 交付 work hook + 替换旧工具

> 节点 F3(依赖 F2)。目标:Flow 加 **`verify`(复合,沿用现 verify 语义)+ `plan` 补 worktree 创建**;worktree 集中化到 `~/.zero-core/projects/{project}/{req-shortId}/`;交付 work hook 改 `create`→`ready`;替换 3 旧工具(CreateRequirement/CreateRequirementWithDoc/verify)→ Flow + RENAMED_TOOLS back-compat;返工回路。对应 [project-flow.md](project-flow.md) §2/§5/§9。

## 范围(按简化设计 —— 不拆 verify、不加 PM/合并 work)
1. **`verify`(复合 Flow action)**:把现 `verify-tool.ts` 的逻辑(delegate PM 判覆盖 + submitCoverageVerdict + APPROVED→mergeFeatureToMain+closed / REJECTED→意见回灌)搬进 Flow.verify。Flow.verify 通过发 `verified`/`rejected`,写 Decision Log 段。可由用户或 agent 调用(配置暴露,不绑角色)。
2. **`plan` 补 worktree**:F2 的 plan 只迁态+写 Plan 段;F3 加 worktree 创建(复用 LeadService.pickupRequirement 的 worktree 部分),位置集中化。
3. **worktree 集中化**:LeadService / GitIntegration 的 worktree 路径 `{workspace}.worktrees/req-{shortId}/` → `~/.zero-core/projects/{project}/{req-shortId}/`。
4. **交付 work hook 改 ready**:[builtin-work-templates.ts](../../../src/server/builtin-work-templates.ts) 需求管理 work hook `requirements.create` → `requirements.ready`;actionPrompt 按新流程重写(finishBuild 提交、verify 复合判断)。
5. **替换旧工具**:[tools/index.ts](../../../src/runtime/tools/index.ts) 移除 CreateRequirement / CreateRequirementWithDoc / verify 注册;Flow 唯一入口。
6. **RENAMED_TOOLS back-compat**:[tool-registry.ts](../../../src/core/tool-registry.ts) `CreateRequirement`/`CreateRequirementWithDoc`/`verify`/`create_requirement*` → `"Flow"`。
7. **capability 注入**:agent-service 按新工具集收口(verify 复合需 delegateTask + pmService;Flow 注入条件更新)。
8. **返工回路**:verify 打回 → 写 Decision Log + 发 rejected;需求状态退回(状态机 verify→? 的合法目标,如 build/discuss);交付 work 经 ready(或下次 fire)读到意见重走。

## 实现步骤
1. **核实**:requirement-state-machine 的 verify→? 合法目标(返工退到哪);LeadService.pickupRequirement 的 worktree 创建逻辑;verify-tool.ts 的 delegate/merge 完整逻辑;submitCoverageVerdict / mergeFeatureToMain 签名。
2. **Flow.verify(复合)**:在 flow-tool.ts 加 verify action —— 复用 verify-tool 的 execute 逻辑(set verify 态→delegateTask PM→parseVerdict→submitCoverageVerdict→APPROVED merge+closed 发 verified / REJECTED 回灌发 rejected);写 Decision Log 段。注意:verify-tool 内部 set verify 态那段与 finishBuild(已→verify)重复,Flow.verify 接手时需求已在 verify 态,只需做 delegate+merge+决策。
3. **plan worktree**:flow-tool plan action 加 worktree 创建(调 LeadService.pickupRequirement 或抽公共方法,避免逻辑分叉);workspace 切到 worktree(注入 lead 上下文)。
4. **worktree 路径**:改 LeadService/GitIntegration 的 worktree 根到 `~/.zero-core/projects/{project}/{req-shortId}/`(确认 OS homedir 拼接、清理逻辑)。
5. **交付 work 模板**:builtin-work-templates 需求管理 work:hook→ready;actionPrompt 重写为新流程(ready fire → plan 建 worktree → Orchestrate 实现 → finishBuild 提交 → verify 复合判断)。
6. **替换 + RENAMED_TOOLS**:tools/index.ts 移除旧三工具注册 + CONDITIONAL;tool-registry RENAMED_TOOLS 加映射;agent-service capability 注入收口(去掉 on("CreateRequirement") 等,改 on("Flow"))。
7. **返工**:确认 verify→返工 的状态机目标;rejected 信号 + Decision Log 意见;交付 work 重提路径。
8. **测试**:tests/unit/f3-flow-verify.test.ts(verify 复合:approve→merge+closed+verified;reject→意见+rejected;返工回路)+ worktree 路径断言 + 交付 work hook=ready + 旧工具已替 + RENAMED_TOOLS back-compat。

## 关键文件
`flow-tool.ts`(verify 复合 + plan worktree)· `lead-service.ts`/`git-integration.ts`(worktree 路径)· `builtin-work-templates.ts`(hook ready + prompt)· `tools/index.ts`(移旧注册)· `tool-registry.ts`(RENAMED)· `agent-service.ts`(capability)· `verify-tool.ts`(F5 删,F3 先废其注册)

## 不做(留 F4/F5)
- UI 看板/modal 接入(F4)。
- 删旧文件 + 注释清扫 + code-graph(F5)。

## 风险
- **交付管线行为变更**:verify 从"同步阻塞 delegate 拿结论"→ Flow.verify 复合(仍 delegate,但作为 action 被用户/agent 显式调)。确认 delegate 阻塞语义在 Flow action 内仍成立(execute 内 await delegateTask)。
- **worktree 集中化路径**:既有进行中的 worktree(旧路径)需兼容/清理;OS 路径拼接(homedir)。
- **既有项目交付 work hook 仍是 create**:需 migration 改,或 hook manager 过渡期双认(本阶段至少新项目用 ready;既有项目迁移 F4 处理)。
- **返工状态机目标**:核实 verify→? 合法;若退回 build,交付 work 怎么续(它在 worktree 里;rejected 意见怎么到它——Decision Log 文件 + 注入路径)。
- **capability 注入**:verify 复合需 delegateTask + pmService + requirementStore;Flow 注入条件要覆盖这些。
