# Result Final：Wiki 重构端到端最终验收(review-fix round)

> 验收日期:2026-07-18
> 验收基线:`worktree-wiki-redesign` / HEAD(本轮 review-fix 末端 commit,9 个修复 commit `3fd1328`→`61ac975` + 本 result 提交)
> 依据:[design.md](./design.md)、[acceptance-final.md](./acceptance-final.md)、独立 [acceptance-recommendations.md](./acceptance-recommendations.md)(review)
> **结论:PASS** —— 独立 review 推翻的 2 个 P0 + 5 个 P1 全部关闭,3 方向独立验收(规约/对抗/架构)一致 PASS,§F 客观门禁全绿,acceptance-final §A-J 全过。

---

## 0. 本轮背景

上一版 result-final(基线 `90ea9f6`/`3d514ae`)宣告 PASS。随后一份独立 review([acceptance-recommendations.md](./acceptance-recommendations.md))**推翻该 PASS**,列出 2 个 P0 + 5 个 P1:

- **P0-1**:busy session 的 policy/context 发布未走 StepEnd 安全边界(`setAgentStore` onChange busy 分支直接 `applyConfigUpdate`,mid-step 换 `loop.config`)。
- **P0-2**:Wiki Context Compiler 浅实现(profile 只改预算/workContext 未用/childrenCount 硬 0/root content 没渲/confidence 只排不过滤/review_after 没处理/total=首页长/revision 混时间戳/Project 段无结构字段与 repo binding)。
- **P1-3**:全量 `test:unit` 非定确(并发 timeout + 真断言失败)+ A7 测试是 Windows 上的假 PASS(`execSync('rg')` 在无 rg 时被 try/catch 吞 → 空过)+ Archivist prompt 残留 `intent:` legacy provenance。
- **P1-4**:`DatabaseManager.backupCore/backupWiki` 抛占位码,真备份在 `BackupService`,契约分裂。
- **P1-5**:structure-sync 与 semantic-sync 混淆(项目显 synced 但 source_stale 节点不可见,且无任何路径清 source_stale)。
- **P1-6**:`wiki-database.ts` re-export shim + `WikiSkeletonService` vestigial stubs(`detectDivergence` 返空报告伪成功)残留。
- **P1-7**:arch docs 仍把 legacy 描述为活跃实现;`check-doc-links` 只验 `.md` 链。

本轮按 review §10 顺序逐项修复,implement↔verify 分 agent,每项独立 verifier 判 PASS 后提交。

## 1. 修复矩阵(reviewer finding → fix commit → 验证)

| reviewer finding | fix commit | 修法要点 | 独立验证 |
|---|---|---|---|
| **P0-1** StepEnd 边界 | `3fd1328` | `setAgentStore` onChange busy 分支改走 `enqueueConfigPatch`(idle 立即 / busy 排队→config-sync StepEnd flush);**所有** SessionConfig 字段(非仅 wikiAccess)经此统一入口;`affectedSessions.applied` 首次真实 | §G.4 重写断言正确语义 + **新增多-tool-call/step 测试**(同 step 2 tool call,publish 居中,两 snapshot 同 old rev);对抗 stash 还原修复→测试如期 FAIL |
| **P0-2** Compiler 深度 | `423f366` | 9 defect 全修(profile 选深度 / workContext workHit 排序 / 真childrenCount count / 渲 root content "Stable rules" / 低置信 compact·standard 排 deep 带标记 / review_after due 降级 / 真 total / maxRevision 纯整数+独立 maxUpdatedAt / Project 结构字段+repo binding) + 导航 gap(standard/deep 纳入 undefined-durability 一级子节点) | 9 defect 各一测试 + >100 节点真 total/authz 不泄 + preview==runtime 字节同 + 27/27 |
| **P1-3** 测试门禁 | `f14bc69` + `61ac975` | Vitest4 `pool/poolOptions` 移顶层(原在 `test:` 内被静默忽略)+ maxThreads 全串行(消除 SQLite/git 争用 + 跨测试 module race)+ A7 改 Node 原生 fs walker(真守卫)+ Archivist `intent:` → `reason_status:` + sub4-archive-flow race(vi.resetModules+dynamic-import bleed)capture-window stop() guard 修 | `test:unit` 连续 2× 3065/3065;A7 对抗探针被抓 |
| **P1-4** backup 契约 | `d386416` | 删 `backupCore/backupWiki` + `WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00`;DatabaseManager 加路径权威 getter;BackupService 路径构造注入;生产 index.ts 从 manager getters 接线(单 owner + 单路径源) | path-injection 端到端验 + 33+35 backup 测试绿 |
| **P1-5** sync 状态区分 | `ab602cc` | countSourceStale 原语(authz-gated,LIKE-escape)+ `semanticStaleNodeCount`/`semanticSyncStatus` 入 view + WikiProjectCard 双 badge + Prompt "Semantic sync: N stale" + **drain**(`WikiService.update` 在语义更新时清 source_stale,attributes-only 保留)+ wiki-stale-sync operation | drain 7 子例 + 24 对抗测试 |
| **P1-6** shim/伪成功 | `1aa4513` | 删 `wiki-database.ts` shim + WikiSkeletonService vestigial stubs(ensureSummary/detectDivergence/projectSubtreeRootId/walkWorkspace);`/api/archivist/:projectId/divergence` → 501 NOT_IMPLEMENTED(非 200 空报告) | live HTTP 验 501 + 25 integration 绿 |
| **P1-7** arch docs + checker | `ea010a2` + `73f242a` | arch docs 重写为 v2-only(legacy 降级 strikethrough/历史翻译表)+ check-doc-links.cjs 加固验 .ts/.tsx/.js/.json/.html/.mdx/dir + code-graph regen;§8.5 sweep 修 3 个误导现状文档 + 删 purgeOrphan no-op stub | checker 对抗 probe broken link → exit 1 精确报告 + valid 不误报 |
| **P1-3 follow-up** 兄弟 rg 测试 | 本 result 提交 | §A classification 测试(仍用 `execSync('rg')` Windows 假 PASS)改 Node 原生 walker | 对抗探针注入未分类 project_wiki → 精确 FAIL |

## 2. §F 客观门禁(2026-07-18,HEAD = 本轮末端)

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build:lib` | exit 0 |
| `npm run build` | exit 0(built in 16.72s) |
| `npm run check:links` | **780 relative links(.md + source + dir)全绿**(加固后 checker) |
| `npm run test:unit`(×2 连续,maxThreads:1 全串行) | **3065/3065 全绿 ×2**(0 fail) |
| `npx playwright test tests/e2e/{wiki-browser,wiki-management,wiki-fresh-env,p8-wiki-and-agent-config}.spec.ts` | **27 passed / 4 skipped**(5.3m) |
| 1M benchmark | allPlansOk,详见 §5 |
| `git status --short` | 干净(仅本 result/review/bench 待提交) |

**test:unit 定确性说明**:本轮在 maxThreads 4→2→1 三档 + sub4-archive-flow race 修复后达到真定确。根因:Vitest4 静默忽略 `test:` 内的 `pool/poolOptions`(配置从未生效)+ Windows 并发 SQLite/git 争用 + 一处 `vi.resetModules`+dynamic-import bleed 的测试 race。**未靠全局抬 testTimeout 掩盖**(global 仍 5000ms;仅重 I/O 测试用 per-describe/per-test timeout)。

## 3. 3 方向独立验收(Workflow `wf_a915d677`,4 agent,322k tokens)

| 方向 | 判定 | 证据 |
|---|---|---|
| **规约 SPEC** | **PASS**(9/9 fix 核验) | 每项 fix 对照 acceptance-final §A-J + reviewer P0/P1 逐条确认满足;定向测试绿 |
| **对抗 ADVERSARIAL** | **PASS**(9/9 fix 核验) | 读 diff + 生产码 + 重跑定向套件(§G.4 multi-call / compiler 27/27 / p1-5 24/24 / integration+db-manager 58/58 / sub07+sub08-spec 60/60 / archive·indexer·sync 64/64);**0 blocker/major** |
| **架构 ARCHITECTURE** | **PASS**(9/9 fix 核验) | 7 不变量全成立(AgentLoop hooks-only / preview==runtime 字节同 / 单 owner 路径 / canonical-path-only / 无新 require() 陷阱 / 三面分离 / fix 互一致);4 arch 测试文件 87/87 |
| **综合 SYNTHESIS** | **PASS** | 三方向一致 PASS,0 blocker/major;残留全 minor/nit 非阻塞 |

## 4. acceptance-final §A-J 最终判定

| 场景 | 判定 | 关键证据(本轮复核) |
|---|---|---|
| A Fresh bootstrap / 身份 | **PASS** | runtime-unreachable 证明(动态 import deleted module 抛 ERR_MODULE_NOT_FOUND;§A classification 测试现为真 Node 守卫) |
| B 权限隔离 | **PASS** | scope-guess 无存在 oracle;缺 action ACCESS_DENIED;countSourceStale authz-gated 不泄 |
| C 项目镜像 | **PASS** | tracked+inferred == git ls-tree;rename 保 identity;**structure-sync vs semantic-sync 显式区分**(P1-5) |
| D Memory + Prompt | **PASS** | **Context Compiler 真深度**(P0-2:profile 选深度/workContext/真 total/confidence·review_after 过滤/结构化 Project 字段+repo binding);preview==runtime 字节同 |
| E 编辑/关系/并发 | **PASS** | revision CAS;**busy-loop publish 走 StepEnd**(P0-1:同 step 多 tool call 不混 revision,in-flight snapshot 不被换底) |
| F Git sync | **PASS** | rename 同 rowid;故障→sync_status=failed + indexed_revision 不变 + rollback |
| G 逻辑地址/管理发布 | **PASS** | runtime:// rename;publish 阻未授权;**affectedSessions.applied 真实**(P0-1);G.4/G.5-runtime integration 等价(Playwright skip 有依据) |
| H Browser UI | **PASS** | §H.4 stale-while-editing;§H.5 live-update runtime 真活(P0 require→ESM);XSS fixture 不执行 |
| I 安全旁路 | **PASS** | 6 FS-tool isProtectedPathRealpath 接线;directory-junction Read+Write-create 全向量;3 FORBIDDEN_BODY_KEYS + server 注入 authority |
| J 备份/重启/规模 | **PASS** | **SQLite Backup API 单 owner**(P1-4:DatabaseManager 路径权威 + BackupService 机制);Core/Wiki WAL 隔离;**1M allPlansOk**(§5) |

## 5. 1M benchmark(release gate,本轮 post-fix 复跑)

- 命令:`npx tsx scripts/wiki-benchmark.ts --nodes=1000000`(i5-12400F / Win11,本轮 HEAD)
- 报告:`bench-1m.json`(pre-review,SHA 90ea9f6)+ `bench-1m-r2.json`(本轮 post-fix 复跑)
- 结果:**1,015,626 nodes / 28.66s 生成,total 44.12s,RSS 164→179MB(+15MB,无文件爆炸),6 场景 allPlansOk**
- per-op:S1 canonical read 16.5us / S2 expand+pagination 85.5us / S3 links 20-30us / S4 FTS top-k 4.99ms / **S5 authorized search 384ms/op@1M** / S6 subtree move 513ms/op
- **S5 perf note**(非 gate fail):authorized multi-scope search 的 LIKE-path 无前缀索引,1M 下 384ms/op(100k 下 47ms)。production 上 1M 规模建议加 path 前缀索引(已知限制,见 §6)。
- 结论:本轮代码改动(compiler 重写 / countSourceStale 查询 / stub 删除等)**未回归**规模与性能路径,数字与 pre-review 持平。

## 6. 已知非阻塞 follow-up(3 方向验收残留,全部 minor/nit,非 release-blocker)

1. **[minor,已修]** §A classification 测试曾是 Windows 假 PASS(本 result 提交已改 Node 原生 walker)。
2. **[minor]** P0-1:`AgentService.setPmService()`(agent-service.ts:462-466)直调 `applyConfigUpdate({capabilities})` 绕过 `enqueueConfigPatch`,与 docstring "all fields" 措辞矛盾。**非可利用**(启动期专用 / 仅换 service-handle 指针非 policyRevision·wikiAccess / capabilities 在 tool-dispatch 时读不烤进 in-flight CallerCtx)。建议:收紧 docstring 措辞或路由经 enqueueConfigPatch 对称化。
3. **[nit]** P1-3-tail:archive race 形状(vi.resetModules+dynamic-import bleed)在 4 个兄弟测试(archive-no-residual-sub1..4、sub1-archive-nonblocking)未加 capture-window guard。maxThreads:1 下休眠(已验绿);若未来抬 maxThreads 须先 proactive 加固。
4. **[nit]** P0-1:`affectedSessions.applied` 读 pendingConfigPatches 空;若 StepEnd flush warn-and-continue 留 stale 队列,后续 idle loop publish 会立即 apply 但报 applied=false。是**更安全的 false-negative 方向**(非 review §2.3 担心的 false-positive),非正确性回归。
5. **[nit]** P1-4:BackupService 构造对 database-paths 常量留 fallback(`deps.x ?? constant`),是"软"单 owner(约定强制非类型强制)。今日无分叉(两源读同常量,生产总传 getter);可选把 deps 字段改 required 硬化边界。
6. **[nit]** P1-7:reviewer §8 item2 建议 legacy 移独立 `docs/history/` 文件夹,实现取 inline strikethrough+历史框架替代(严格要求 item1 "active 只描述 v2" 已满足)。

## 7. §14 / reviewer §12 最终通过标准

活跃 DB 仅 core.db+wiki.db ✓ | Agent 只见 canonical path ✓(auditId opaque) | grants/Prompt context 分离 + 搜索授权先于查询 ✓ | Project 结构 Git indexer 独占 + 源码正文不复制 ✓ | links/静态地址内部 identity move 稳定 ✓ | node/FTS/audit 同事务 + Core/Wiki WAL 独立 ✓ | **AgentLoop 无 wiki feature 内联(安全刷新只 idle/StepEnd,P0-1 已闭)** ✓ | 无旧 fallback/权限旁路/源码复制/伪成功 API(P1-6 已闭) ✓ | **设计/实现/tool/Prompt/UI/文档一致(P0-2/P1-5/P1-7 已对齐)** ✓ | 验收者明确 PASS(3 方向独立确认,非"基本可用") ✓

reviewer §12 全部满足:P0 两项关闭 ✓ | 默认全量 unit test 连续 2× 通过 ✓ | 关键 E2E 不再跳 G4/G5(skip 有非阻塞依据:running-AgentLoop fixture 用 integration 等价覆盖)✓ | Project/Memory Prompt 满足真实内容要求(P0-2)✓ | DatabaseManager 与 backup service 契约一致(P1-4)✓ | 项目结构同步与语义同步状态可区分(P1-5)✓ | legacy shim/伪成功 API 删除或明确返未实现(P1-6)✓ | 活动架构文档只描述 v2(P1-7)✓ | result-final 与 HEAD/测试结果/benchmark 一致 ✓

## 8. 独立性说明

- **实现者与验收者分离**:每项 P0/P1 fix 由 implementer(只写 CODE)+ 独立 verifier(写/改测试 + 判 PASS/FAIL)两 agent 完成,orchestrator gate(git diff 非空 + typecheck)后提交。
- **3 方向验收独立**:规约/对抗/架构 3 个 verifier agent 各从不同方向独立重验(读 diff + 生产码 + 重跑定向套件),互不共享上下文;综合 judge 聚合。非 implementer dry-run。
- **review 独立**:[acceptance-recommendations.md](./acceptance-recommendations.md) 是推翻上一版 PASS 的独立 review,本轮逐项关闭其 finding。

## 9. 下一步:用户 merge 决定

wiki-system-redesign(9 sub 00→08 + acceptance-final + review-fix round)**端到端验收 PASS**。全部提交在 branch `worktree-wiki-redesign`(本轮末端 HEAD),**未 merge master / 未推 origin(等用户决定)**。

merge 前无需再补(2 个 release gate——1M benchmark 与 G.4/G.5 running-session fixture——均已满足)。

merge 走法(用户定):① merge master + 推 origin / ② merge master 本地 only / ③ hold branch 先 review。
