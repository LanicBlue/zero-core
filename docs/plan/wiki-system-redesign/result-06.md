# Result 06：数据 API 与 Wiki Browser UI

对应 [Acceptance 06](acceptance-06-data-api-browser-ui.md) / [Plan 06](plan-06-data-api-browser-ui.md)。

- **实施 commit**:`9947b96`(branch `worktree-wiki-redesign`)— feat(wiki-system-redesign): sub-06 数据 API + Browser UI
- **验收**:2 轮 3-lens adversarial。round-1 FAIL(D7 History scope-narrowing blocker + C2/E2/A2/C1 minors);round-2 全 PASS、0 blocker、0 回归,sub-06 共 145 unit 测试绿(spec 25 / arch 60 / adversarial 53 + p9 迁移 7)。
- **结论**:✅ Acceptance 06 通过(round-2 三方向独立确认 + orchestrator 独立重跑 145 测试全绿),可进入 Plan 07。

---

## 1. 七节实施(plan-06 全 scope)

1. **REST API**(`wiki-router.ts` 全量重写):9 个结构化 POST endpoint(`/expand /read /search /create /update /delete /link /unlink /move`)+ round-2 第 10 个 `/history`(§D7)。路径全在 body,**无 `:nodeId`**。UI authority 由 server 模块级常量 `WIKI_UI_ADMIN_ACCESS`(`@ui-browser`,wiki-root,9 全 action)注入,`buildUiCtx` 每次新建 ctx;**renderer 无法从 body 扩权**。`FORBIDDEN_BODY_KEYS`(round-2 扩到 16,含 `projectId/activeProjectId/actor/channel/effectiveAccess/targetId/sourceId`)在 zod 前扫描,拒伪造身份。REST adapter 全走 `getWikiService/getWikiSearchService` 单例(与 Agent Wiki v2 tool **同源**,不复制业务逻辑)。mutation 后 `emitDataChange` wiki_nodes/wiki_links/wiki_sync。
2. **IPC/preload**:删 11 个旧 wiki channel,加 `wikiV2:*` 10 个(expand/read/search/create/update/delete/link/unlink/move/readWorkspaceDoc + round-2 history),全 `WikiRestResult<T>` envelope,与 router request/result **同源**(A4 编译期断言)。
3. **Zustand store**(`wiki-store.ts` 重写):canonical path 唯一公开 key(**无 DB ID/短 ID**)。分离缓存 childrenByPath/detailByPath/relationsByPath/sourceByPath/historyByPath/summaryByPath。children 分页 cursor(`DEFAULT_PAGE_SIZE=50`)。search 保存完整 `lastSearchParams`(mode/target/case/fields/kinds/limit)。`showArchived` 默认 false。6 种 `WikiViewScope`(global/knowledge/memory/agent-memory/project/address)。round-2 `loadHistory` 接通 `wikiV2History`。`_applyNodeEvent` 增量失效 + round-2 `wasParentLoaded` 快照修 re-fetch 死代码。
4. **Wiki tree/browser**(`WikiPage`/`WikiTree` 重写):6 scope 切换 + breadcrumb(首选 address)+ kind 图标 + archived 灰显/默认隐藏 + loading/empty/error + `Load more` 分页(1,000 child 不无界)。
5. **搜索 UI**:SearchBar target/mode/case/fields/kinds/limit **全实传后端**;结果显示 canonical path / **matched field**(round-2 C2 兑现)/ matchType / snippet / revision / source-wiki 区分;regex invalid/timeout 具体错误**不退化 substring**;`Both` 合并保留 provenance(source hit 琥珀边框);选中 hit `expandAncestors` 懒展开。
6. **Node detail 5 tabs**(`WikiDetail` 重写):Overview/Content/Relations/Source/History。Content 用 `react-markdown + remark-gfm`,**不配 `rehype-raw`**(v10 默认 escape,XSS-safe)。编辑发 `expected_revision`,WRITE_CONFLICT 保留 draft + 提示 server revision(不静默覆盖)。Relations incoming/outgoing + link/unlink 局部刷新。Source binding + source-bound 结构按钮禁用解释 Git ownership + 沙箱读。**History(round-2 D7 兑现)**:4 状态 + 4 列表(Action/Actor/Revision/Audit time),`POST /history` → `WikiAuditView[]` → store → HistoryTab。
7. **数据变更推送**(`data-change-hub.ts`):`UI_COLLECTIONS` 加 wiki_nodes/wiki_links/wiki_sync(id=canonical path,record 含 path/op/revision/oldPath?/parentPath?)。wiki-store 订阅这三个,**删 project_wiki 订阅**。

## 2. round-1 blocker + round-2 修法

**D7 是 round-1 唯一 blocker**:implementer 把"节点自身 audit 历史"(data-plane 只读详情)误判为"plan-07 management 动作",History tab 交付为占位 stub。三 lens + synthesis 一致钉死属 plan-06 §6 scope(4 条独立依据:plan §6 行 121 "History:audit log";§3/§7 history cache;acceptance §D7 无条件行为条款;design §3.1 管理面不含 audit)。底层 `WikiAuditRepository.listByNodePath` + `WikiAuditView` 已备齐,round-2 **五处接线**:`listHistory`(`wiki-service.ts`,委托 `auditRepo.listByNodePath`,read 授权,**不写 audit**——meta-query 不自污染)→ `POST /history`(router,只读不 emit data:changed)→ `wikiV2History`(4 IPC 文件,类型同源)→ `store.loadHistory`(callV2 映射 `actorAgentId`)→ `HistoryTab`(4 列表渲染,删 plan-07 placeholder)。

| Minor | round-1 病灶 | round-2 修法 | 测试 |
|---|---|---|---|
| C2 | matchedField 存 store 不渲染(WikiPage 只渲染 matchType) | wiki 卡 + source 卡加 `{h.matchedField}` span | spec C.2 + adversarial DOM 断言 |
| E2 | `_applyNodeEvent` re-fetch 死代码(set 内 delete 后 set 外读恒 undefined → expandPath 永不执行) | set 前 `wasParentLoaded` 快照,set 后用它决定 re-fetch;无循环(expandPath 纯读) | arch + adversarial(含 no fetch storm + 双父刷新) |
| A2 | `FORBIDDEN_BODY_KEYS` 缺同义词(projectId/actor/...) | +7 同义词与 comment 对齐 | spec A.2 扩到 16 forged bodies |
| C1 | scope 控件对用户不可见 | 设计注释(UI-admin grant=wiki-root,scope 恒 null 是设计) | doc-only |

## 3. 验证命令(§F)

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0(三 tsconfig) |
| `npm run build:lib` | exit 0 |
| `npm run build:codegraph` | exit 0(183 文件) |
| vitest wiki-v2-sub06-{spec,arch,adversarial} + p9 | 25 + 60 + 53 + 7 = **145 全绿,0 fail** |

acceptance §F 的 `test:e2e` / `npm run build` / `check:links` 由最终门禁 acceptance-final 跑;per-sub 验收以 unit + typecheck + build:lib 为准(与 sub-04/05 一致)。

## 4. 修改文件

impl:13 改(`ipc-proxy`/`preload/index`/`AgentEditor`/`WikiTreePanel`/`WikiDetail`/`WikiPage`/`WikiTree`/`wiki-store`/`data-change-hub`/`index`/`wiki-router`/`wiki-service`/`ipc-api`/`preload-types`)+ 2 删(`WikiAnchorsSection.tsx` / `wiki-anchor-injection.ts`)+ `code-graph.*` regen。测试:1 迁移(`p9-wiki-router-sandbox`)+ 3 新(`wiki-v2-sub06-{spec,adversarial,arch}`)。

## 拒绝条件(§H)

- renderer 不收/不缓存内部 DB ID ✓
- UI 不能传 `global=true/admin=true` 自授权 ✓(server 注入 authority)
- Markdown raw HTML 不执行脚本 ✓(无 rehype-raw,v10 默认 escape)
- 搜索控件与后端参数不脱节 ✓(全实传)
- 不一次拉整棵 Wiki 树 ✓(分页 50/页)

## 验收记录(2 轮)

- **round-1**(3 lens):**FAIL** —— D7 History scope-narrowing(implementer 误判 plan-07)+ C2/E2/A2/C1 minor。2 false positive 拒(p9 已迁移 7/7;spec C2 误判 matchType 当 matched field,降级为真 minor)。
- **round-2**(3 lens + 综合):**PASS** —— 5 fix 全落地(D7 五处接线 + C2/E2/A2/C1),**0 回归**(round-1 PASS 契约全 sweep:B4 idempotency / D2 XSS / E3 no-fetch / A5 同源 service / A6 legacy=0 完整),**0 新 blocker**(/history 只读、listHistory 不写 audit、无 re-fetch 循环、path-traversal 被 normalizeWikiPath + exact-equality 守住)。145 测试绿。

## defer concerns(留 sub-07/08,非阻断)

- **PromptTemplate.wikiGrants 字段化**(取舍1):Agent grants 编辑器 UI = sub-07。`AgentEditor` 的 `form.wikiAnchors`/`wikiGrants` 字段保留 round-trip,plan-07 取代、plan-08 删字段。
- **`/api/project-wiki/*` 生产挂载 + `ProjectWikiStore`**(plan-06 §2 明确):renderer 调用已归零;route 注册删除留 plan-08。
- **`CallerCtx.wikiAnchorNodeIds` / `AgentRecord.wikiAnchors` 字段**:runtime 已不读(sub-05),字段留 plan-08 删。
- **`test:e2e` / `npm run build` / `check:links`**(acceptance §F):per-sub 不跑,留 acceptance-final 最终门禁。
- **sub-04/05 既有 defer**(B6 首 turn race / onChange StepEnd 边界 / §C.4 深度 profile / 搜索 matchTypes>200 / cursor>200 等):仍留 sub-08。

## 给 sub-07 的 handoff

- sub-07(Management UI):Agent grants / address / project binding 编辑器 UI;realize defer `PromptTemplate.wikiGrants` 字段化 + `wikiAnchors` 字段删 + Agent grants/context editor + 管理面 audit-query(跨节点/actor/time,区别于 sub-06 的 per-node `/history`)。
- **数据面已就绪并验证**:REST 10 endpoint + canonical-path store + 5-tab Detail + 搜索 + 增量同步 + /history。
- sub-07 管理面 authority 复用 `WIKI_UI_ADMIN_ACCESS` 形状(wiki-router.ts 注释已标注 plan-07 可复用 effectiveAccess);管理面 mutation endpoint 建议**同样走 FORBIDDEN_BODY_KEYS + buildUiCtx + 同一 service 单例**模式。
