# Result 07：管理 API 与配置 UI

对应 [Acceptance 07](acceptance-07-management-ui.md) / [Plan 07](plan-07-management-ui.md)。

- **实施 commit**:`8119b5b`(branch `worktree-wiki-redesign`)— feat(wiki-system-redesign): sub-07 管理 API 与配置 UI
- **验收**:2 轮 3-lens adversarial。round-1 FAIL(FORBIDDEN_BODY_KEYS blocker 误杀管理面 payload + 3 minor);round-2 全 PASS、0 回归、0 新 blocker。sub-07 共 134 unit 测试绿(spec 25 / adversarial 48 / arch 61),sub-06 回归 145/145 + p9 7/7 仍绿。
- **结论**:✅ Acceptance 07 通过(round-2 三方向独立确认 + orchestrator 独立重跑 279 测试全绿),可进入 Plan 08。

---

## 1. 七节实施(plan-07 全 scope)

1. **管理 API**(`src/server/wiki-admin-router.ts` 新建 1230+ 行 + `src/shared/wiki-admin-types.ts`):独立 `/api/wiki-admin` router,**20 个 POST endpoint**——addresses(list/validate/impact/create/update/delete 6)+ repositories(list/validate/status/bind/update/unbind/reindex 7)+ grants(validate/preview/publish 3)+ context(validate/preview/publish 3)+ sessions(status 1)。authority 由 server 模块常量 `WIKI_ADMIN_AUTHORITY={actor:@wiki-admin,canManage:true}` 注入;`FORBIDDEN_BODY_KEYS` 拒真身份键(round-2 修正:管理面不含 grants/projectId/activeProjectId payload 字段,加 canManage);agentId 走 query。revision 复用 `AgentRecord.wikiPolicyRevision`。所有 mutation 写管理审计 + revision。
2. **逻辑地址管理**:wrap `WikiAddressService.register/update/delete/validate/resolve`;impact 扫 `agentStore.list()` 的 wikiGrants/wikiContext + `getAgentWikiSessionStatus()`。**无 target_id 泄露**——`addressRowToView` 把 target_id→node.path 实时解析。validate/impact 无副作用。
3. **Agent Editor:Wiki Access**(新 `WikiAccessSection.tsx`):删旧 WikiAnchorsSection UI + form wiring(agent-editor-types agentToForm 强制 wikiAnchors:[]);每条 grant 编辑(canonical scope/address/template + action chips + 编译预览 + valid/inactive/error)。保护:wiki-root 全树写**二次确认**(round-2 Fix 3:service 边界也强制,canonical 化检测抗 wiki-root/ 等价绕过);overlapping 显 **action union**(summarizeGrants);project:// 无项目 inactive;**删最后一条 grant→[]**(updateWikiGrants 长度判断 + service [] 兜底)。**publish 后真实 Agent tool 权限与 preview 一致**(C8,preview==runtime 同 compileWikiAccess)。
4. **Agent Editor:Wiki Context**(新 `WikiContextSection.tsx`):preview 调真实 `compileWikiContext`(preview==runtime);**publish 前 server 再检 unauthorized**(防 UI 绕过);address 无 read grant→unauthorizedAddresses,**阻止 publish 且不自动新增 grant**(D3)。
5. **Project Wiki 管理**(新 `WikiProjectCard.tsx` + ProjectPage 嵌入):卡片显示 Wiki project root / repo binding / workspaceDir(ProjectStore,**只读,不入 Wiki DB**)/ source_root+default branch / indexed revision+HEAD / status / last indexed time+error / Validate+Full reindex+Open Wiki。wrap `WikiProjectIndexer.{ensureBinding,sync,rebuildFromScratch}`;reindex emit 进度;unbind 默认 soft(不硬删);Open Wiki 定位 canonical root。
6. **Session publish 行为**(`AgentService.publishAgentWikiPolicy` 新增 + `getAgentWikiSessionStatus`):expectedRevision **CAS**(不一致→WRITE_CONFLICT+currentRevision)→ patch wikiPolicyRevision+1 + grants/context 字段([] 兜底)→ `agentStore.update` 触发 `setAgentStore.onChange` 热同步(busy enqueueConfigPatch StepEnd flush / idle 重建)→ 返 affectedSessions applied/pending。**不改变正在执行中的 tool call snapshot**(CallerCtx 每 call 快照)。
7. **Preload 与状态**:管理 API 类型独立(`wiki-admin-types.ts` vs `wiki-types.ts`);renderer 不接触 target_id/project_node_id;`wiki_admin`/`wiki_repositories` 独立 change event(不误刷 wiki_nodes data tree)。

**兑现 defer**:`PromptTemplate.wikiGrants` 字段化(types.ts PromptTemplate 加 wikiGrants?/wikiContext? + template-store COLUMNS + db-migration safeAddColumn + round-2 Fix 4 db-migration *_COLUMNS 同步 + archivist seed 带 wikiGrants + management-service.instantiateTemplate + agent-editor-types.templateToForm 拷贝)。

## 2. round-1 blocker + round-2 修法

**round-1 唯一 blocker(三 lens 一致)**:管理面 `FORBIDDEN_BODY_KEYS` 从数据面 copy-paste,含 `grants`/`projectId`/`activeProjectId`——在数据面它们是 caller 身份(正确禁止),**但在管理面是 payload 内容**(GrantsPublishInput 顶层要 grants;所有 repository schema 顶层要 projectId)。`parseBody` 在 zod 前先跑 forged-identity guard → 每个 `/grants/*` 和 `/repositories/*` 返 400 → C1-C8 / E1-E4 / A4 grants-CAS / A5 grants-audit / H delete-last-grant-via-REST 全死。底层 `AgentService.publishAgentWikiPolicy` direct-drive 验证**正确**,只 REST 层坏。

| Fix | round-1 病灶 | round-2 修法 | 测试 |
|---|---|---|---|
| **Fix 1 (BLOCKER)** | FORBIDDEN_BODY_KEYS 误杀 grants/projectId/activeProjectId payload | 管理面移除这 3 个 payload 字段,保留真身份键;数据面 wiki-router.ts **一字不改**(隔离) | spec Fix1 + adv isolation + arch 5 隔离测试 |
| Fix 2 | canManage 漏网(WikiAdminAuthority 一等字段) | 加 canManage 进管理面 FORBIDDEN_BODY_KEYS | adv A1-round2 |
| Fix 3 | confirmRootWriteGrant 只在 router,service 边界不强制 | publishAgentWikiPolicy 加 confirmRootWriteGrant? 参数,service 内 compileWikiAccess canonical 化检测 wiki-root+写 action,未确认→INVALID_REQUEST;router 透传 | arch 4 service 测试 + adv direct(canonical wiki-root/ 等价)|
| Fix 4 | db-migration templates *_COLUMNS 缺 wiki_grants/wiki_context(靠 self-heal) | 加进 *_COLUMNS 数组,fresh-DB CREATE TABLE 直接含(feedback-fresh-db-migrations)| spec Fix4 + arch COLUMNS literal |

## 3. 验证命令(§F)

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0(三 tsconfig) |
| `npm run build:lib` | exit 0 |
| `npm run build:codegraph` | exit 0(185 文件) |
| vitest wiki-v2-sub07-{spec,adversarial,arch} | 25 + 48 + 61 = **134 全绿** |
| 回归 wiki-v2-sub06-{spec,adversarial,arch} + p9 | 25 + 53 + 60 + 7 = **145 全绿,0 回归** |

acceptance §F 的 `test:e2e` / `npm run build` / `check:links` 由 acceptance-final 跑(与 sub-04/05/06 一致)。

## 4. 修改文件

**新建(5)**:`src/shared/wiki-admin-types.ts`、`src/server/wiki-admin-router.ts`、`src/renderer/components/agents/WikiAccessSection.tsx`、`src/renderer/components/agents/WikiContextSection.tsx`、`src/renderer/components/requirements/WikiProjectCard.tsx`。**修改(13)**:shared/types、preload-types、preload/index、ipc-proxy、server/index、data-change-hub、db-migration、template-store、management-service、agent-service、agent-editor-types、AgentEditor、ProjectPage + `code-graph.*` regen。测试:3 新(`wiki-v2-sub07-{spec,adversarial,arch}`)。

## 拒绝条件(§H)

- context checkbox 不同时授 read/write ✓(D3,publish 前 server 再检)
- renderer 不能设 admin/actor ✓(FORBIDDEN_BODY_KEYS + server 注入 authority)
- 删最后 grant 不因 undefined 未生效 ✓(C3,显式 [] + WikiAuthorizationService.authorize 真撤销)
- 地址注册不在 Agent Wiki tool ✓(A2,WIKI_V2_ACTIONS = 9 数据面 action)
- repo 绝对路径不入 Wiki DB ✓(E1,只 projectId + 相对 source_root)

## 验收记录(2 轮)

- **round-1**(3 lens):**FAIL** —— FORBIDDEN_BODY_KEYS 误杀管理面 payload(单根因 blocker,~20 criteria 死)+ canManage 漏网 + confirmRootWriteGrant service 边界 + db-migration COLUMNS。底层 service direct-drive 验证正确。E7/audit-query defer 三 lens 同意(plan-08)。0 回归(sub-06 145/145)。
- **round-2**(3 lens + 综合):**PASS** —— Fix 1-4 全落地,**now-unblocked criteria 经 HTTP 端到端验证真活**(C2 round-trip / C3 []+真撤销 / C4 wiki-root 二次确认 router+service / C5 union / C7 cancel-no-save / C8 publish==preview / A4 grants CAS / A5 grants audit / E1 workspaceDir 不入 DB / E4 unbind soft)。**downstream 真消费**(C3/C8 在 WikiAuthorizationService.authorize gate 断言,非 direct-drive only——feedback-verify-runtime-wiring)。stale blocker-doc 测试改写为正确行为断言。134 测试绿 + 0 回归。

## defer concerns(留 plan-08,三 lens round-1/round-2 一致同意,非 plan-07 scope)

- **E7 Cron/Work editor UI disable**:runtime 结构上已安全(wikiGrants 只在 Agent/PromptTemplate 类型,不在 Cron/Work record;compileWikiAccess 忽略走私的 cron 字段)。Cron editor UI disable 控件是 plan-08 UX 打磨。
- **跨节点/actor/time 管理面 audit query endpoint**:plan-07 §1 admin API 资源无 audit-query(只 addresses/repos/grants/context/sessions);A5 是写 audit(已满足)。**无 sub-09**,归 plan-08。(publish 已写 policy.publish.grants/context + address.* + repository.* audit,数据备齐,query endpoint 留 plan-08。)
- **scopeDeltaHint 真实计算(B5)**:plan-07 §2 scope expand/contract 是 hint-only,当前 'unknown' stub,留 plan-08。
- **§6 publish 路径 applyConfigUpdate vs enqueueConfigPatch 一致性**:wiring 已活,in-flight tool snapshot 安全,但 busy loop 用 applyConfigUpdate 而非 enqueueConfigPatch → affectedSessions.applied 恒 true + 注释误导。留 plan-08 cutover 评估。
- **activeProjectId 在 AgentEditor**:WikiAccessSection 的 project:// inactive 提示只在有 active project hint 时显示;runtime session build 按真实 activeProjectId 编译不受影响(Fix 1 后 activeProjectId 不再被管理面 guard 误杀)。

既有 defer(sub-08):/api/project-wiki 生产挂载 + ProjectWikiStore 删 / wikiAnchorNodeIds+wikiAnchors 字段物理删 / B6 首 turn race / onChange StepEnd 边界 / §C.4 深度 profile / sub-04 搜索 defer 链 / test:e2e+build+check:links(acceptance-final)。

## 给 sub-08 的 handoff

- sub-08(Cutover/Hardening):所有 defer 落地点 + 旧实现清退。重点:**跨节点 audit-query endpoint**(数据已写,补 query)+ **E7 Cron editor UI disable** + **scopeDeltaHint** + **§6 publish StepEnd 一致性** + **B6 首 turn race** + **/api/project-wiki 生产挂载删除 + ProjectWikiStore 清退** + **wikiAnchorNodeIds/wikiAnchors 字段物理删** + **sub-04 搜索 defer 链**。
- **管理面已就绪并验证**:20 admin endpoint + WikiAccessSection/WikiContextSection(替换 WikiAnchorsSection)+ WikiProjectCard + publish CAS + session 热同步 + wiki_admin/wiki_repositories event。
- 管理 authority 复用 `WIKI_ADMIN_AUTHORITY` 模式;sub-08 清旧实现时注意**数据面/管理面 FORBIDDEN_BODY_KEYS 故意分叉**(wiki-router.ts vs wiki-admin-router.ts),不要同步。
