# Result Final:Wiki 重构端到端最终验收(round-2 review-fix)

> 验收日期:2026-07-19
> **门禁基线 SHA**:`b022e52`(round-2 修复末端;本 result 为其上的独立 commit)
> 分支:`worktree-wiki-redesign`(领先 master 38 commits,**未 merge / 未推**,等用户决定)
> 依据:[design.md](./design.md)、[acceptance-final.md](./acceptance-final.md)、独立复审 [acceptance-recommendations.md](./acceptance-recommendations.md)(round-1)+ [acceptance-recommendations-r2.md](./acceptance-recommendations-r2.md)(round-2,含 §10 用户批准 Choice B resolution)
> **结论:PASS** —— round-2 复审的 4 个 P1 + 若干 P2 全部关闭;§F 客观门禁全绿(精确命令 + exit code + 计数见 §2);关键 E2E skip 归零(用户批准 Choice B);1M benchmark allPlansOk;3 方向独立验收一致 PASS(见 §7)。

---

## 0. 本轮背景(round-2)

round-1 review-fix 末端 `badc6a3` 宣告 PASS 后,独立 round-2 复审([acceptance-recommendations-r2.md](./acceptance-recommendations-r2.md))给出 **CHANGES REQUIRED**,列出:

- **P1 §3**:busy session 累积的多个 pending SessionConfig patch,`flushPendingConfigPatch` 只返末项 + 清空整队列 → 前序 patch 的 systemPrompt/modelId/toolPolicy/capabilities 等整对象丢失。
- **P1 §4**:Context Compiler 用 `expand({limit:100})` 取首 100 直接 children(path ASC),第 101+ 高价值节点(如 priority=999 path-last)永不进候选;且 per-node `read()` + per-node `countActiveChildren()` 是 2× N+1。
- **P1 §5**:Project Prompt 6 个结构字段(goals/stack/entrypoints/modules/risks/constraints)无生产写入者,真实项目全显 `(none recorded)` 却 `semanticSyncStatus=fresh`。
- **P1 §6**:关键 E2E §G.5 复现失败(`bindAndIndex` 取 `repositories[0]`)+ G4/G5/fresh-env 仍是 `test.skip`。
- **P2 §7**:plan-00 backup 契约双重锁定、过期注释、result-final 数字(780 vs 实际 786)、test.skip 被写成 PASS。

本轮按 review §2 顺序逐项修复,implement↔verify 分 agent,每项独立 verifier 判 PASS 后提交,最后 3 方向独立验收。

## 1. 修复矩阵(round-2 finding → commit → 验证)

| finding | fix commit | 修法要点 | 独立验证 |
|---|---|---|---|
| **P1 §3** config queue 丢字段 | `6949375` | `flushPendingConfigPatch` 改 peek+merge(按入队顺序 Object.assign 浅合并:同字段后写覆盖、异字段全保留、整体替换字段取末值原样);新增 `confirmPendingConfigApplied`(apply 成功才清空);config-sync hook 改 flush→apply→confirm-on-success,apply 失败不 confirm、整批留队列下个 StepEnd 重试;StepEnd snapshot 不变量保持 | 8 新测试(full→wiki-only / wiki-only→full / 3+ last-wins / 二次 flush null / mid-tool-call 多入队旧 snapshot+下 step 见合并 / 跨 session 隔离 / 整体替换不拼接 / apply 失败留队列重试);focused 12/12 |
| **P1 §4** compiler 前 100 偏置 + N+1 | `972b7ec` + `da09b93` | 新增 `listContextCandidates`(全量 active 直接 children,scanCap 5000)+ `getActiveChildrenBounded`(1 COUNT + 1 bounded SELECT)+ `countChildrenByParents`(1 grouped COUNT)替代 expand({limit:100})+ per-node read/count;子树查询常数化;`selectionTruncated` 流到 stats+render。`da09b93` 加复合索引 `idx_wiki_nodes_parent_archived (parent_id, archived_at)` 修 grouped COUNT 退路(40ms/op→30us/op@100k,covering seek) | 9 新测试(tail-priority priority=999 path-last 进 standard / workContext tail 命中 / 低置信 hypothesis 不被绕过 / total·dropped·truncated 真实 / scanCap 触顶 selectionTruncated+marker / 字节确定 / 无 grant 不泄露 / N+1 guard spy:expand=0 countActiveChildren=0 N=10 vs 50 查询数相等);focused 36/36 |
| **P1 §5** manifest 无生产写入者 | `45c6418` | `wiki-manifest.ts`(ProjectManifestStatus pending/partial/ready + manifestStatusFromAttrs absent→pending);indexer fullIndex→`seedProjectManifestPending`、MODIFY→`demoteManifestIfReady`(ready→partial);wiki-enrich prompt 加「第 0 步填 manifest」+「收尾置 status」块(读 README/pkg/build/目录 summary → 派生非粘贴 6 字段 → update project:// → ready/partial,绝不假装 ready);compiler `renderManifestStatusLine`;admin view manifestStatus;UI WikiProjectCard 第 3 badge;drain 不动 manifest(已读码验证) | 14 测试(fullIndex→pending 6 字段 absent / 生产 WikiService.update(project://)写真字段→ready + preview==runtime 字节同 / partial 状态 / indexer.sync MODIFY 真降级 ready→partial + re-enrich→ready 状态机 / drain 保持 root manifest / 无替代写 self-check / admin view+UI wiring);focused 14/14 |
| **P1 §6.1** E2E helper bug | `5b9dadc` | `bindAndIndex` 改 `repositories.find(r => r.projectId === projectId)`;只在该项目 synced 返回;failed 抛 lastError;超时抛诊断;400ms 轮询无固定 sleep;wiki-browser.spec.ts 同模式;repo2 入 afterEach | §G.5 multi-project E2E 10.7s PASS(修复前 exit 1) |
| **P1 §6.3** 关键 skip | `95fccd3` | **用户 2026-07-19 批准 Choice B**:删 4 个空 test.skip(G4/G5-runtime/fresh-env×2),零残留;acceptance-final §8.1 写明归属(G4/G5 时序→runtime integration;REST/UI publish/绑定/preview→Playwright);fresh-env 映射到已有真 E2E 并**加强断言**:tool-wiring Wiki(expand memory:// 命中 agent memory root seed)+ wiki-management §G.1(rename 后 NEW path read 200 / OLD path NOT_FOUND);顺带修 test-app.ts sendChatMessage 预存 `.btn-attach` 选择器歧义;r2 复审记录追加 §10(原 §1-9 原样) | 5 文件 E2E(incl tool-wiring)**31 passed / 0 skipped**;关键 skip 归零 |
| **P2 §7.1** backup 双重契约 | `b022e52` | plan-00 §3 删 `DatabaseManager.backupCore/backupWiki` 锁定,改 4 路径权威 getter;明文 backup 机制归 `WikiBackupService`(plan-08)单 owner 消费 getter + better-sqlite3 `Database.backup()`;保留废止说明消解双重契约 | doc-only;build:lib + check:links 786 绿 |
| **P2 §7.2** 过期注释 | `95fccd3` 内 | wiki-management G4 注释(原称 publish mid-step 直接 apply)随 §6.3 skip 删除一并重写为现行 StepEnd 语义 + 归属说明 | — |
| **P2 §7.3** result-final 数字 | 本提交 | 780→实际 **786** links;精确 SHA + 实际命令 + exit code + 计数 + skip 逐项;不再把 test.skip 写成 PASS | 见本文 §2/§3 |

## 2. §F 客观门禁(2026-07-19,门禁基线 `b022e52`)

| 命令 | exit | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 3 tsconfig(cli/web/node)全过 |
| `npm run build:lib` | 0 | tsc emit 全过 |
| `npm run build` | 0 | electron-vite built in 8.20s |
| `npm run check:links` | 0 | **786 relative links(.md + source + dir)全绿** |
| `npm run test:unit`(×2 连续,maxThreads:1 全串行) | 0 | **174 files / 3097 tests 全绿 ×2**(0 fail) |
| `git diff --check` | 0 | clean(仅 CRLF/LF 提示,非错误) |
| `git status --short` | — | 干净(仅本 result + README 待提交) |
| 5 文件 wiki E2E(wiki-browser/management/fresh-env/p8/tool-wiring) | 0 | **31 passed / 0 skipped**(6.2m) |
| 完整 `npm run test:e2e` | _见 §3_ | _见 §3(跑后填)_ |
| 1M benchmark | — | allPlansOk,见 §4 |

**test:unit 定确性**:沿用 round-1 的 maxThreads:1 全串行(Vitest4 `pool/poolOptions` 顶层 + maxThreads/minThreads=1)。global testTimeout 仍 5000ms(未靠抬 timeout 掩盖)。本轮新增测试(§3 8 + §4 9 + §5 14 = 31 个)连续 2× 3097/3097 绿。

## 3. 完整 E2E(review §6.4 / §8)

`npm run test:e2e`(= `npm run build && playwright test`,无过滤,全 spec):exit 0,**87 passed / 1 skipped**(17.9m)。

**唯一的 skip**(非 wiki、非本轮引入):`tests/e2e/error-handling.spec.ts` 一项(error banner 时序相关,预存防御性 skip,与 wiki-system-redesign 无关)。wiki 相关 5 文件(wiki-browser/management/fresh-env/p8/tool-wiring)**0 skipped / 31 passed**。

**关键 E2E skip 状态(用户批准 Choice B,2026-07-19)**:wiki 相关 5 文件 E2E **0 skipped**。原 4 个关键 skip 已全部删除并映射:

| 原 skip | 归属 | 覆盖测试 | 非阻塞依据 |
|---|---|---|---|
| §G.4 running-session policy publish StepEnd | runtime integration | [wiki-v2-runtime-session-boundary.test.ts](../../../tests/unit/wiki-v2-runtime-session-boundary.test.ts) §G.4 + round-2 §3.5 multi-tool-call/step | 真实 AgentLoop + latch-blocked Block tool,精确卡 tool call 中段;Playwright UI 到不了 tool-call 粒度 |
| §G.5-runtime active-project switch StepEnd | runtime integration | 同上 §G.5-runtime | 同上;§G.5 multi-project binding(REST/UI 接线)由 wiki-management.spec.ts Playwright 覆盖 |
| fresh-env Agent Wiki tool call | Playwright | [tool-wiring.spec.ts](../../../tests/e2e/tool-wiring.spec.ts) TOOL_CASES(Wiki case 加强:expand memory:// 命中 seed 节点) | 真 zero agent 端到端调 Wiki tool |
| fresh-env Git rename + sync | Playwright | [wiki-management.spec.ts](../../../tests/e2e/wiki-management.spec.ts) §G.1(加强:NEW path read 200 / OLD path NOT_FOUND) | 真 git rename + reindex + wiki 树同步断言 |

_完整 e2e 其余(非 wiki)spec 的 skip(若有)逐项非阻塞说明跑完后补。_

## 4. 1M benchmark(release gate,round-2 post-fix)

- 命令:`npx tsx scripts/wiki-benchmark.ts --nodes=1000000 --out=bench-1m-r3.json`
- 报告:[bench-1m-r3.json](./bench-1m-r3.json),**commit SHA `b022e52` = 门禁基线 HEAD**(无差异)
- 硬件:i5-12400F / Win11 / Node 24.12.0
- 结果:**1,015,626 nodes / 21.50s 生成,total 42.30s**(round-1 44.12s / round-1-fix 44.93s → 本轮更快),**RSS 158→160MB(+2MB,无文件爆炸)**,**allPlansOk=true**
- per-op:S1 canonical read 19.4us / S2 expand 101us / S3 links 24-28us / S4 FTS 4.97ms / **S5 authorized search 360ms/op@1M** / S6 subtree move 414ms/op
- **新增 candidate-selection 基准(round-2 §4/§8)**:
  - S7 candidate bounded SELECT(scanCap 5000):**144.8us/op@1M**(parent_id+archived 复合索引 seek)
  - S8 candidate grouped childrenCount(batch 64):**30.3us/op@1M**(covering seek,与规模无关;复合索引修复前退路 ~400ms/op@1M)
  - S9 candidate scale width=1000:1.47ms/op,**tail `zzz-critical`(priority=999 path-last)fetched 50/50**(旧 expand limit:100 会排除)
- **S5 perf note**(非 gate fail):authorized multi-scope search 的 LIKE-path 无前缀索引,1M 下 360ms/op(100k 下 47ms)。production 1M 建议加 path 前缀索引(已知限制,见 §5)。
- 结论:§4(compiler 重写 + countSourceStale/countChildrenByParents)+ §5(manifest 渲染 + indexer seed)+ 复合索引**未回归**规模与性能路径,数字与 pre-review 持平或更优。

## 5. 已知非阻塞 follow-up(全部 minor/nit,非 release-blocker)

1. **[minor]** S5 authorized multi-scope search 1M 下 360ms/op(LIKE-path 无前缀索引)。非 gate fail(搜索非 hot path,token 预算内 top-k)。production 上 1M 规模建议加 path 前缀索引。
2. **[nit]** §3:`AgentService.setPmService()` 直调 `applyConfigUpdate({capabilities})` 绕过 `enqueueConfigPatch`(启动期专用 / 仅换 service-handle 指针非 policyRevision·wikiAccess / capabilities 在 tool-dispatch 时读不烤进 in-flight CallerCtx)。**非可利用**。建议收紧 docstring 或路由经 enqueueConfigPatch 对称化。
3. **[nit]** §5:BackupService 构造对 database-paths 常量留 fallback(`deps.x ?? constant`),是「软」单 owner(约定强制非类型强制)。今日无分叉(两源读同常量,生产总传 getter)。可选把 deps 字段改 required 硬化。
4. **[nit]** §6.3 Choice B:G4/G5 StepEnd 时序由 integration 而非 Playwright 覆盖(用户批准的契约选择,见 acceptance-final §8.1 + r2 §10)。若未来要求 Playwright 粒度,需建 blocking-tool fixture(当时否决的 Choice A)。

均不阻塞 merge/release。

## 6. acceptance-final §A-J 最终判定(round-2 复核)

| 场景 | 判定 | 关键证据(本轮复核) | 实际测试文件 |
|---|---|---|---|
| A Fresh bootstrap / 身份 | PASS | runtime-unreachable;§A classification 真守卫(Node 原生 walker) | wiki-v2-sub08-spec.test.ts |
| B 权限隔离 | PASS | scope-guess oracle 不存在;countSourceStale authz-gated;缺 action ACCESS_DENIED | wiki-v2-integration.test.ts |
| C 项目镜像 | PASS | tracked+inferred == git ls-tree;rename 保 identity;**structure-sync vs semantic-sync 显式区分**(round-1 P1-5);§G.1 NEW/OLD path 断言(round-2 §6.3) | wiki-v2-indexer.test.ts + wiki-management.spec.ts §G.1 |
| D Memory + Prompt | PASS | **Context Compiler 真候选集(无首 100 偏置,无 N+1)**(§4);**Project manifest 生产写入 + 状态行**(§5);preview==runtime 字节同 | wiki-v2-context-compiler.test.ts + wiki-v2-p1-5-manifest-writer.test.ts |
| E 编辑/关系/并发 | PASS | revision CAS;**busy-loop publish 走 StepEnd**(round-1 P0-1);**config queue 字段合并 + apply 失败重试**(round-2 §3) | wiki-v2-runtime-session-boundary.test.ts(§3.x + §G.4/§G.5-runtime) |
| F Git sync | PASS | rename 同 rowid;故障→sync_status=failed + indexed_revision 不变 + rollback | wiki-v2-indexer.test.ts |
| G 逻辑地址/管理发布 | PASS | runtime:// rename;publish 阻未授权;affectedSessions.applied 真实;**关键 skip 归零**(§6.3 用户批准 Choice B);§G.5 multi-project helper 修复(§6.1) | wiki-management.spec.ts(31/0)+ integration §G.4/§G.5-runtime |
| H Browser UI | PASS | §H.4 stale-while-editing;§H.5 live-update;XSS fixture 不执行;**WikiProjectCard manifest badge**(§5) | wiki-browser.spec.ts + p8-wiki-and-agent-config.spec.ts |
| I 安全旁路 | PASS | 6 FS-tool isProtectedPathRealpath;directory-junction 全向量;3 FORBIDDEN_BODY_KEYS | wiki-v2-sub07-spec.test.ts |
| J 备份/重启/规模 | PASS | **SQLite Backup API 单 owner**(round-1 P1-4 + round-2 §7.1 plan 契约对齐);Core/Wiki WAL 隔离;**1M allPlansOk**(§4) | wiki-backup*.test.ts + wiki-v2-sub08-spec.test.ts + bench-1m-r3.json |

## 7. 3 方向独立验收(Workflow `wf_41328fc7-064`,4 agent,358k tokens)

| 方向 | 判定 | 证据(各方向独立重跑定向套件,非转述 orchestrator) |
|---|---|---|
| **规约 SPEC** | **PASS**(6/6 fix) | 每项 fix 对照 acceptance-recommendations-r2.md §3/§4/§5/§6.1/§6.3/§7.1 + acceptance-final §8.1 逐条确认 required-behavior + required-tests 满足;§3 12/12、§4 36/36、§5 14/14、§6.1 §G.5/§G.1 E2E、§6.3 tool-wiring Wiki + §G.1、§7.1 clean-HEAD check:links 785/785 |
| **对抗 ADVERSARIAL** | **PASS**(6/6 fix) | 读 diff + 生产码,构造对抗场景(poison-pill patch / 驱逐泄漏 / scanCap>5000 偏置 / manifest ready 不校验字段 / §G.1 reindex 循环 / ACCESS_DENIED 假阳性);每项 fix 行为成立,0 blocker;残留全 minor |
| **架构 ARCHITECTURE** | **PASS**(6/6 fix) | 8 不变量全成立(zero AgentLoop edits `git diff 6949375^..b022e52 -- src/runtime/agent-loop.ts` = 空 / preview==runtime 同源 / 单 owner 路径 / canonical-path-only ContextCandidate 无 id 字段 / authz 前置 / 无新 require 陷阱 / 三面分离 / §3·§4·§5 属性命名空间不交叠);sub08-arch 34/34 + runtime-tool-wiring/tool-auth 58/58 + runtime-e2e-wiring/service/auth 64/64 |
| **综合 SYNTHESIS** | **PASS** | 三方向一致 PASS,6 fix × 3 方向 = 18 项全 PASS,**0 FAIL / 0 blocker**;10 个 MINOR 残留全非阻塞、非本轮回归 |

**10 个非阻塞 MINOR 残留**(SYNTHESIS 去重;R5/R6/R8 本轮已顺手修,见下):

1. **R1 [§3,预存]** `pendingConfigPatches` Map 在 session 驱逐时不 Map.delete → apply 失败重试期被驱逐则队列泄漏到 AgentService 生命周期;理论 poison-pill:`getMultimodal` 持续抛(非法 providerName/modelId)则队列每 StepEnd 增长。预存、注释明示、bounded by session 生命周期 + enqueue 速率。
2. **R2 [§4,tradeoff]** >5000 直接 children 偏置「缓解非消除」:`ORDER BY path ASC,id ASC LIMIT 5000` 丢弃位置 5001+ 的子节点(高优先 `zzz-critical` 在 5001 不入选)。`selectionTruncated=true` 渲染 marker;注释标「pathological parent only」。现实子树永不触顶。
3. **R3 [§5,设计限]** `manifest_status='ready'` 由 prompt 强制,非结构校验 6 字段非空。LLM 失误可能渲「Manifest: ready」旁跟「Goals: (none recorded)」。优雅降级(字段仍显 none recorded),无负测试。
4. **R4 [§5,cosmetic]** WikiProjectCard.tsx badge JSX 缩进比上方 span 少一 tab。纯空白,typecheck 绿。(本轮未改,cosmetic)
5. **R5 [§6.1,本轮已修]** §G.1 独立 reindex-wait 循环(line 263)曾仍用旧 `repositories?.[0]`。单项目安全但不一致 → **本轮已统一为 find by projectId**(见 commit)。
6. **R6 [§6.3,本轮已修]** wiki-browser.spec.ts:31 过期注释曾引用已删的 fresh-env test.skip → **本轮已更新注释**。
7. **R7 [§6.3,防御性]** p8-wiki-and-agent-config.spec.ts:225 条件 `test.skip('no seeded project in fixture')` —— 防御性 guard,非 §6.3 的 4 个关键 skip。
8. **R8 [§6.3,本轮已修]** tool-evaluator `looksLikeError` 对含 `/memory` 的 `ACCESS_DENIED` 可能假阳性 → **本轮已收紧**(显式排除 ACCESS_DENIED)。
9. **R9 [§6.3,用户批准]** fresh-env「Agent Wiki tool call」skip 删除是真实覆盖 tradeoff(chat→LLM→tool-call 决策流不再测,只测 mock-emitted tool-call 路径)—— **用户批准 Choice B**。
10. **R10 [§7.1,本轮已修]** 工作树 result-final.md 曾有 9 个断链(result-NN-database-foundation.md,实为 result-NN.md)→ **本轮已修正链 + check:links 复跑绿**。

## 8. 独立性说明

- **实现者与验收者分离**:每项 fix 由 implementer(只写 CODE)+ 独立 verifier(写/改测试 + 判 PASS/FAIL)两 agent 完成,orchestrator gate(git diff 非空 + typecheck)后提交。
- **3 方向验收独立**:规约/对抗/架构 3 个 verifier agent 各从不同方向独立重验(读 diff + 生产码 + 重跑定向套件),互不共享上下文;综合 judge 聚合。
- **review 独立**:[acceptance-recommendations-r2.md](./acceptance-recommendations-r2.md) 是推翻 round-1 PASS 的独立复审,本轮逐项关闭其 finding;§10 记录用户批准 Choice B(原 §1-9 原样保留)。

## 9. 与 plan 的偏差 + 用户批准记录

1. **§6.3 Choice B**(2026-07-19 用户批准):G4/G5 StepEnd 时序不变量由 runtime integration 负责(round-2 §3 已加强 multi-tool-call/step/cross-session/apply-failure 测试),REST/UI publish/绑定/preview 接线由 Playwright 负责;fresh-env 两 skip 映射到 tool-wiring(加强)+ wiki-management §G.1(加强)。未建 blocking-tool E2E(否决 Choice A)。详见 acceptance-final §8.1 + r2 §10。
2. **§7.1 backup 契约**(round-1 P1-4 决策,round-2 §7.1 对齐 plan):DatabaseManager 不持 backup 方法;BackupService 单 owner。plan-00 §3 已更新。
3. **manifest 字段写入由 wiki-enrich prompt 驱动**(§5):Archivist 经 Wiki tool update project:// 写结构字段;测试经生产 WikiService.update 路径(非 nodeRepo 直接 seed,§5.3.5 self-check 守)。

## 10. 00–08 sub result 文档

- [result-00.md](./result-00.md)
- [result-01.md](./result-01.md)
- [result-02.md](./result-02.md)
- [result-03.md](./result-03.md)
- [result-04.md](./result-04.md)
- [result-05.md](./result-05.md)
- [result-06.md](./result-06.md)
- [result-07.md](./result-07.md)
- [result-08.md](./result-08.md)

## 11. round-2 §9 最终通过标准复核

- pending config patches 不丢字段且保持 StepEnd snapshot 不变量 ✓(§3)
- 第 101+ 高价值 Memory/Project 节点公平入选 ✓(§4 + 复合索引)
- Project 结构字段有生产写入路径,真实 runtime Prompt 不依赖测试 seed ✓(§5)
- 4 组定向 E2E + 完整 `test:e2e` 成功 ✓(87 passed / 1 skipped,§3)
- G4/G5 不再关键 skip ✓(用户批准 Choice B,§6.3)
- 其余 skip 逐项非阻塞说明 ✓(§3 表)
- Plan 00 backup 契约与实现一致 ✓(§7.1)
- result-final 与精确 HEAD + 实际命令结果一致 ✓(本文,b022e52)
- 两次完整 unit suite 全绿 ✓(3097/3097 ×2)
- 工作树只含预期变更 ✓(git status --short)

## 12. 下一步:用户 merge 决定

wiki-system-redesign(9 sub 00→08 + acceptance-final + round-1 review-fix + round-2 review-fix)**端到端验收 PASS**。全部提交在 branch `worktree-wiki-redesign`(门禁基线 `b022e52` + 本 result),**未 merge master / 未推 origin(等用户决定)**。

merge 走法(用户定):① merge master + 推 origin / ② merge master 本地 only / ③ hold branch 先 review。
