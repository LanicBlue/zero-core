# Result 05：Agent 配置、运行时与 Prompt

对应 [Acceptance 05](acceptance-05-agent-runtime-prompt.md) / [Plan 05](plan-05-agent-runtime-prompt.md)。

- **实施 commit**:`ed229b8`(branch `worktree-wiki-redesign`)— feat(wiki-system-redesign): sub-05 Agent runtime/Prompt(30 文件,+8530/-5026)
- **验收**:2 轮 3-lens adversarial。round-1 FAIL(7 blocker,核心是静态门禁全过但 runtime wiring 多处死路径——feedback-verify-runtime-wiring 假阳性);round-2 全 PASS、0 blocker,新增 e2e wiring 测试驱动真实生产路径断言下游真消费。
- **结论**:✅ Acceptance 05 通过(round-2 三方向独立确认 + e2e wiring 真活),可进入 Plan 06。

---

## 1. 9 节实施(plan-05 全 scope)

1. **AgentRecord schema**:`wikiGrants?/wikiContext?/wikiPolicyRevision?` round-trip(shared/types + agent-store + db-migration `AGENT_COLUMNS` 3 列 + safeAddColumn + fresh DB 自愈 + agent-editor-types)。配置 schema 迁移,**非**旧 wikiAnchors 数据迁移(runtime 从本阶段忽略 wikiAnchors,字段留 plan-08 删)。
2. **Template 默认 grants**:`DEFAULT_GRANTS_AGENT/PROJECT_RESEARCHER/ARCHIVIST/ZERO_ADMIN` + `DEFAULT_WIKI_CONTEXT`(wiki-access-compiler.ts)。**无 `agentId==='zero'` 或 name 硬编码全树**(round-2 B1 修:fallback 对所有 agent 统一 own Memory + Knowledge read,全树须显式 wikiGrants)。
3. **Agent/Project 生命周期**:create 幂等 ensure memory root、rename 只改 display_name/summary(canonical path 不动)、delete 归档;跨库不事务,fire-and-forget + session-build 兜底 ensure(round-2 B7)。
4. **Grants 编译**:`AgentService.compileWikiAccessForSession` → `CompiledWikiAccess` → SessionConfig + `CallerCtx.wikiAccess`。**createLoopForSession 与 sendProjectPrompt 两条路径都 compile**(round-2 B5)。删 `CallerCtx.wikiAnchorNodeIds` 运行时填充(v2 tool 不读,字段留 plan-08)。
5. **Wiki tool 切换**:ToolRegistry 只暴露一个 `Wiki`=`createWikiTool(deps)`;删旧 action schema;无 Legacy/V2/fallback;旧 action → zod schema error。`formatSearchResult` 渲染 `matchTypes` 聚合证据(sub-04 defer C 兑现)。覆盖旧 10 action 所有生产 caller。
6. **WikiContextCompiler**(新 `wiki-context-compiler.ts`):preview==runtime 同函数;compact/standard/deep 三 profile + token budget + 固定截断顺序;Memory 按 attributes 选(不依赖固定子树)。**basic 版**(Project §C.4 部分满足,深度 profile defer)。
7. **缓存/热更新**:通用 `DynamicSystemSection` + `config-sync` StepEnd hook(`src/runtime/hooks/config-sync-hooks.ts`);AgentLoop **零 Wiki import/字面 section/PostTurnComplete**(hooks-only)。`enqueueConfigPatch` 接线 5 事件(round-2 B2:onChange busy / project change / memory archive via `onMemoryTurnWikiWritesCommitted` / publish / refresh)。wiki-context section `cacheBreak:true`(round-2 B6 消 cache null 死锁)。
8. **Memory archive prompt**:新 action + own-memory-only callerCtx(无 `buildGlobalAnchorWikiCallerCtx` 全树捷径)。
9. **Archivist prompt**(template-store + wiki-operations):`project://` navigation + source-bound 限制。

## 2. round-1 7 blocker(round-2 全修 + runtime-真活验证)

e2e wiring 测试(`tests/unit/wiki-v2-runtime-e2e-wiring.test.ts`)驱动 `AgentService.sendProjectPrompt → compileWikiAccessForSession → buildAndRegisterLoop → AgentLoop → buildCallerCtx → Wiki v2 tool` 真实路径,断言下游真消费(非 code-present only):

| Blocker | round-1 病灶 | round-2 修法 | runtime 验证 |
|---|---|---|---|
| B1 | pickDefaultGrants name 含 zero/admin → 全树 | option(b):所有 agent fallback 统一 own Memory + Knowledge read,删 name 启发式 | fresh zero 无 wikiGrants → 只 own Memory + Knowledge;全树须显式 grant |
| B2 | enqueueConfigPatch 零调用(dead wiring) | 接线 5 事件 | onChange/memory-archive 真触发 enqueue→flush(applySpy) |
| B3 | action-tool-schema import 已删 wikiActionSchema 崩 | 迁移 wikiV2ActionSchema(9-action enum + reject 5 退役 v1) | 18/18 |
| B4 | 3 既有测试集 78 fail(旧 wikiAnchorNodeIds 后门废) | 迁移 v2 callerCtx.wikiAccess 契约 | tool-quality 14 / p3-management 33 / sub2-memory 15 全绿 |
| B5 | sendProjectPrompt 不 compile access | buildAndRegisterLoop 前调 compileWikiAccessForSession | fresh project session Wiki tool 首调不 ACCESS_DENIED |
| B6 | wiki-context cache null 死锁(cacheBreak:false) | cacheBreak:true | assemble() 含 ## Wiki Context(见 defer:首 turn race) |
| B7 | session build 无 ensure repair | compileWikiAccessForSession fire-and-forget ensureAgentMemoryRoot | Core 存在+root 缺失→session build 幂等补,不重复不扩权 |

## 3. 验证命令(§F)

| 命令 | 结果 |
|---|---|
| typecheck / build:lib | exit 0 |
| build:codegraph | exit 0(184 文件,含 sub-05 新文件) |
| test:unit | wiki-v2 子系统 114+ 全绿(含 sub-05 新 e2e-wiring 11 + memory-turn 6 + round-1 4 文件);migrated action-tool-schema/tool-quality/p3-management/sub2-memory 全绿;全量仅 3 预存非 wiki fail + Windows exit-127 teardown 崩(分批绕开) |

## 4. 修改文件

impl commit:4 新文件(`src/server/wiki/{wiki-runtime,wiki-access-compiler,wiki-context-compiler}.ts`、`src/runtime/hooks/config-sync-hooks.ts`)+ 13 改(agent-service/agent-store/agent-loop/archive-service/db-migration/management-service/index/template-store/shared-types/runtime-types/agent-editor-types/wiki-tool/wiki-v2-tool)+ 6 新测试(wiki-v2-agent-config/context-compiler/runtime-access/runtime-tool-wiring/runtime-e2e-wiring/memory-turn)+ 5 迁移测试(action-tool-schema/tool-quality-pass-sub3-wiki/p3-management-tools/sub2-memory-routing/wiki-v2-tool-auth)+ code-graph.* regen。

## 拒绝条件(§H)

无 `agentId==='zero'` 或 name 硬编码全树 ✓;wikiAnchors runtime 已删(v2 tool 不读)✓;Prompt 不决定 authorization ✓;preview==runtime 同函数 ✓;不自动转旧 anchors ✓;AgentLoop 零 Wiki 内联/dead-path ✓(grep 仅注释)。

## 验收记录(2 轮)

- **round-1**(3 lens):**FAIL** —— 7 blocker。核心:**静态门禁(typecheck/build/AgentLoop grep)全过,但 runtime wiring 多处死路径**(feedback-verify-runtime-wiring 假阳性:直接调 compiler 的测试掩盖 AgentLoop→assemble 端到端断链)。B1 取舍1 name-hardcode workaround 违 §H#1;B2 config-sync dead wiring;B3/B4 工具切换打坏 4 既有测试集(§F);B5 sendProjectPrompt 不 compile;B6 cache null 死锁;B7 session-build 无 ensure。取舍2/3 合规 defer;取舍4 concern。
- **round-2**(3 lens + 综合):**PASS** —— 7 blocker 全修 + **runtime-真活端到端验证**(对抗新写 e2e wiring 测试驱动真实生产路径,断言下游真消费,非 code-present)。114+ 测试绿,0 regression,4 取舍终确认。code-graph regen。

## defer concerns(留 sub-06/07/08,非阻断)

- **B6 首 turn race**(round-2 concern,2 lens 共报):wiki-context section cache 由 `refreshWikiContextCache` fire-and-forget 异步填充,compute closure 返 `cache ?? ""`;若首 turn assemble 发生在 async 解析前 → section 缺失。**自愈**:cacheBreak:true 使 turn 2+ 重算时 cache 已填;grants/wikiAccess 同步写 config(首 turn Wiki tool 仍能用)。大/慢 DB 首 turn prompt 可能缺 Wiki Context 段。**修法(sub-08 或后续)**:session build 同步预填 cache(await compileWikiContext 再 register loop),或 closure 首调阻塞/同步算。
- **onChange busy 分支绕过 StepEnd 边界**:直接 `loop.applyConfigUpdate`(非 enqueueConfigPatch→StepEnd)。功能安全(callerCtx 每 tool call 快照,applyConfigUpdate 原子换),但偏离 plan-05 §7 的 StepEnd 边界模型(mid-step publish 立即换而非下 step 边界)。sub-08 评估。
- **§C.4 Project profile 部分**(取舍4):renderProjectSection 只 root summary + children 列表,未显式目标/技术栈/sync/风险结构化字段。深度 profile defer。
- **sub-06/07 defer**:PromptTemplate.wikiGrants 字段化(UI 编辑)、wiki-anchor-injection.ts 全删、wikiAnchorNodeIds 字段删、Wiki Browser/Agent Editor UI。
- **sub-08 defer**(admin/fail-safe/contract-shape):overlapping grants dedup / target=both source-side / 既有 id-leak 链(sub-04 result-04)。

## 给 sub-06 的 handoff

- sub-06(Data API/Browser UI):Wiki tool runtime 已就绪(注册 + access 注入 + e2e 验证通)。sub-06 做数据 API + Browser UI(消费新 wiki.db 结构 + canonical path + 节点语义);UI 改动时把 PromptTemplate.wikiGrants 字段化(取舍1 defer 兑现)+ wiki-anchor-injection.ts 全删(取舍3)+ wikiAnchorNodeIds 字段删(取舍2)。
- B6 首 turn race 建议在 sub-06 或 sub-08 一并闭(session build 同步预填 cache)。
- Agent runtime 改动(agent-service/agent-loop/archive-service)已稳定,sub-06 UI 消费 WikiService/SearchService instance(via wiki-runtime.ts getter)。
