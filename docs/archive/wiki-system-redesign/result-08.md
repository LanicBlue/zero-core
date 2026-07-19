# Result 08：最终切换、旧实现清理与加固

对应 [Acceptance 08](acceptance-08-cutover-hardening.md) / [Plan 08](plan-08-cutover-hardening.md)。

- **实施 commit**:`a905b87`(branch `worktree-wiki-redesign`)— feat(wiki-system-redesign): sub-08 最终切换/清理/加固
- **验收**:2 轮 3-lens adversarial。round-1 FAIL(2 blocker:备份 file:URI CANTOPEN + symlink/junction guard 未接线);round-2 全 PASS、0 blocker、0 回归。sub-08 共 126 unit 测试绿(spec 35 / adversarial 57 / architecture 34),sub-04..07 回归 + E4 恢复文件全绿。
- **结论**:✅ Acceptance 08 通过(round-2 三方向独立确认 + orchestrator 独立重跑 126 测试全绿),可进入 acceptance-final。

---

## 1. 七节实施(plan-08 全 scope)

1. **删除旧实现(§1,cutover 核心)**:删 `project-wiki-router.ts`/`project-wiki-store.ts`/`wiki-node-store.ts`(-1959);清 db-migration(migrateWikiTableSchema/migrateWikiDetailToDisk/safeAddColumn(project_wiki.links)/fresh CREATE TABLE project_wiki)、index.ts(ensureWikiSkeleton/rebuildStaleStructureLayouts/WikiSkeletonService)、data-change-hub(project_wiki 广播)、project-work-hook-manager(project_wiki 订阅)、ProjectPage(project_wiki dropdown)、AgentEditor/agent-editor-types/wikiAnchors 字段、runtime/types、shared/types。**运行时不可达(三方向证明)**:dynamic import deleted module 抛 ERR_MODULE_NOT_FOUND;`/api/project-wiki/*` HTTP 404;`emitDataChange('project_wiki')` no-op;fresh core.db 无 project_wiki/wiki_scan_cursors 表。
2. **文件系统隔离(§2)**:`src/core/protected-paths.ts`(新)+ `src/tools/wiki-path-guard.ts` 重写。保护 db/core.db/wiki.db/WAL/SHM/backups/{core,wiki}/wiki/.runtime。**round-2 Fix 2**:`isProtectedPathRealpath`(realpath/symlink-aware)接线到 6 个 FS-tool 入口(file-read/write/edit/grep/glob + shell token 循环),非 lexical-only。
3. **备份与完整性(§3)**:`src/server/wiki-backup-service.ts`(SQLite Backup API,snapshotAll/Core/Wiki、verifySnapshot、restoreSnapshot、listSnapshots;Core/Wiki 各自独立 snapshot + manifest 不声称跨库同 transaction;readonly 诊断不 checkpoint)。**round-2 Fix 1**:plain-path 打开(非 file: URI)+ snapshotAll 失败抛(不吞 wiki:null)。
4. **性能与规模(§4)**:`scripts/wiki-benchmark.ts`(6 场景:canonical path read / parent expand+pagination / links / FTS top-k / authorized search / subtree move;每场景断言 EXPLAIN QUERY PLAN 用索引)。100k 跑 4.0s 全 plan 断言过(`bench-100k.json`:101564 nodes,allPlansOk,10MB RSS delta=无 per-node 文件爆炸)。**1M 未跑(发布前手工 release gate)**。
5. **数据库维护(§5)**:`src/server/wiki-maintenance-router.ts`(integrity_check/foreign_key_check/fts rebuild+verify/optimize+analyze/snapshot/explicit legacy cleanup;/legacy/cleanup confirm-gated;readonly 不 VACUUM 活跃 DB)。
6. **架构文档(§6)**:docs/arch/{04,05,06,07,08,12}.md 全更新(plan-08 cutover banner + 事实修正;06 新增 §0 Wiki v2 段;**round-2 Fix 3**:05 删 per-node 磁盘正文矛盾措辞)。check:links 290 全绿。
7. **最终集成测试(§7)**:`tests/e2e/wiki-fresh-env.spec.ts`(fresh wiki.db bootstrap → create Agent+wikiGrants via REST → bind git project+full index → snapshot/verify/restore → Core/Wiki 隔离检查 → WikiTreePanel UI smoke)。2 个 test.skip(Agent Wiki tool call / Git rename+sync)标 acceptance-final。

**defer 兑现**:B6 首 turn cache race(sub-05,真 correctness 修:`wikiContextCacheRefreshing` Map + `awaitWikiContextCacheReady` + sendProjectPrompt:2488 await)/ E7 Cron UI disable(sub-07)/ 跨节点 audit-query endpoint(sub-07,POST /api/wiki-admin/audit/query)。

## 2. round-1 blocker + round-2 修法

| Blocker | round-1 病灶 | round-2 修法 | 测试 |
|---|---|---|---|
| **C 备份死** | `wiki-backup-service.ts:178` 用 `file:${path}?mode=ro` URI,Windows 盘符破坏 SQLite URI 解析→CANTOPEN,所有备份 endpoint 死;snapshotAll 静默吞 wiki:null 当成功 | **Fix 1a**:删 file: URI,plain `new Database(sourcePath,{readonly:true,fileMustExist:true})`;**Fix 1b**:snapshotAll wikiDb 在位时任一库失败直接抛(router 转 HTTP 500) | spec C0-C5 + manifest 改写为断言备份真工作(35/35) |
| **B+H symlink/junction 绕过** | `isProtectedPathRealpath` 定义了但从没接线,6 个 FS-tool 用 lexical-only isWikiDiskPath → Windows junction(不需 admin)可 Read core.db(泄 wiki grants/prompt cache/session transcripts) | **Fix 2**:5 FS-tool 调用点 + shell token 循环全改 isProtectedPathRealpath(lexical 先查→existsSync→realpathSync,missing-path fallback 守 Write-create) | 对抗端到端:Read via junction→BLOCKED(confidentiality closed) |

## 3. 验证命令(§F)

| 命令 | 结果 |
|---|---|
| `npm run typecheck` / `build:lib` | exit 0 |
| `npm run build:codegraph` | exit 0(185 文件) |
| `npm run check:links` | 290 相对 .md 链全绿 |
| vitest wiki-v2-sub08-{spec,adversarial,architecture} | 35 + 57 + 34 = **126 全绿** |
| 回归 sub-04..07 wiki-v2 + p9 + E4 恢复(p0-startup/m5-extractors/m4-pm-service/m4-pm-tool) | 全绿(171 + 65 + 等) |
| wiki-benchmark --nodes 100000 | 4.0s,allPlansOk |

acceptance §F 的 `test:e2e` / `npm run build` / **1M benchmark** 由 acceptance-final 跑(1M 是 release gate,见 defer)。

## 4. 修改文件

**新建**:`src/core/protected-paths.ts`、`src/server/{wiki-backup-service,wiki-maintenance-router}.ts`、`scripts/wiki-benchmark.ts`、`tests/e2e/wiki-fresh-env.spec.ts`、`docs/archive/wiki-system-redesign/bench-100k.json`、3 个 sub-08 测试。**删除**:project-wiki-router/store、wiki-node-store 等 legacy。**修改**:db-migration、index、data-change-hub、project-work-hook-manager、ProjectPage、AgentEditor/agent-editor-types、runtime/types、shared/types、tools(file-read/write/edit/grep/glob/wiki-path-guard)、agent-service(B6)、CronDashboard(E7)、wiki-admin-router(audit-query)、docs/arch/{04,05,06,07,08,12} + code-graph.* regen。**E4 外科恢复**:p0-startup/m5-extractors/m4-pm-service/m4-pm-tool。

## 拒绝条件(§H)

- 旧实现仍可被生产入口调用 ✗→✓(runtime-unreachable 三方向证明)
- 仅 grep 过但运行时仍有 subscriber ✗→✓
- 直接复制运行中 wiki.db 当备份 ✗→✓(SQLite Backup API)
- Agent shell 可访问 DB/WAL/backups ✗→✓(realpath guard,confidentiality closed)
- 没 1M 记录就宣称百万节点已验证 ✗→✓(1M 明确为 release gate,未跑)
- 为性能关权限过滤/FTS 同步/审计 ✗→✓

## 验收记录(2 轮)

- **round-1**(3 lens):**FAIL** —— 2 blocker(备份 file:URI CANTOPEN C + symlink guard 未接线 B+H)。§1 legacy runtime-unreachable、§4 100k benchmark、§6 docs、§5 maintenance 全 PASS;0 wiki 回归。E7/audit-query/B6 defer 已兑现。
- **round-2**(3 lens + 综合):**PASS** —— Fix 1(备份 plain-path + 不吞)+ Fix 2(realpath 接线 6 处 + missing-path fallback)+ Fix 3(arch 05)全落地。**confidentiality 端到端 closed**(Read via junction→blocked,对抗独立验)。**legit access 不误伤**(Write-create 不存在文件 / symlinked 项目目录 / grep-glob 合法扫描全过)。stale backup-doc 测试改写为正确行为断言。126 测试绿 + 0 回归。

## defer / follow-up(无 sub-09,显式记录给用户/acceptance-final 决定)

### 🔶 安全 follow-up(建议 merge 前修)— directory-junction Write-create 绕过(integrity-only)
round-2 发现 `isProtectedPathRealpath`(wiki-path-guard.ts:97-112)`existsSync(leaf)=false` 时短路返 false,**Write-create 新文件进 directory-junction 到保护目录(wiki/、backups/core、backups/wiki)不被拦**。已存在文件经 junction 仍被拦(realpathSync 解析)。**影响**:integrity-only(植入 fake wiki attachments / fake backup snapshot / fake manifest JSON,可影响 restore 路径完整性),**非 confidentiality**(读 core.db/wiki.db 经 junction 仍 blocked——round-1 blocker 已闭)。需链式 Windows bypass(先 shell 创 junction;`expandEnvVars` 不处理 cmd `%ZERO_CORE_DIR%` 形式)。**fix hint**:leaf 不存在时,walk 到最深 existing 祖先 dir,realpathSync 它,拼回 suffix 查 isProtectedPath(捕获 `<ws>/wiki-link/planted.md` 因父 `<ws>/wiki-link` 是 junction→WIKI_DISK_ROOT)。pre-existing helper 边,非 round-2 引入;defense-in-depth。**建议 merge 前修(~15 行)**。

### 已知 defer(plan-08 之外 polish,非 acceptance-08)
- **scopeDeltaHint 真实计算**(sub-06/07,address impact 的 scope expand/contract hint,当前 'unknown' stub)。
- **§6 publish applyConfigUpdate vs enqueueConfigPatch StepEnd 一致性**(sub-05/07 runtime polish,非 plan-08 §6 arch docs;wiring 已活,in-flight snapshot 安全)。
- **sub-04 搜索 defer 链**(matchTypes>200 截断 / cursor 200 cap / overlapping grants dedup / linkRowToView `?id=` 回退 / HARD_DELETE_BLOCKED / stripInternalIds / FIX4 dead-hint / FIX5 worker 超时)。**caveat**:acceptance-final 应断言 Wiki tool output 不含 raw 内部 integer ID(若泄露则违 §A,升级为 FAIL)。
- **sub-05 onChange StepEnd bypass + §C.4 深度 Project profile**。

### Release gate(发布前必跑,非 acceptance gate)
- **1M benchmark**:plan-08 §4 / acceptance D2 明确「发布前手工」。`scripts/wiki-benchmark.ts --nodes 1000000` 需人工跑 + 记 commit SHA + 硬件(CPU/磁盘/OS)+ 命令日志进 result-08。**勿在 docs/README 宣称「百万节点已验证」直到 1M 跑完贴数**。

### 测试覆盖 follow-up
- **E4**:4 个带非 wiki 覆盖的旧测试已外科恢复(p0-startup/m5-extractors/m4-pm-service/m4-pm-tool);另有 ~12 个(enrichment-runner/memory-recall/p0-store/p5-project-container/p6-fresh-db-seed/m3-orchestrate/sub2-memory-routing/sub5-tool-dispatcher/p7-zero-protection-and-skeleton/sub12-summary-truncation/p3-management-tools/p7-end-to-end)wiki import 与非 wiki 断言交织紧,未恢复——**非 wiki 覆盖损失**(server boot/PM/extractor/archive cascade),track 再补。
- **9 个 pre-existing test:unit 失败**(sub2-wiki-tree-render-contract ×3 v0.8 lazy-render、archive-no-residual-sub2/sub3、deferred-dangling-tasklink、m1-cron ×2)——与 sub-08 无关(stash-and-test-at-HEAD 确认),但让 test:unit 非全绿,mask 真失败。track 单独清理。

## 给 acceptance-final 的 handoff

- acceptance-final(独立验收 Agent,per acceptance-final.md):跑 §7 的 2 个 test.skip(跨 sub 集成:Agent Wiki tool call / Git rename+sync)+ **1M benchmark release gate** + 全量 §F(test:e2e / npm run build / check:links)+ **Wiki tool output 无 raw 内部 ID 断言**(sub-04 defer caveat)+ 跨 sub-00..08 端到端。
- **建议 acceptance-final 前先修上面 🔶 directory-junction Write-create 安全 follow-up**(integrity-only 但影响 backup/restore 完整性,fix ~15 行)。
- 整个 wiki-system-redesign(sub-00→08)数据面 + 管理面 + cutover 已就绪并验证;旧实现 runtime-unreachable;新 wiki.db 为唯一实现。
