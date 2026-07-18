# Result Final：Wiki 重构端到端最终验收

对应 [Acceptance Final](acceptance-final.md)。验收 commit:`a293bea` + 本最终修复集(branch `worktree-wiki-redesign`)。验收者与各 sub 实现者不同(独立 acceptance-final Workflow + orchestrator 独立 re-verify)。

## 0. 结论:**PASS**(2 轮:round-1 FAIL → 修复 → round-2 re-verify 全绿)

acceptance-final §14 严格通过。A-J 全场景过,§12 全量门禁过。**1M benchmark + 2 个 running-session test.skip 为 release gate(非 acceptance 阻塞),见 §5。**

---

## 1. 验收轮次

- **round-1**(7-track 独立验收 Workflow):**FAIL**。A/B/C/D/E/F/I/J 8 场景 PASS;**H FAIL**(BLOCKER:wiki-router `require('./data-change-hub.js')` 在 ESM 模块里 → ReferenceError 被静默吞 → wiki 数据面 live-update 永不 emit → browser 不自刷);G PARTIAL(G.7 authority key 缺 + G.5 stale test);4 个 E2E spec stale(p8 wikiAnchors 退役 / wiki-browser HTTP-counting / fresh-env / wiki-mgmt G.5)。
- **修复集**(独立 implementer):
  - **P0 BLOCKER**:`src/server/wiki-router.ts` 3 处 lazy `require()` → 顶部 ESM `import { emitDataChange }`(镜像 admin plane)。`npm run build` 后 `dist/server/wiki-router.js:44` 用 `import`,repo 无残留 `require(data-change-hub)`。**wiki live-upate 现 runtime 真活**(feedback-verify-runtime-wiring:静态门禁 + unit 全过但 runtime 死,被独立 E2E 抓到)。
  - **P0 暴露的 §H.4 真实 UX bug**:live-upate 工作后,后台 wiki_nodes event 失效 `detailByPath[path]` → WikiDetail `if(!detail) return <Loading/>` 卸载 edit UI + `[editing,detail]` useEffect 覆盖 draft → 编辑被打断、Save 按钮 timeout(React #231)。round-1 §H.4「过」仅因 live-update 死。**修法**:WikiDetail stale-while-editing(edit-start 快照 detail 到本地,editing 期间从快照渲染 edit UI + draft,save/cancel 后再读 store;net +53/-21)。
  - **P1 G.7**:数据面 FORBIDDEN_BODY_KEYS += `authority`(镜像 admin 面)。
  - **P2 stale E2E**:p8-wiki(anchor→wikiGrants 断言 + 删 2 退役 anchor test)/ wiki-browser §H.2-H.3(HTTP-counting→DOM 断言,renderer 走 IPC 非 HTTP)/ wiki-fresh-env(bootstrap namespaces 移出 address book + bind timing)/ wiki-mgmt §G.5(project:// preview 放宽为 inactive-warning,符 design)。
- **round-2 re-verify**(orchestrator 独立跑,非 implementer dry-run):见 §3,全绿。

## 2. A-J 场景最终判定

| 场景 | 判定 | 证据(round-1 track + round-2 re-verify) |
|---|---|---|
| A Fresh bootstrap 与身份 | **PASS** | 4 fixed roots 唯一幂等(wiki-v2-schema §A.5);per-agent 单 Memory root revision=1 无自动子树(wiki-v2-service §D.1/§D.2);稳定业务 ID rename 只改 display_name;schema/API/Prompt/UI strip 内部 ID(wiki-types.ts:194-293, wiki-v2-tool.ts:113-115);PRAGMA integrity core.db+wiki.db ok |
| B 权限隔离 | **PASS** | DEFAULT_GRANTS_* 形状正确;scope-guess existing/non-existing 同 NOT_FOUND(无存在 oracle);缺 action ACCESS_DENIED;空 grants NOT_FOUND 无 nodeRepo 读;搜索不泄未授权(wiki-v2-auth/tool-auth §H);走私身份被 zod strip |
| C 项目注册/镜像/导航 | **PASS** | tracked+inferred dirs == git ls-tree;untracked/gitignored 排除;content==='' 无源码全文副本;fileSummary skeleton;Project Prompt 含目标/sync/retrieval;source read git cat-file @ indexed_revision + workspace realpath+symlink-escape check |
| D Memory 与 Prompt | **PASS** | 动态组织(memory_type/durability/confidence,非固定子树);standard budget 优先元组;低置信/过期不注入;memory-turn own-Memory-only callerCtx;**preview==runtime 字节级同**(单 compileWikiContext,runtime agent-service:727 + preview wiki-admin-router:947) |
| E 编辑/关系/并发 | **PASS** | revision CAS→WRITE_CONFLICT path-based 无 int id;revision 恰+1;node+FTS+audit 同 wikiDb.transaction;replace/section 三态区分(EDIT_TARGET_NOT_FOUND/AMBIGUOUS);单 wiki_links row/edge;MOVE 保留 links/addresses(internal id);audit actor/session/old+new revision + request_id dedup。**§H.4 E2E WRITE_CONFLICT draft 保留 PASS**(round-2 stale-while-editing 修后) |
| F Git commit sync | **PASS** | add/modify/rename/delete;rename 同 rowid + summary/content/links 存活 + FTS 重索引 + revision+1;故障注入→sync_status=failed + indexed_revision 不变 + audit + rollback;同 SHA 重试幂等(0 changesApplied) |
| G 逻辑地址/管理发布 | **PASS**(round-1 PARTIAL→修后 PASS) | G.1 runtime:// rename 后解析同节点新 canonical path;G.2 impact preview 无副作用;G.3 publish 阻未授权 address 不自动 grant;G.6 删最后 grant 持久化 [];G.7 **authority key 已加**→9 数据面 action 无管理 action + 伪造身份拒;G.4/G.5-runtime test.skip(running-AgentLoop fixture,release gate) |
| H Browser UI | **PASS**(round-1 FAIL→修后 PASS) | **§H.5 live-update runtime 真活**(P0 修);§H.4 stale-while-editing + WRITE_CONFLICT draft 保留;§H.1 scope 切换;§H.2 分页无整树(DOM 断言);§H.3 搜索控件透传;§H.6 XSS fixture 不执行(react-markdown 无 rehype-raw)。**wiki-browser.spec.ts 6/6** |
| I 安全旁路 | **PASS** | 6 FS-tool 全接线 isProtectedPathRealpath(file-read:120/write:98/edit:79/grep:342/glob:147/bash:297);lexical bypass 矩阵全拒(direct/../db/shell $ZERO_CORE_DIR/~/win32 case-fold/WAL-SHM/backups/runtime);**directory-junction Read blocked(confidentiality)+ Write-create blocked(parent-dir walk,integrity)**;source path workspace/symlink escape 拒;regex worker 5 limits + terminate;3 FORBIDDEN_BODY_KEYS + server 注入 authority 常量。123 测试绿 |
| J 备份/重启/规模 | **PASS** | SQLite Backup API(plain-path,非 file: URI;非复制活跃 DB);snapshot 可打开 integrity/FK ok;restore 新临时 path + 活跃 DB 不动 + counts 一致;**Core/Wiki WAL 隔离**(wiki write 不改 core mtime/WAL);readonly 诊断不 VACUUM/checkpoint 活跃 DB;100k benchmark allPlansOk(101564 nodes,4.44s,RSS 108MB);8 显式索引 |

## 3. round-2 re-verify(orchestrator 独立)

| 验证 | 结果 |
|---|---|
| `npm run typecheck` / `build:lib` / `build` | exit 0 |
| `npm run check:links` | 292 链全绿(round-1) |
| `npm run test:unit` | 3025/0(A1 triage;round-2 spot-check wiki-v2-sub06/07/08 + arch = 25+25+35+34 全绿,无回归) |
| `npx playwright test wiki-browser.spec.ts` | **6/6**(§H.4 stale-while-editing 修后;§H.5 live-upate 真 emit) |
| `npx playwright test wiki-management.spec.ts` | **9/9**(2 skip = running-session release gate) |
| `npx playwright test wiki-fresh-env.spec.ts` | **7/7**(2 skip) |
| `npx playwright test p8-wiki-and-agent-config.spec.ts` | **5/5**(anchor→wikiGrants) |
| PRAGMA integrity_check / foreign_key_check(core.db + wiki.db) | ok / 0 行 |
| legacy runtime-unreachable | 3 文件删 + 0 import + project_wiki 不在 UI_COLLECTIONS + 运行期 emit 无订阅 |
| 100k benchmark | allPlansOk,8 显式索引 |

## 4. §14 最终通过标准

活跃 DB 仅 core.db+wiki.db ✓ | Agent 只见 canonical path 不见内部 ID ✓(auditId opaque receipt) | grants/Prompt context 分离 + 搜索授权先于查询 ✓ | Project 结构 Git indexer 独占 + 源码正文不复制 ✓ | links/静态地址内部 identity move 稳定 ✓ | node/FTS/audit 同事务 + Core/Wiki WAL 独立 ✓ | AgentLoop 无 wiki feature 内联(安全刷新只 idle/StepEnd)✓ | 无旧 fallback/权限旁路/源码复制 ✓ | 设计/实现/tool/Prompt/UI/文档一致 ✓ | **验收者明确 PASS(非「基本可用」)**✓

## 5. release gate(非 acceptance 阻塞,发布前必跑)

- **1M benchmark**(acceptance D2「发布前手工」):`tsx scripts/wiki-benchmark.ts --nodes 1000000` 需人工跑 + 记 commit SHA + 硬件(CPU/磁盘/OS)+ 命令日志。100k 已 allPlansOk(S5 authorized search 100k 47ms/op,LIKE path 无前缀索引——1M 须确认可接受,否则加 path 前缀索引)。**勿在 docs/README 宣称百万节点已验证直到 1M 跑完贴数**。
- **§7/§G 2 test.skip**(G.4 running session StepEnd apply + G.5-runtime active project 切换):需 controllable blocking Wiki tool call 在 running AgentLoop 内的 fixture。源码接线已存在(config-sync-hooks StepEnd + CallerCtx 每 call 快照 + enqueueConfigPatch),acceptance-final 手工补 fixture。

## 6. 已知非阻塞 follow-up(无 sub-09,track 给用户)

- sub-04 搜索 defer 链(matchTypes>200 / cursor 200 cap / overlapping dedup / linkRowToView / HARD_DELETE_BLOCKED / stripInternalIds / FIX4/5):wiki-v2-sub04 + regex-limits 208+ 测试绿;**Wiki tool output 无 raw 内部 ID 已 round-1 验(§14)**。
- scopeDeltaHint 真实计算 / §6 publish applyConfigUpdate StepEnd 一致性 / onChange StepEnd bypass / §C.4 深度 profile:polish,非 acceptance。
- regex worker 仅匹配 content(非 name/summary)——matchedField label 默认 content,值得 design-doc 注记。
- source search 在全局 Wiki Browser UI 语境空(UI_ADMIN_ACCESS.activeProjectId=undefined)——source search 应在 project-scoped 测试覆盖。

## 7. 结论

wiki-system-redesign(sub-00→08 + acceptance-final 修复集)**端到端验收 PASS**。新 wiki.db 为唯一实现,旧 runtime 不可达,data/management/maintenance 三面就绪,fs guard 完备(含 directory-junction integrity 修复),备份 SQLite Backup API + 100k 规模验证,6 arch 文档更新,E2E 覆盖 browser/management/fresh-env。

**下一步:用户 merge 决定**(branch `worktree-wiki-redesign` 全 9 sub + 本修复集,未 merge master / 未推 origin)。release 前:跑 1M benchmark + 补 2 个 running-session E2E fixture。
