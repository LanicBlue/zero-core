# Wiki System Redesign：实施后第二轮复审修改建议

> 复审日期：2026-07-18
> 复审基线：`worktree-wiki-redesign` / `badc6a3d241c8f3f0b71815df3cdc0ad1678bceb`
> 前序复审：[acceptance-recommendations.md](./acceptance-recommendations.md)
> 当前判定：**CHANGES REQUIRED / 暂不满足最终 PASS**

## 1. 复审结论

前序复审提出的两个 P0 主问题已有实质性修复：

- busy AgentLoop 的 AgentRecord/Wiki policy 更新已经进入 StepEnd 安全边界；
- Wiki Context Compiler 已补充 profile、Memory 属性筛选、Project 结构字段、repo binding、真实计数和 stale 提示。

数据库拆分、Wiki CRUD/search/link、权限编译、Git 项目镜像、管理 UI、旧实现清理和备份机制的主体也已经完成。

但本轮复审仍发现：

- 3 个实现级 P1；
- 1 个关键验收门禁 P1；
- 若干文档与证据包 P2。

这些问题关闭前，`result-final.md` 不应标记最终 PASS。

## 2. 修改顺序

按以下顺序实施，避免测试或文档先掩盖实现问题：

```text
1. 合并 pending SessionConfig patches
2. 修复 Context Compiler 前 100 节点偏置
3. 建立 Project 结构字段的生产写入流程
4. 修复并补齐关键 E2E
5. 对齐 plan / acceptance / result-final
6. 重跑完整门禁并重新生成最终证据
```

每一项都应先修改生产实现，再补对抗测试。不得只放宽断言、增加 sleep、继续保留关键 `test.skip`，或通过修改 `result-final.md` 将失败描述为非阻塞。

## 3. P1：pending config queue 会丢失前序字段

### 3.1 当前问题

位置：

- `src/server/agent-service.ts`
  - `enqueueConfigPatch`
  - `flushPendingConfigPatch`
- `src/runtime/hooks/config-sync-hooks.ts`

busy session 可以在一次 StepEnd 前累计多个 patch。例如：

```text
AgentStore.onChange
  → full SessionConfig patch
  → systemPrompt/model/toolPolicy/wikiAccess/...

refreshSessionWikiContext 或 active project switch
  → partial Wiki patch
  → wikiAccess/dynamicSystemSections
```

当前 `flushPendingConfigPatch()` 清空整个队列，但只返回最后一项：

```ts
const last = queue[queue.length - 1];
this.pendingConfigPatches.set(sessionId, []);
return last;
```

这不是“同字段后写覆盖前写”，而是“后一整个对象丢弃前一整个对象”。若最后一项只含 Wiki 字段，先前的 `systemPrompt`、model、provider、tool policy、capabilities 等更新会丢失，直到下次刷新或重建 session。

### 3.2 要求的行为

StepEnd 应对同一 session 的全部 pending patches 做有序字段合并：

```text
merged = {}
for patch in queue insertion order:
    merged = merge(merged, patch.update)

same field:
    later value wins

different fields:
    all survive
```

推荐返回：

```ts
{
  sessionId,
  update: mergedUpdate,
}
```

注意：

- `dynamicSystemSections`、`capabilities`、`wikiAccess` 等字段是整体替换值，不做数组拼接或深层猜测；
- 同字段使用最后一次值；
- 不同字段必须保留；
- flush 成功取出后清空队列；
- `applyConfigUpdate` 失败时是否重试必须明确，不能无说明地永久丢弃。若选择不重试，应记录结构化错误和 session stale 状态；
- 当前 tool call 的 `CallerCtx` snapshot 仍必须保持旧 revision，合并不能破坏 StepEnd 边界。

### 3.3 必须新增的测试

至少覆盖：

1. full patch 后接 Wiki-only patch：

```text
full(systemPrompt, modelId, toolPolicy, wikiAccess@2)
wiki-only(wikiAccess@3, dynamicSystemSections)
→ flush:
  systemPrompt/modelId/toolPolicy 保留
  wikiAccess 使用 @3
  dynamicSystemSections 存在
```

2. Wiki-only patch 后接 full patch：

```text
→ full 中相同字段覆盖，非相同字段保留
```

3. 三个以上 patch，同字段 last-write-wins。
4. 一次 StepEnd 只应用一次合并结果，第二次 flush 返回 null。
5. mid-tool-call 入队多个 patch，当前两个同-step tool calls 仍使用旧 snapshot；下一 step 同时看到所有合并字段。
6. 不同 session 的 queue 不能串用。

建议扩展：

- `tests/unit/wiki-v2-runtime-session-boundary.test.ts`
- 新增一个只验证 queue merge primitive 的小型单元测试，避免所有断言都依赖重型 AgentLoop fixture。

## 4. P1：Context Compiler 在排序前只读取前 100 个节点

### 4.1 当前问题

位置：

- `src/server/wiki/wiki-context-compiler.ts`
- `src/server/wiki/wiki-node-repository.ts`

当前流程：

```text
expand(root, limit=100, cursor=null)
→ 按 canonical path ASC 得到第一页
→ 只对这 100 个节点读取 attributes
→ filter / workContext boost / priority sort
```

因此数据库中的第 101 个及以后节点，无论 priority、durability 或 workContext 相关度多高，都没有进入候选集合的机会。

本轮最小探针：

```json
{
  "total": 120,
  "included": 100,
  "containsCritical": false
}
```

其中第 120 个 `zzz-critical` 是 `durability=permanent, priority=999`，仍未进入 Prompt。

现有 120-node 测试只验证了 `total` 和 `dropped` 计数，没有验证排序候选是否覆盖 100 以后的高价值节点。

### 4.2 推荐实现

不要把普通 `expand()` 的第一页当作 Prompt candidate selector。新增面向 compiler 的内部查询接口，例如：

```ts
listContextCandidates({
  parentPath,
  profile,
  workContext,
  candidateLimit,
})
```

查询应：

- 先通过授权解析出可访问根；
- 只选 active direct children；
- 在数据库层完成可确定的 filter/rank；
- 读取 row 中已有的 summary、attributes、revision、updated_at，无需对每个节点再次 `read()`；
- 按 durability、confidence、priority、review_after、updated_at、canonical path 稳定排序；
- 允许 workContext 命中节点进入高优先级候选，而不是只能在第一页内 boost；
- 返回真实 total 与被选 candidate 数；
- deep profile 的二级展开继续有明确上限。

如果第一版暂时选择遍历全部一级分页再排序，也必须：

- 有最大节点/时间预算；
- 超过内部扫描上限时明确报告 selection truncated；
- 不得静默退回 path-first 前 100；
- 规模测试证明不会在大型项目/Memory 根上产生不可接受的 N+1 查询。

### 4.3 必须新增的测试

1. 创建 120 个节点：
   - 前 119 个 path 排在前面、priority=1；
   - 第 120 个 path=`zzz-critical`、priority=999；
   - standard profile 必须包含 `zzz-critical`。
2. 第 120 个节点由 `workContext.recentFiles` 命中，也必须进入候选。
3. 第 120 个低置信 hypothesis 在 standard 中仍应过滤，不能因为修复候选范围而绕过滤规则。
4. `total/dropped/truncated` 在 100+ 节点时仍真实。
5. 相同输入两次输出字节一致。
6. 无 grant 时查询不能泄露 total 或高价值节点存在性。
7. 加入 query-count 或 timing guard，防止重新引入逐节点 `read()` 的无界 N+1。

## 5. P1：Project Prompt 的结构字段缺少生产写入者

### 5.1 当前问题

Compiler 已能渲染：

```text
goals
stack
entrypoints
modules
risks
constraints
```

但目前这些值主要存在于手工构造的 compiler 测试 fixture。生产索引器只创建启发式文件/目录摘要；`wiki-enrich` prompt 要求更新普通 summary/content，并没有明确要求生成项目根的上述结构化 attributes。

结果是：

- 格式上出现了六个字段；
- 真实项目通常仍显示六个 `(none recorded)`；
- `semanticSyncStatus=fresh` 只能说明没有 `source_stale` 修改项，不能说明项目 manifest 已经被语义充实；
- 最终报告据此声称“Project Prompt 已满足丰富内容要求”缺少生产证据。

### 5.2 要求的生产流程

定义项目根 attributes 的正式 schema，至少包括：

```json
{
  "goals": ["..."],
  "stack": ["..."],
  "entrypoints": ["..."],
  "modules": ["..."],
  "risks": ["..."],
  "constraints": ["..."],
  "manifest_status": "pending|partial|ready",
  "manifest_updated_at": "ISO-8601"
}
```

字段应由实际的项目充实流程写入，而不是 compiler 自己猜测。

推荐：

1. Git full index 完成时：
   - 项目根 `manifest_status=pending`；
   - 保留结构 sync 与 semantic manifest 状态的区别。
2. `wiki-enrich`：
   - 明确先读取项目 README、package/构建配置、主要目录摘要；
   - 更新项目根 `goals/stack/entrypoints/modules/risks/constraints`；
   - 再递归充实文件/目录；
   - 完整成功后设置 `manifest_status=ready`。
3. `wiki-stale-sync`：
   - changed nodes 可能影响项目根 manifest 时，重新计算相关字段；
   - 失败不能把 manifest 标成 ready。
4. UI：
   - 至少显示 manifest 状态；
   - 若允许人工维护，提供结构化表单或明确的 JSON attributes 编辑入口；
   - 不把“未生成”显示成 semantic fresh。

项目 Wiki 仍不得复制 README/源码正文，只保存概括和源路径引用。

### 5.3 必须新增的测试

1. 新绑定、只完成结构索引的项目：
   - Project Prompt 显示 manifest pending；
   - 不得声称所有语义信息已完成。
2. 执行受控 enrichment fixture 后：
   - 项目根 attributes 实际写入；
   - runtime Prompt 出现真实 goals/stack/entrypoints/modules/risks/constraints；
   - preview 与 runtime 字节一致。
3. 模拟 enrichment 失败：
   - manifest 仍 pending/partial；
   - UI 与 Prompt 都可见。
4. Git 新增/修改入口文件后：
   - stale/manifest 状态正确；
   - 重新充实后恢复 ready。
5. 不允许通过在测试中直接 seed attributes 来替代生产写入路径验收。

## 6. P1：关键 E2E 门禁未通过且仍有关键 skip

### 6.1 可复现失败

命令：

```bash
npx playwright test \
  tests/e2e/wiki-browser.spec.ts \
  tests/e2e/wiki-management.spec.ts \
  tests/e2e/wiki-fresh-env.spec.ts \
  tests/e2e/p8-wiki-and-agent-config.spec.ts
```

本轮结果：exit 1。

稳定复现：

```text
§G.5 multi-project binding + project:// grant preview
Expected project2.id in syncedProjects
Received only project1.id
```

原因在测试 helper `bindAndIndex()`：

```ts
const entry = list?.result?.repositories?.[0];
```

第二次绑定项目时仍检查列表第一项。第一项目已经 synced，循环会提前结束，第二项目可能仍 pending。

### 6.2 测试修复要求

等待逻辑必须按目标项目查找：

```ts
const entry = repositories.find((r) => r.projectId === projectId);
```

并且：

- 仅在目标项目 `synced` 时成功返回；
- `failed` 立即抛出并带 `lastError`；
- 超时错误打印目标 projectId、最后状态、indexed/head revision；
- 不用固定 sleep 代替状态轮询；
- cleanup 放入 `finally`，断言失败时也清理临时仓库。

### 6.3 关键 skip

当前至少还有：

- G4：running session policy publish StepEnd；
- G5：active project switch StepEnd；
- fresh-env Agent Wiki tool call；
- fresh-env Git rename + sync。

其中 G4/G5 被 integration fixture 覆盖，但前序复审的明确通过条件是“关键 E2E 不再跳过 G4/G5”。当前有两种合法选择：

#### 选择 A：补真实 E2E（推荐）

建立可控的测试 provider/blocking tool fixture，从 REST/UI 发起真实 session：

```text
start agent step
→ first tool call blocked
→ publish policy / switch project
→ assert current call old snapshot
→ release StepEnd
→ next tool call / prompt new snapshot
→ assert no old project residue
```

#### 选择 B：修改验收契约

如果团队决定运行时 integration 比 Playwright 更合适，必须先由用户确认，然后同步修改：

- `acceptance-final.md`
- `acceptance-recommendations.md`
- `result-final.md`

明确说明为什么 integration 等价，以及哪些 UI/REST 接线仍由 E2E 覆盖。不能在保留“关键 E2E 不得 skip”的同时，把 `test.skip` 描述为已满足。

fresh-env 的 Agent Wiki tool call 和 Git rename + sync 也应实现，或在最终证据中逐项说明经批准的替代测试，不得只留下空 `test.skip`。

### 6.4 必须执行

修复后运行：

```bash
npm run test:e2e
```

不仅运行四个筛选文件。最终结果必须列出：

- passed；
- failed；
- skipped；
- 每一个 skip 的用例名与非阻塞理由。

## 7. P2：计划、实现和最终报告对齐

### 7.1 Backup ownership

实现已经选择：

```text
DatabaseManager
  → DB handle/path authority

BackupService
  → snapshot/manifest/verify/restore mechanism owner
```

这是可以接受的单 owner 设计，但 `plan-00-database-foundation.md` 仍锁定：

```text
DatabaseManager.backupCore
DatabaseManager.backupWiki
```

应二选一：

- 推荐：更新 Plan 00 和相关说明，正式采用 BackupService 单 owner；
- 或恢复并真正实现 manager 的锁定接口。

不要保持“计划锁定 manager 方法、测试锁定方法不存在”的双重契约。

若采用 BackupService 单 owner，还应考虑把生产必需的路径依赖改成 required，减少 `deps.x ?? globalConstant` 的软约束。

### 7.2 清理过期注释

`tests/e2e/wiki-management.spec.ts` 的 G4 注释仍声称 policy publish 会 mid-step 直接 apply，与当前修复后的实现相反。更新注释，使它描述现行 StepEnd 语义。

### 7.3 重新生成 result-final

当前 `result-final.md` 不再是本轮实际证据：

- 声称关键 E2E 通过，但本轮可复现失败；
- 声称 G4/G5 已满足，但仍是 `test.skip`；
- 声称设计/实现完全一致，但 backup plan 未同步；
- 链接数量写 780，本轮实际为 784；
- 未列出本轮发现的 config queue loss、前 100 候选偏置和 Project manifest writer 缺失。

只有所有修改和门禁完成后才能重新生成。新报告必须包含：

1. 精确 HEAD SHA，而不是“本轮末端”。
2. 实际执行命令。
3. 每个命令的 exit code、pass/fail/skip 数量。
4. 所有 skip 名称和批准依据。
5. 00–08 result 文档链接。
6. 100k/1M benchmark 的 commit SHA 与当前 HEAD 差异说明。
7. 已知限制及其是否阻塞发布。
8. 与 plan 的任何偏差和用户批准记录。

## 8. 完整重新验收命令

建议按以下顺序执行：

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run test:unit
npm run build
npm run check:links
npm run test:e2e
git diff --check
git status --short
```

另执行定向回归：

```bash
npx vitest run \
  tests/unit/wiki-v2-runtime-session-boundary.test.ts \
  tests/unit/wiki-v2-context-compiler.test.ts \
  tests/unit/wiki-v2-p1-5-semantic-sync.test.ts \
  --pool=forks --maxWorkers=1

npx playwright test tests/e2e/wiki-management.spec.ts \
  --grep "multi-project binding|StepEnd|active project"
```

若修改了 context candidate SQL，应重新运行 100k/1M benchmark，并增加：

- 100/1,000/100,000 direct-child selection；
- high-priority tail candidate；
- workContext tail candidate；
- query plan；
- query count；
- Prompt 编译耗时。

## 9. 最终通过标准

只有同时满足以下条件，第二轮复审才可改为 PASS：

- pending config patches 不丢字段，且保持 StepEnd snapshot 不变量；
- 第 101 个以后高价值 Memory/Project 节点有公平入选机会；
- Project 结构字段存在生产写入路径，真实 runtime Prompt 不依赖测试手工 seed；
- 四组定向 E2E 和完整 `npm run test:e2e` 成功；
- G4/G5 不再关键 skip，或验收契约已经用户明确批准修改；
- 其余 skip 均有逐项非阻塞说明；
- Plan 00 backup 契约与实现一致；
- `result-final.md` 与精确 HEAD 和实际命令结果一致；
- 两次完整 unit suite 全绿；
- 工作树只包含预期文档/实现变更，无临时测试产物。

在此之前，统一状态应为：

```text
CHANGES REQUIRED
```

## 10. Round-2 fix resolution (2026-07-19, user-approved Choice B)

> 本节为修复记录追加，**不修改** §1–§9 的原始复审文本。仅记录 §6.3「关键 skip」
> 在用户批准的 Choice B 之下的具体落地。

用户于 2026-07-19 批准 Choice B：**G4/G5 时序不变量由 runtime integration 负责；
REST/UI publish/绑定/preview 接线由 Playwright 负责；fresh-env 两 skip 映射到
tool-wiring + wiki-management §G.1 并已加强断言。** 不新建 blocking-tool E2E
harness（Choice A 已否决）。

### 10.1 删除的 4 个 `test.skip` 与接管测试

| 删除的 skip | 接管测试 | 接管方式 |
| --- | --- | --- |
| `wiki-management.spec.ts §G.4 running session applies new revision only at StepEnd boundary` | `tests/unit/wiki-v2-runtime-session-boundary.test.ts` › `§G.4 — running session applies new revision at safety boundary` + `§G.4 (multi-tool-call-per-step) — single step keeps one revision` + round-2 §3.5 mid-tool-call multi-enqueue merge | 真实 AgentLoop + latch-blocked Block tool，精确卡 tool call 中段，断言 in-flight vs next-step CallerCtx 的 policyRevision 差异 + 单 step 多 tool call 共享同一 revision |
| `wiki-management.spec.ts §G.5 runtime: switching active project mid-session reframes Wiki Prompt at step boundary` | `tests/unit/wiki-v2-runtime-session-boundary.test.ts` › `§G.5-runtime — active project switch at safety boundary` | 同 fixture；sendProjectPrompt 切 projectB，断言 in-flight 仍 projectA、next-step 切到 projectB、无 projectA 残留、enqueueConfigPatch + StepEnd flush 边界保持 |
| `wiki-fresh-env.spec.ts Agent Wiki tool call` | `tests/e2e/tool-wiring.spec.ts` 的 `TOOL_CASES` 循环 | 真实 `zero` agent + mock provider 端到端走完 tool-factory + callerCtx + Wiki tool 路径 |
| `wiki-fresh-env.spec.ts Git rename + sync` | `tests/e2e/wiki-management.spec.ts` › `§G.1 runtime:// resolves to renamed target's new canonical path` | 真实 git 仓库 `git mv` + commit + `/api/wiki-admin/repositories/reindex` + 等待 sync 完成（§10.3 加强断言） |

每个删除点都保留一段注释块，显式说明接管测试的位置与覆盖粒度，**未留下空
`test.skip` stub**。同时更新 `wiki-management.spec.ts` 头部注释中关于
「complex running-session 阻塞 tool call 用 test.skip + 注释」的过期描述为
「时序不变量归 integration / REST/UI 接线归本 spec」的 Choice B 划分。

### 10.2 tool-wiring Wiki 断言加强

`tests/e2e/helpers/tool-evaluator.ts` 的 `Wiki` TOOL_CASE 由「`search` 不报错即
pass」加强为：

- `args`: `{ action: "expand", node: "memory://" }`（命中 agent 自身 memory root）
- 断言：
  1. `looksLikeError` 守卫（保留）；
  2. **正向断言** result 必须引用 memory root —— 解析 JSON 取 `path` / `data.path`
     含 `/memory`，或文本中出现 `/memory` / `memory://`；不满足即 fail。

seed node 选择依据：`zero` agent 拥有 `wiki-root` 全树 grant
（`DEFAULT_GRANTS_ZERO_ADMIN`）；`memory://` 由 `wiki-access-compiler` 解析为
`wiki-root/memory/<stable-agent-id>`；fresh-db-seed 的 `instantiateRole("zero")`
幂等调 `WikiService.ensureAgentMemoryRoot(zero.id, "zero")` 建该节点
（`management-service.ts:520`），session build 时再次幂等 ensure
（`agent-service.ts:652`）。故测试运行时该节点结构性存在，不依赖 plan-08 §1
cutover 删除的 software-dev seed 子树。

### 10.3 wiki-management §G.1 rename-sync 断言加强

在原 runtime:// 别名稳定性断言之后追加两道新断言，证明 Git rename 真正同步进
wiki 树（覆盖删除的 fresh-env "Git rename + sync" skip）：

1. **NEW path 节点可达**：`/api/wiki/read { address: newPath }` 返 HTTP 200 命中
   path 含 `runtime` 的活跃节点（带 15s 重试；用 read 而非 search,避免 FTS 分词
   噪声）；
2. **OLD path 节点不再可达**：`/api/wiki/read { address: appPath }` 返回 HTTP 400
   且 `error.code === "NOT_FOUND"`（rename = 移动，不是复制；旧 canonical path
   不得作为活跃节点残留）。

### 10.4 acceptance-final §G 所有权注记

`acceptance-final.md` §8 之后新增 §8.1，明文写出 G4/G5 时序不变量归 runtime
integration、REST/UI publish/绑定/preview 接线归 Playwright，并给出具体测试文件
与 case 名。

### 10.5 §1–§9 原文未改动

本节是 append-only 的修复落地记录；§1–§9 的原始复审文本、判定、修改顺序、最终
通过标准全部保留原貌。本节不构成对 §9 通过标准的自动满足——仍需按 §9 逐项复核
（其余 P1：§3 config queue、§4 context compiler、§5 project manifest 由各自
修复闭环）。
