# plan-F3 — 拆 verify + work 重配 + 替换旧工具

> 节点 F3(依赖 F2)。目标:去掉现 verify 工具的 PM 委派/合并复合逻辑;默认 work 模板按新 hook 订阅重配(交付→ready、加 PM 判断 work、加合并 work);用 Flow 替换 CreateRequirement/CreateRequirementWithDoc/verify,RENAMED_TOOLS back-compat;打通返工回路。对应 [project-flow.md](project-flow.md) §4/§5/§8。

## 范围
- 删 [verify-tool.ts](../../../src/runtime/tools/verify-tool.ts) 的 `delegateTask`(PM)+ `submitCoverageVerdict` + `mergeFeatureToMain` 复合逻辑(Build→Verify 已由 Flow.finishBuild 在 F2 接管)。
- 默认 work 模板 [builtin-work-templates.ts](../../../src/server/builtin-work-templates.ts) 重配 hook + 新增 PM 判断 work + 合并 work。
- 替换旧工具:tools/index.ts 移除 CreateRequirement / CreateRequirementWithDoc / verify 注册,Flow 覆盖其能力。
- RENAMED_TOOLS back-compat。
- 返工回路(rejected → 回灌原执行 work)。

## 实现步骤
1. **删 verify 复合逻辑**:verify-tool.ts 的 execute 里 delegateTask(PM)/parseVerdict/submitCoverageVerdict/merge 那一大段删掉(F2 的 finishBuild 已负责 Build→Verify + 发 buildFinished)。verify-tool 文件本身在 F5 删;F3 先废其复合逻辑(或直接移除注册,由 Flow.verify 接管 Verify→Closed/打回)。**决定**:F3 直接把 verify 工具从注册移除,Flow.verify(通过/打回)接管它的状态迁移职责;PM 判断 + 合并改成 work。
2. **默认 work 模板重配**([builtin-work-templates.ts](../../../src/server/builtin-work-templates.ts)):
   - 需求管理(交付)work:hook `requirements.create` → **`requirements.ready`**(用户定型后才 fire 交付)。
   - 新增 **PM 覆盖判断 work**:订阅 **`requirements.buildFinished`**;actionPrompt:读最新 Orchestrate manifest → 产品粒度覆盖判断 → 通过调 Flow.verify(通过)/ 不通过 Flow.verify(打回)。requiredTools 含 Flow。
   - 新增 **archivist 合并 work**:订阅 **`requirements.verified`**;actionPrompt:mergeFeatureToMain + 清 worktree + (Flow 已置 closed,确认)。
3. **替换旧工具注册**:[tools/index.ts](../../../src/runtime/tools/index.ts) 移除 CreateRequirement / CreateRequirementWithDoc / verify;Flow 是唯一需求流转入口。capability 注入(agent-service L422-423)改按 Flow(`on("Flow")`)注入 requirementStore/pmService/leadService/delegateTask。
4. **RENAMED_TOOLS back-compat**([tool-registry.ts](../../../src/core/tool-registry.ts)):`CreateRequirement`/`CreateRequirementWithDoc`/`verify`/`create_requirement*` → `"Flow"`(旧 toolPolicy 引用迁移到 Flow)。
5. **返工回路**:Flow.verify(打回)发 `rejected`;原执行 work(需求管理)需订阅 `rejected`?或经 requirement message + contextPolicy.injectRequirementDetail 把意见注入,work 下次被 fire 时看到。F3 验证:reject 后意见落在 requirement message,交付 work 能读到并重提。
6. **暴露面**:Flow 的 create/plan/finishBuild 默认给 agent;pick/ready/startBuild/verify 默认给用户(UI,F4)。本阶段通过 CONDITIONAL_TOOLS / 工具暴露策略表达(F4 完善 UI)。

## 关键文件
`verify-tool.ts`(废逻辑/移注册)· `builtin-work-templates.ts`(重配 + 新 work)· `tools/index.ts`(移旧注册)· `agent-service.ts`(capability)· `tool-registry.ts`(RENAMED)· `requirement-tools.ts`(F5 删,F3 先不导出旧工具)

## 不做(留其他阶段)
- UI 看板/modal 走 Flow 后端 → F4。
- 删旧文件 + 注释清扫 + code-graph → F5。

## 风险
- **交付管线行为变更**:现 verify 是同步阻塞 delegate 拿 PM 结论返 lead;改后 finishBuild 发 buildFinished → PM work 异步判断 → verify → 合并 work 异步合并。lead 不再同步拿结论;返工是异步回灌。需确认 lead work 的 actionPrompt 配合(收到 rejected 重提)。回归 e2e(若有 delivery 链 e2e)必跑。
- PM 判断 work / 合并 work 是新 seed:既有项目无这俩 work → buildFinished/verified 后无人反应。需对既有 project 补 seed(或 migration 补默认 work)。F3 处理。
- submitCoverageVerdict / mergeFeatureToMain 现由 PM work / 合并 work 调用——确认这两个方法能从 work 的 ctx 访问到(pmService/archivist 注入到这些 work 的 session)。
