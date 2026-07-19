# Result Final:Wiki 重构端到端最终验收(round-3 review-fix)

> 验收日期:2026-07-19
> **门禁 SHA**:`b5249f4`(round-3 修复末端;本 result 为其上的**纯文档** commit —— b5249f4 → 本 commit 之间无 src/ 或测试变更)
> 分支:`worktree-wiki-redesign`(领先 master 41 commits,**未 merge / 未推**,等用户决定)
> 依据:[design.md](./design.md)、[acceptance-final.md](./acceptance-final.md)、复审 [acceptance-recommendations.md](./acceptance-recommendations.md)(r1)+ [acceptance-recommendations-r2.md](./acceptance-recommendations-r2.md)(r2,§10 Choice B)+ [acceptance-recommendations-r3.md](./acceptance-recommendations-r3.md)(r3)
> **结论:wiki-system-redesign 范围 PASS**(用户 2026-07-19 决定 B)。round-3 的 P1-1/P2-1/P3-1 全部关闭;wiki 专属 E2E + 客观门禁全绿;完整 `test:e2e` 的 9 个失败经 airtight 核查**无一由 wiki 引起**(multimodal 6 个 master 预存 + memory-ui/model-info/project-page 3 个是分支上别的 effort 的测试债),按用户决定 B 留给各自 effort。

---

## 0. 本轮背景(round-3) + 诚实更正

round-2 result-final 把完整 E2E 记为「87 passed / 1 skipped,exit 0」,**这是错误的**(round-3 复审 r3 §1/§2 指出)。真实情况:完整 `npm run test:e2e` 有失败,且 round-2 result-final 把唯一 skip 错归于 error-handling.spec.ts(实际在 context-usage-real-api.spec.ts),并残留「跑后填」占位文。根因:round-2 全 e2e 输出经 `tail` 截断,我只取了 passed 计数 + 未核 exit code —— 证据不可靠。本轮纠正:所有门禁数字来自**未截断的完整输出 + 真实 exit code**,逐项可复验。

round-3 复审(acceptance-recommendations-r3.md)CHANGES REQUIRED,4 项:
- **P1-1**:error-handling.spec.ts 3 处 Send 选择器 `.chat-input-bar button:not(.btn-abort)` 歧义 multimodal sub-5 的 `.btn-attach` → 3 case 稳定失败。
- **P1-2**:result-final 证据不可靠(见上)+ 门禁基线 b022e52 后的 9db8627 又改了测试 → 记录的门禁没覆盖最终测试树。
- **P2-1**:§G.1 reindex 轮询 `!== "indexing" → break` 把 pending/failed/未出现都当成功(round-2 R5 只改了 find-by-projectId,没改严格契约)。
- **P3-1**:wiki-fresh-env + r2 文档残留「search」描述,实际用 /api/wiki/read。

## 1. round-3 修复矩阵

| finding | 修法 | 验证 |
|---|---|---|
| **P1-1** Send 选择器 | 统一改 `getByRole("button", {name:"Send"})`(Send 按钮文本 "Send",只匹配它,不匹配 "+"(attach)/"Stop"(abort),抗未来输入按钮)。覆盖**全部 6 处**:error-handling(3 内联)+ test-app sendChatMessage + multimodal-input clickSend/sendBtn(2)+ page-restore + session-archive。后 4 处是本轮发现的同类潜在失败(round-2 全 e2e 因 .btn-attach 渲染 flaky 走运没报) | error-handling 3 case 在全 e2e 中 PASS(不在失败列表)|
| **P2-1** §G.1 严格 synced | 抽取共享 `waitForProjectSynced(port, projectId)`(严格契约:synced→返回 / failed→抛 lastError / 其他→轮询 / 超时→抛诊断),bindAndIndex + §G.1 reindex 都用它 | §G.1 / §G.5 E2E PASS |
| **P3-1** search→read 文档 | wiki-fresh-env §G.1 映射注释 + r2 §10.3:NEW path 验证从「search 命中」改为「/api/wiki/read 返 200」(与实现一致) | 文档一致 |
| **P1-2** 证据可靠 | 门禁基线改为 round-3 末端 `b5249f4`(含全部测试修复);本 result 是 b5249f4 之上的**纯文档** commit;所有数字来自未截断完整输出 + 真实 exit code;无「跑后填」占位 | 见 §2/§3 |

修复 commit:`b5249f4`(round-3 P1-1/P2-1/P3-1 一并)。

## 2. §F 客观门禁(2026-07-19,门禁 SHA `b5249f4`)

| 命令 | exit | 结果(未截断完整输出) |
|---|---|---|
| `npm run typecheck` | 0 | 3 tsconfig(cli/web/node)全过 |
| `npm run build:lib` | 0 | tsc emit 全过 |
| `npm run build` | 0 | electron-vite built OK |
| `npm run check:links` | 0 | **802 relative links(.md + source + dir)全绿** |
| `npm run test:unit`(×2 连续,maxThreads:1 全串行) | 0 | **174 files / 3097 tests 全绿 ×2**(0 fail) |
| `git diff --check` | 0 | clean(仅 CRLF/LF 提示,非错误) |
| wiki 专属 5 文件 E2E(tool-wiring + wiki-browser + wiki-management + wiki-fresh-env + p8) | 0 | **31 passed / 0 skipped** |
| 完整 `npm run test:e2e`(build + 全 `playwright test`) | **非 0**(见 §3) | **92 passed / 9 failed / 1 skipped**(17.2m)—— 9 失败全非 wiki,见 §3 |
| 1M benchmark | — | allPlansOk,见 §4 |

**test:unit 定确性**:沿用 round-1 的 maxThreads:1 全串行(Vitest4 `pool/poolOptions` 顶层 + maxThreads/minThreads=1)。global testTimeout 仍 5000ms。本轮无生产码改动,test:unit 计数与 round-2 一致(3097)。

## 3. 完整 E2E 真实结果 + 9 失败的 airtight 归因(review r3 §2.3 + 用户决定 B)

`npm run test:e2e`(门禁 SHA `b5249f4`):**92 passed / 9 failed / 1 skipped**,playwright exit 非 0。

### 3.1 唯一 skip(正确归属)

`tests/e2e/context-usage-real-api.spec.ts` —— 由 `ZERO_CORE_E2E_REAL_API` 环境变量控制,**默认跳过**(设计如此,非失败、非 wiki)。round-2 错把它归于 error-handling.spec.ts(已纠正)。error-handling.spec.ts **无 test.skip**(round-3 P1-1 修复后其 3 case 全 PASS)。

### 3.2 9 个失败 —— 经 airtight 核查**无一由 wiki-system-redesign 引起**

| spec | case | 失败原因 | 归因证据 |
|---|---|---|---|
| multimodal-input(6 个 case) | sub-7 多模态输入 | `TypeError: api.providersUpdateModel is not a function` | **master 预存**:`providersUpdateModel` 被 commit `48ba305`(multimodal "多模态不可编辑" 修复)**删除,且 48ba305 在 master 上**(`git merge-base --is-ancestor 48ba305 master` = YES);master 的 multimodal-input.spec.ts 仍调用它(2 处)+ master preload 已无它 → **master 自己就失败**。wiki 的 39 commits 不含任何 multimodal/providersUpdateModel 改动 |
| memory-ui | compression toggle 可见 | `expect(toggles.first()).toBeVisible` 失败 | 压缩特性,wiki **未碰**:wiki 不涉及 compression-core.ts / compression-trigger-hooks.ts(那是 compression-archive-simplify / memory-compaction-runtime effort)。spec 与 master 字节一致(`git diff master..HEAD -- tests/e2e/memory-ui.spec.ts` = 空) |
| model-info | model 下拉格式 | `expect(text).toMatch(/Mock Model\s*—\s*128K/)` 失败 | 模型下拉渲染,wiki **未碰**。spec 与 master 字节一致 |
| project-page | New Project modal fill | `locator.fill: Timeout 30000ms` | wiki 的 ProjectPage.tsx diff **只加 WikiProjectCard**(import + DashboardTab 挂载 + handleOpenWiki),**无 `<input>`、不碰 New Project modal**(`git diff master..HEAD -- ProjectPage.tsx | grep '<input'` = 空)。spec 与 master 字节一致 |

**核查方法**:逐 spec 检查 (a) wiki 是否改了该 spec(全 3 个 + multimodal spec 中,只有 multimodal-input.spec.ts 被 round-3 P1-1 动过,且改的是 Send 选择器非 providersUpdateModel 调用);(b) wiki 是否改了该 spec 测试的生产特性(wiki 未碰 compression / model 下拉 / project modal 生产码);(c) multimodal 用 `git merge-base --is-ancestor` 证删除 commit 在 master 上。3 个非 multimodal spec 干净重跑仍确定性失败(非 flaky)。

**用户决定(2026-07-19,B)**:这 9 个是 wiki-system-redesign 范围外的失败(multimodal 是 master 预存;memory-ui/model-info/project-page 是分支上 compression/model/project 特性的测试债),**留给各自 effort 修**,wiki 验收按 wiki 范围独立 PASS。

### 3.3 wiki 关键 E2E + integration(全绿,r3 §2.1/§2.2 复核)

- Wiki Playwright(tool-wiring Wiki expand memory:// + §G.1 rename NEW/OLD path + §G.5 multi-project):`3 passed` exit 0
- G4/G5 runtime boundary(`wiki-v2-runtime-session-boundary.test.ts`,真 AgentLoop + latch-blocked tool):`12 passed` exit 0

## 4. 1M benchmark(release gate)

- 报告:[bench-1m-r3.json](./bench-1m-r3.json),commit SHA `da09b93`。**round-3(b5249f4)仅改 test/doc,无生产码改动** → wiki/compiler/indexer 生产路径在 b5249f4 ≡ da09b93,benchmark 对门禁 SHA 有效。
- 结果:**1,015,626 nodes / 21.50s 生成,total 42.30s,RSS 158→160MB(+2MB),allPlansOk=true**
- S7 candidate bounded SELECT 144.8us/op@1M / **S8 grouped childrenCount 30.3us/op@1M**(复合索引 covering seek)/ S9 width=1000 tail(priority=999 path-last)fetched 50/50
- S5 authorized search 360ms/op@1M(LIKE-path 无前缀索引,非 gate fail,搜索非 hot path)—— production 1M 建议加 path 前缀索引(已知限制)

## 5. 已知非阻塞 follow-up

**round-3 范围外(用户决定 B,留各自 effort)**:
1. multimodal-input.spec.ts 6 case:调用了 master 上已删的 `providersUpdateModel` API(48ba305)→ TypeError。multimodal effort 需更新测试(改用 mock provider 已有多模态模型 / 改 fixture)。
2. memory-ui compression toggle 可见性:compression-archive-simplify / memory-compaction-runtime effort 的测试债。
3. model-info model 下拉格式:同上,非 wiki。
4. project-page New Project modal fill:同上,非 wiki(wiki 的 ProjectPage 改动不碰 modal)。

**round-2 残留(全 minor/nit,非阻塞)**:
5. setPmService 绕 enqueueConfigPatch(启动期/非可利用);6. >5000 直接 children 偏置(pathological,selectionTruncated marker);7. manifest_status=ready 由 prompt 强制非结构校验(优雅降级);8. BackupService 软单 owner fallback;9. pendingConfigPatches 驱逐不 Map.delete(预存、bounded);10. fresh-env Wiki tool call skip 删除是覆盖 tradeoff(用户批准 Choice B)。

均不阻塞 wiki merge/release。

## 6. acceptance-final §A-J 判定(wiki 范围,round-3 复核)

| 场景 | 判定 | 实际测试文件 |
|---|---|---|
| A Fresh bootstrap / 身份 | PASS | wiki-v2-sub08-spec.test.ts |
| B 权限隔离 | PASS | wiki-v2-integration.test.ts |
| C 项目镜像 | PASS | wiki-v2-indexer.test.ts + wiki-management §G.1 |
| D Memory + Prompt | PASS | wiki-v2-context-compiler.test.ts + wiki-v2-p1-5-manifest-writer.test.ts |
| E 编辑/关系/并发 | PASS | wiki-v2-runtime-session-boundary.test.ts(§3 + §G.4/§G.5-runtime)|
| F Git sync | PASS | wiki-v2-indexer.test.ts |
| G 逻辑地址/管理发布 | PASS | wiki-management.spec.ts(31/0)+ integration §G.4/§G.5-runtime |
| H Browser UI | PASS | wiki-browser.spec.ts + p8-wiki-and-agent-config.spec.ts |
| I 安全旁路 | PASS | wiki-v2-sub07-spec.test.ts |
| J 备份/重启/规模 | PASS | wiki-backup*.test.ts + wiki-v2-sub08-spec.test.ts + bench-1m-r3.json |

## 7. 3 方向独立验收(round-2 Workflow `wf_41328fc7-064`)

SPEC / ADVERSARIAL / ARCHITECTURE 一致 **PASS**(6 fix × 3 方向 = 18 项全 PASS,0 blocker,10 MINOR 残留全非阻塞)。详见 round-2 result 记录;round-3 修复(test/doc only)未改生产码,该验收仍有效。

## 8. 独立性说明

- 实现者与验收者分离:每项 fix 由 implementer(CODE only)+ 独立 verifier 分 agent。
- 3 方向验收独立(round-2);round-3 修复由全门禁真实输出 + airtight 非 wiki 归因核验。
- 复审独立:r1/r2/r3 三轮独立复审,r2/r3 的 §10/§resolution 记录用户批准(原 review 文本保留)。

## 9. 与 plan 的偏差 + 用户批准记录

1. **round-2 §6.3 Choice B**(2026-07-19):G4/G5 时序→integration;REST/UI 接线→Playwright;fresh-env 两 skip 映射 tool-wiring + §G.1。见 acceptance-final §8.1 + r2 §10。
2. **round-3 决定 B**(2026-07-19):9 个全 e2e 失败 airtight 证非 wiki(multimodal master 预存 + 3 个别的 effort 测试债),按 wiki 范围 PASS,9 失败留各自 effort。见本文 §3.2。
3. **round-1 P1-4 / round-2 §7.1 backup**:BackupService 单 owner,plan-00 已对齐。
4. **§5 manifest**:wiki-enrich prompt 驱动写入,测试经生产 WikiService.update 路径(§5.3.5 self-check)。

## 10. 00–08 sub result 文档

[result-00.md](./result-00.md) · [result-01.md](./result-01.md) · [result-02.md](./result-02.md) · [result-03.md](./result-03.md) · [result-04.md](./result-04.md) · [result-05.md](./result-05.md) · [result-06.md](./result-06.md) · [result-07.md](./result-07.md) · [result-08.md](./result-08.md)

## 11. round-3 §5 通过条件复核

- error-handling.spec.ts 三项全过 ✓(P1-1,全 e2e 中不在失败列表)
- Wiki 定向五文件 E2E 无关键 skip,计数以真实运行结果为准 ✓(31 passed / 0 skipped)
- G4/G5 runtime integration 全过 ✓(12 passed)
- ~~完整 `npm run test:e2e` exit 0~~ —— **未达字面条件**:92 passed / 9 failed / 1 skipped,9 失败 airtight 证非 wiki(§3.2),用户决定 B 接受 wiki 范围 PASS,9 失败留各自 effort
- 唯一 skip(context-usage-real-api.spec.ts,env-gated)逐项说明 ✓(§3.1)
- typecheck / build:lib / check:links 通过 ✓
- 完整 test:unit 串行门禁通过 ✓(3097/3097 ×2)
- git diff --check 通过 ✓
- result-final 与被测试 SHA(b5249f4)、命令输出、skip 事实一致 ✓(无占位)
- 工作树干净 ✓

## 12. 下一步:用户 merge 决定

wiki-system-redesign(9 sub + acceptance-final + r1/r2/r3 review-fix)**wiki 范围端到端验收 PASS**。提交在 branch `worktree-wiki-redesign`(门禁 SHA `b5249f4` + 本 result doc commit),**未 merge / 未推(等用户决定)**。9 个非 wiki 全 e2e 失败按用户决定 B 留各自 effort(multimodal / compression / model-info / project 特性)。

merge 走法(用户定):① merge master + 推 origin / ② merge master 本地 only / ③ hold branch 先 review。
