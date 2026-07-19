# Result 04：Wiki Tool & Search

对应 [Acceptance 04](acceptance-04-wiki-tool-search.md) / [Plan 04](plan-04-wiki-tool-search.md)。

- **实施 commit**:`5bb5c81`(branch `worktree-wiki-redesign`)— feat(wiki-system-redesign): sub-04 Wiki Tool & Search(16 文件,+9741/-1238)
- **验收**:6 轮 3-lens adversarial(规约/对抗/架构 每轮独立),round-6 全 PASS、零 blocker。**用户 2026-07-17 节点语义决策**落地。
- **结论**:✅ Acceptance 04 通过(round-6 三方向独立确认),可进入 Plan 05。(acceptance-final 跨 sub 最终验收待 sub-08 后跑)

---

## 1. 9-action Wiki tool(§A/B)

`createWikiTool(deps)` 工厂,9 action `z.enum`(expand/read/search/create/update/delete/link/unlink/move),顶层 `z.object`,**不**含 agentId/projectId/grants/canonicalScope/cwd/nodeId/短 ID/旧 title path/旧 doc action/管理面 action。`expected_revision` 在 buildUpdateRequest 运行时强制(plan-04 §6)。**工厂未注册**(plan-05 接 Agent tool registry);当前仅导出。地址字段 node/parent/source/target/newParent 接受 `memory://` `project://` `runtime://` + canonical path,透传 service 解析(plan-04 §1 / design §8.2)。`CallerCtx.wikiAccess?: CompiledWikiAccess` 唯一身份源,缺失→ACCESS_DENIED 不退回 wikiAnchorNodeIds(plan-04 §2)。

## 2. 6 search modes + 节点语义 truncated(§C/D)

exact / substring / glob / fulltext(FTS5 external-content)/ regex(`node:worker_threads`,可终止)/ hybrid。`truncated = distinct 匹配节点 > cap`(**节点语义**,用户 2026-07-17 决策):

- **hybrid dedup key = canonical path**(一节点一 hit;旧 `path|matchType|matchedField` tuple 已弃)。
- **matchType 聚合证据**:`WikiSearchHit.matchTypes?: WikiSearchMatchType[]`(length≥2 才填;primary `matchType` = best-rank via `compareHybridHits`,与最终 sorted 同 oracle)。
- **rawCount = `max(dedup.size, exactOut/substringOut/fulltextOut.rawCount)`**;dedup.size 现为节点数(path-keyed)。**可证**:`max>200 ⟺ 真 distinct 节点>200`(dedup.size 无组件 slice 时=真并集、组件 rawCount 单组件 slice 时兜底;两者均 ≤ 真节点数故无 false-positive,任一>200 ⟺ 真>200 故无 false-negative,无第三盲点)。
- **组件 rawCounts 全为节点数**:exact/substring=`rows.length`、glob=`verified.length`、fulltext=Σ`COUNT(*)`(FTS5 external-content `content_rowid=id` 一文档一节点)、regex=worker `rawMatchCount`(无 `g` flag,每节点≤1)。
- 边界(acceptance-04 §D round-6):199/200 distinct 全返回→`false`;201/250→`true`;单节点多 matchType→wikiHits 仅 1 条该节点(hit.matchTypes 聚合≥3);跨页 path 0 重复。

## 3. round-1 5 blocker 加固 + C1 kinds(§A-G)

- **FIX1 id 泄露**:`wiki-node-repository.update` 抛 `wikiError(NOT_FOUND|WRITE_CONFLICT)` path 化 message(无内部整数 id);tool 层 `stripInternalIds` + duck-typed `WIKI_ERROR_CODE_SET` 三层兜底(acceptance-02 §G)。
- **FIX2 scope 段感知**:3 处(queryNodesInScopes / searchFulltext / searchRegex 候选)`(path = ? OR path LIKE ? || '/%' COLLATE BINARY ESCAPE '\\')` + JS `isSameOrDescendant` 二次校验,排除 `-`/`.`/`~`/unicode/数字/大小写同级泄露。
- **FIX3 searchExact**:`name = ? ${caseCollation}`(COLLATE NOCASE 作后缀,非 infix)。
- **FIX4 substring/glob**:`LIKE ? COLLATE BINARY ${escape}` + JS `caseSensitiveSubstringMatch`/`compileGlobMatcher` 后滤。**关键发现**:SQLite LIKE 即便写 `COLLATE BINARY` 也**不**切换大小写(仅 `PRAGMA case_sensitive_like` 或 GLOB 真切换),故 caseSensitive=true 额外加 JS 后滤(代码诚实注释)。
- **FIX5 regex worker**:parent setTimeout 触发→`worker.terminate()` + reject 所有 pending 为 `REGEX_TIMEOUT` + 下次重建;worker 用 `rawMatchCount++` 计数(不再 early break)。
- **C1 kinds**(plan-04:104 契约字段):`kindsClauseAndParams` → SQL `AND kind IN (?,...)` 下沉 queryNodesInScopes / fulltext SELECT+COUNT / regex 候选 / hybrid 透传;空/undefined=不过滤;`z.enum` schema 在 parse 层拒未知 kind。

## 4. 验证命令(§E)

| 命令 | 结果 |
|---|---|
| typecheck / build:lib | exit 0 |
| test:unit | wiki-v2 子系统(sub-01/02/03/04)全绿;sub-04 wiki-v2 5 文件 191/191(search 101 含 round-5 canary 翻转 + round-6 7 边界);全量 ~860 PASS / 0 regression;仅 3 预存非 wiki fail(sub5-dead-code-removed / deferred-dangling-tasklink / po-sub2-provider-usage)+ Windows vitest exit-127 teardown 崩(分批绕开) |

## 5. 修改文件(§F)

commit `5bb5c81`:16 文件,+9741/-1238。
- **新增**:`src/server/wiki/wiki-search-service.ts`、`src/shared/wiki-search-types.ts`、`src/tools/wiki-v2-tool.ts`、5 个 `tests/unit/wiki-v2-{search,regex-limits,tool-contract,tool-format,tool-auth}.test.ts`、`docs/archive/wiki-system-redesign/caller-inventory.md`
- **改**:`src/server/wiki/wiki-node-repository.ts`(FIX1)、`src/server/wiki-operations.ts`(9-action prompt vocab,plan-04 §7)、`src/tools/types.ts`(CallerCtx.wikiAccess)、`plan-04` §5 + `acceptance-04` §D(节点语义契约 + 199/200/201 + 单节点多 matchType 边界)、`docs/visualization/code-graph.*`(regen)

## 拒绝条件(§G)

无内部整数 id 泄露 ✓;scope 段匹配不漏同级(`-`/`.`/`~`/unicode)✓;truncated 节点语义可证正确(无 false-pos/neg)✓;组件 rawCounts 均节点数非 tuple ✓;一节点一 hit(path-keyed dedup)✓。

## 验收记录(6 轮 implement↔verify 循环)

- **round-1**(3 lens):FAIL —— 5 blocker(① id 泄露+伪装 INTERNAL_ERROR / ② scope 漏同级 / ③ exact `name = COLLATE NOCASE ?` 错 / ④ substring/glob `LIKE ? BINARY` 错 / ⑤ regex worker 超时不 terminate)。3 lens tri-确认;implementer 自测漏。
- **round-2**(3 lens):5 blocker 全确认 FIXED,但新增 **B1**(truncated 恒 false)+ **C1**(kinds 不实现)。
- **round-3**(3 lens):B1 5 mode(exact/substring/glob/fulltext/regex)+ C1 kinds 修对,但 **B1-HYBRID** 残留(hybrid rawCount=dedup.size 建 tuple,单组件>200 under-count)。
- **round-4**(3 lens):hybrid 改 `max(组件)` 关单组件盲点,却开**多 matchType 聚合**盲点(B1-HYBRID-RESIDUAL:150 节点×2 matchType=300 tuple,组件 max=150→假阴性)。对抗 PASS 被推翻(探错轴:节点集 vs tuple)。
- **round-5**(3 lens):hybrid 改 `max(dedup.size,组件)` union 修对 tuple 计数,但暴露 **plan 未定义的语义歧义**(200 节点全进 page→truncated=true 违 Agent UX;tuple vs node 不可调和)。
- **用户决策 2026-07-17**:**节点语义**(truncated=distinct 节点>cap;一节点一 hit;matchType 作聚合证据;组件按节点;翻页拿新节点)。
- **round-6**(3 lens + 综合):**PASS** —— 节点语义 5 点契约全落地(dedup path-keyed + matchTypes 聚合 + rawCount 节点计数 + 组件验证 + plan/acceptance 文档),0 blocker,~860 测试绿。

## defer concerns(留 sub-08/plan-05,非阻断,已三方向共识)

- **C(plan-05,重点)**:`matchTypes` 字段 tool 层零消费 —— `formatSearchResult`(wiki-v2-tool.ts:744)只渲染 primary `${matchType}/${matchedField}`,从不渲染聚合 matchTypes 数组。WikiSearchHit.matchTypes 的 doc 称「供 Agent 在单条 hit 上看到该节点被哪些模式命中」未兑现(feedback-verify-runtime-wiring 反模式)。**plan-05 注册 wiki tool 时务必同步把 matchTypes 加进 formatSearchResult(1 行),否则 round-6 Agent-facing 价值为零**。
- **(a)** matchTypes 在 >200 截断场景不全(组件各自独立 slice 到 200,union 后边缘节点只剩单一 matchType;≤200 完整)。sub-08 若要完整,组件改「先 union 再 slice」。
- **(b)** cursor 翻页不能 fetch 超过 200 cap(searchHybrid 内部 slice 到 200,外层 cursor 只分页 ≤200)。预存 v1 限制(round-5 同),非 round-6 引入;契约 5「翻页拿新节点不重复」由 path-keyed dedup 满足。sub-08 若需跨 cap 翻页,重设分页与 cap 关系。
- **JSDoc matchTypes 过度声称**(wiki-search-types.ts:305-308 称 `undefined/length=1 = 仅一种 matchType`,truncated 场景为假)→ sub-08 修注。
- **既有 defer 链**(admin/fail-safe/contract-shape,sub-08):overlapping grants→wikiHits 重复 / target=both truncated 仅 wiki 侧(source 归 sub-03)/ linkRowToView `?id=` 回退(FK 保证不可达)/ HARD_DELETE_BLOCKED `descendant id=`(admin 面,tool 层已剥)/ wiki-node-repository.ts:332 defensive throw `(id=)` / stripInternalIds 对 `id=N` 节点名过剥(fail-safe)/ ToolResult error code 字符串前缀(受形状约束)/ FIX4 `LIKE ? COLLATE BINARY` dead-hint(JS 真强制)/ FIX5 worker 自检超时不 terminate(响应型超时无需杀 worker)。

## 给 Plan 05 的 handoff

- `createWikiTool(deps)` 工厂已就绪,sub-05 注册到 Agent tool registry + prompt 注入(逻辑地址/canonical path/expected_revision/SOURCE_MANAGED 限制,见 wiki-operations.ts:plan-04 §7 prompt 已更新到位)。
- **务必**:注册时把 `matchTypes` 加进 `formatSearchResult`(defer concern C 的兑现点,1 行)。
- `CallerCtx.wikiAccess` 经 `CompiledWikiAccess` 注入;sub-05 接 Agent runtime 时确保 `sendProjectPrompt` contextBundle 设(参 feedback-project-contextbundle-invariant,防 scope 跨项目泄露)。
- WikiService(数据面,sub-02)/ WikiProjectIndexer(镜像,sub-03)/ WikiSourceService·Search(sub-03)实例经 index.ts 闭包可达,sub-05 加 getter/路由接 tool deps。
