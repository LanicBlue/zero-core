# Wiki v2 最终验收建议

> 验收日期：2026-07-18  
> 验收基线：`worktree-wiki-redesign` / `3d514aee4632fcc2baea185eafdb60fd59eb62f7`  
> 依据：[design.md](./design.md)、[acceptance-final.md](./acceptance-final.md) 及 Plan 00–08  
> 当前结论：**FAIL — 不应按“完全符合设计”合并或发布**

## 1. 总体判断

Wiki v2 的主体架构已经建立：

- Wiki 数据独立存储在 `wiki.db`，与 `core.db` 分离。
- 固定 `wiki-root/knowledge`、`wiki-root/memory`、`wiki-root/projects` 命名空间。
- Agent 使用 canonical path 或逻辑地址，不接触 Wiki 内部整数 ID。
- Wiki data plane、management plane、maintenance plane 已分离。
- Agent Wiki tool 已提供 `expand/read/search/create/update/delete/link/unlink/move`。
- 权限来自 Agent 配置中的 subtree grants，Prompt context 与 grants 分离。
- Project Wiki 使用 Git tracked tree 建立 source-bound 语义镜像。
- UI、备份恢复、文件系统旁路保护和百万节点 benchmark 已有实现与证据。

但最终验收要求 A–J 全部通过，并要求实现、Prompt、UI、测试和架构文档一致。当前仍存在两个阻塞级实现偏差，以及测试门禁、数据库生命周期接口和 legacy/documentation 收尾问题，因此不能接受现有 `result-final.md` 的 PASS 结论。

## 2. P0：忙碌会话的策略发布必须改为 StepEnd 应用

### 2.1 当前偏差

设计要求：

- idle session 可以立即交换 compiled snapshot。
- busy session 的 grants/context/address/project 变更只能排队。
- 队列只能在 `StepEnd` 安全边界 flush。
- 同一个 step 内不得混用两个 policy/context revision。

当前 `AgentService.setAgentStore()` 的 `store.onChange` 回调对 busy loop 直接调用 `loop.applyConfigUpdate()`。`publishAgentWikiPolicy()` 又通过 `agentStore.update()` 触发该回调，因此发布发生时：

1. 已经构建 CallerCtx 的在途工具调用继续使用旧 snapshot。
2. `loop.config.wikiAccess` 在 tool call 中途已经被替换。
3. 同一步稍后构建 CallerCtx 的工具调用可能使用新 snapshot。
4. `pendingConfigPatches` 没有记录这次发布。

相关位置：

- `src/server/agent-service.ts`：`setAgentStore()`、`publishAgentWikiPolicy()`。
- `tests/unit/wiki-v2-runtime-session-boundary.test.ts`：测试已经明确记录“publish mid-call 直接修改 loop config”。

### 2.2 建议修复

所有可能影响运行中 SessionConfig 的 AgentRecord 更新都应经过一个统一入口：

```text
AgentRecord changed
→ compile next SessionConfig patch
→ session idle?
   ├── yes: apply immediately
   └── no: enqueueConfigPatch
             → StepEnd
             → flushPendingConfigUpdate
```

不要只在 `publishAgentWikiPolicy()` 内特殊处理，因为 UI Agent 编辑、AgentRegistry、memory archive、逻辑地址发布和未来配置面同样可能触发 `AgentStore.onChange`。

建议：

1. `store.onChange` 只负责计算 patch。
2. 对每个 loop 调用统一的 `enqueueConfigPatch(sessionId, patch)`。
3. `enqueueConfigPatch` 内部判断 idle/busy。
4. busy 时禁止直接调用 `applyConfigUpdate`。
5. `affectedSessions[].applied` 必须真实反映“已应用”或“等待 StepEnd”，不能通过空 pending queue 误报 applied。

### 2.3 必须补充的验收

- busy loop 发布后、释放阻塞工具前：
  - `loop.config.wikiAccess.policyRevision` 仍为旧值。
  - `pendingConfigPatches` 至少包含一条 patch。
  - `affectedSessions[].applied === false`。
- 第一个工具调用结束但 StepEnd 尚未 flush 时仍为旧值。
- StepEnd 后下一工具调用使用新 revision。
- 同一个 model step 返回多个工具调用时，整个 step 使用同一 policy revision。
- active project 切换、grants publish、context publish、address revision、memory archive 使用相同边界语义。

此问题修复前，`acceptance-final.md` §G 与 §14 不得标记通过。

## 3. P0：重做 Wiki Context Compiler 的选择与渲染

### 3.1 当前偏差

当前 compiler 主要返回根摘要和最多 100 个一级子节点：

- `compact/standard/deep` 基本只改变 token budget，没有不同的选择深度。
- `workContext` 没有参与相关性选择。
- 所有一级节点的 `childrenCount` 被硬编码为 0。
- 根 `content` 被读取但未渲染。
- confidence 只参与排序，不用于过滤。
- `review_after`、过期 `task_state` 没有处理。
- snapshot total 只等于当前第一页长度，dropped count 不代表真实子树规模。
- snapshot revision 混用了节点 revision 和 `updated_at` 时间戳。
- Project section 不保证包含目标、技术栈、入口、模块、revision、sync status、风险和当前工作。

默认 Git indexer 生成的项目根摘要只有 branch、commit 和文件/目录数量；文件摘要只有 source kind、扩展名和路径。因此不能依赖默认 summary 自然满足丰富 Project Prompt。

### 3.2 建议的数据来源

Project Context 应组合两类来源，而不是只遍历 Wiki 一级 children：

```text
Wiki project root semantic fields
  ├── summary/content/attributes
  ├── curated goals / stack / entrypoints / modules
  └── risks / constraints / recent changes

Repository binding/status
  ├── branch
  ├── indexed_revision
  ├── HEAD
  ├── sync_status
  └── last_error
```

Memory Context 应读取：

- 根 summary 与稳定规则 content。
- permanent/long_term 节点。
- preference/procedure/experience 的代表节点。
- 与当前 Agent role/work/requirement 相关的近期节点。
- 必要的一级导航和有限二级候选。

### 3.3 建议的筛选规则

先过滤，再排序：

1. 排除已经 archived 的节点。
2. 排除明确过期的 `task_state`。
3. `review_after` 已到期的内容降级为候选，不应无条件注入。
4. 低 confidence hypothesis 默认不进入 compact/standard；deep 可在预算允许时以“不确定”标记加入。
5. 当前 work/requirement 命中的节点提高优先级。
6. 使用稳定 tuple 排序，最后以 canonical path 打破并列。

建议明确 profile：

| Profile | Memory | Project |
|---|---|---|
| compact | 根稳定规则 + 少量永久记忆 | 项目目标、sync、入口 |
| standard | 高价值长期记忆 + 一级导航 | 目标、stack、入口、模块、风险、当前工作候选 |
| deep | standard + 有界二级展开 | standard + 关键模块二级候选与 recent changes |

### 3.4 必须补充的验收

- 构造包含低 confidence、过期 `task_state`、到期 `review_after` 的 Memory fixture，验证 standard 不无条件注入。
- compact/standard/deep 在相同数据上产生不同但确定性的节点集合。
- Project Prompt 显式断言目标、技术栈、入口、模块、revision、sync status、风险或明确空状态。
- root content 中的稳定规则确实进入 Prompt。
- `workContext` 改变后，相关节点排序发生预期变化。
- 超过 100 个一级节点时，total/dropped count 与数据库真实数量一致。
- preview 与 runtime 对相同 snapshot 字节级一致。

此问题修复前，`acceptance-final.md` §C、§D 与 §14 不得标记通过。

## 4. P1：恢复全量测试门禁

### 4.1 当前结果

本次独立执行：

| 命令 | 结果 |
|---|---|
| `npm run build:lib` | PASS |
| `npm run build` | PASS |
| `npm run typecheck` | PASS |
| `npm run check:links` | PASS |
| 4 组 Wiki 关键 E2E | 27 PASS / 4 SKIP |
| `npm run test:unit` | **FAIL：7 files / 9 tests** |

将超时测试分组单独重跑后均通过，说明大部分失败来自全量并发下的 timeout/flakiness；但 `wiki-v2-sub08-spec.test.ts` A7 单独运行仍稳定失败。

### 4.2 A7 测试与 Prompt 残留

A7 使用过宽的：

```text
header:|intent:|structure:
```

扫描整个 `src/`，会误报：

- CSS class 中的 `-header:hover`。
- AskUser 普通 `header` 字段。

同时 Archivist prompt 中确实残留：

```text
intent:no-recorded-reason
```

建议：

1. 从 Archivist prompt 删除 legacy `intent:` provenance 词汇，换成普通 attributes，例如 `reason_status: unrecorded`。
2. A7 只扫描 TypeScript/TSX 中构造 legacy provenance 值的字符串或写路径。
3. 测试应验证“不能生成/解析 legacy prefix”，而不是禁止所有自然语言 `header`。

### 4.3 全量 timeout

不应仅通过提高所有测试的全局 timeout 掩盖问题。建议先确认：

- 是否有多个测试并行启动真实 server/Electron。
- 是否共用端口、全局 singleton 或相同临时目录。
- 是否存在未关闭 DB/server/process handle。
- 是否应把重型 integration fixture 放入单独 pool 或限制 worker 数。

最终 release gate 必须是默认 `npm run test:unit` 连续至少两次通过，而不只是失败文件单独运行通过。

## 5. P1：确定数据库备份的唯一所有者

### 5.1 当前偏差

Plan 00 锁定了：

```ts
backupCore(dest)
backupWiki(dest)
```

但 `DatabaseManager` 中这两个方法仍抛出 `WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00`。实际可用备份由 `WikiBackupService` 独立打开数据库并调用 SQLite Backup API 完成。

因此当前状态是：

- 产品备份功能可用。
- DatabaseManager 公共契约不可用。
- 测试仍在断言 Plan 00 占位行为。
- 生命周期/备份所有权与计划描述不一致。

### 5.2 建议

应选择并文档化一个唯一方案：

**推荐方案：**

- `DatabaseManager` 继续负责数据库路径与活动 handle 生命周期。
- Backup service 负责异步 snapshot、manifest、hash、rotation 和 restore。
- 将 manager 的备份契约改成真实可实现的异步接口，或明确从锁定接口中删除。
- Backup service 不应重新硬编码 `coreDbPath/wikiDbPath`；通过 manager 获取受控路径/handle。

不要为了保留同步 `string` 返回类型而实现伪同步 backup。若 SQLite Backup API 是异步的，应一次性修改计划、类型、实现和测试为同一真实契约。

验收应证明：

- manager/backup service 之间只有一个数据库路径事实源。
- Core/Wiki backup 各自独立。
- 活动 handle 不被直接文件复制。
- snapshot 可打开并通过 integrity/FK 检查。
- 失败不会返回 `wiki: null` 的假成功。

## 6. P1：Project 语义同步状态需要显式区分

当前 Git indexer 正确承担结构同步：

- add/create node。
- modify 更新 binding 并标记 `source_stale`。
- rename 保持内部 identity。
- delete/archive。
- 不覆盖 curated summary/content/links。

语义充实由 Archivist/enrichment prompt 负责。这种两阶段模型可行，但 UI 和验收必须明确：

```text
structure_sync_status
  = Git tree/binding 是否同步

semantic_sync_status
  = changed/stale 节点是否已经被 Agent 重新总结
```

否则项目可能显示 `synced`，但 summary/content 仍是旧内容或启发式路径摘要，Agent 会误以为项目语义已更新。

建议：

- commit 成功后必须完成结构 sync。
- changed nodes 进入 semantic enrichment queue。
- Project UI 显示 stale semantic node count。
- Archivist 只处理 changed/stale 节点及必要祖先。
- semantic enrichment 失败不回滚 Git，但必须保持可见的 stale/failed 状态。
- Project Prompt 对 stale summary 加显式提示。

## 7. P1：清理 compatibility shim 与失真 API

### 7.1 WikiSkeletonService

当前生产 composition root 仍实例化 `WikiSkeletonService` shim：

- `ensureSummary()` 永远返回 `undefined`。
- `detectDivergence()` 永远返回空 report。
- `projectSubtreeRootId()` 返回旧式合成 ID。
- `/api/archivist/:projectId/divergence` 因此会返回看似成功的空结果。

建议：

- 生产 caller 直接依赖 `WikiProjectIndexer`、`WikiService` 和 `ArchivistGit`。
- 删除 shim 后再删除 legacy 路由。
- 若 divergence 功能暂不实现，API 应返回明确的 `501 NOT_IMPLEMENTED`，不能返回伪成功空报告。

### 7.2 WikiDatabase re-export

`src/server/wiki-database.ts` 自己声明 clean cutover 后应删除，目前仍保留。应将测试和生产 import 全部切换到：

```text
src/server/wiki/wiki-database.ts
```

然后删除 shim。

## 8. P1：重写架构文档并扩大链接检查

当前部分架构文档虽然在顶部添加了 Wiki v2 警告，正文仍把以下对象描述为活动实现：

- `WikiStore`
- `ProjectWikiStore`
- `WikiScanCursorStore`
- `wiki-node-store.ts`
- `project_wiki`
- `header:/intent:/structure:` provenance
- 磁盘 Markdown 正文镜像

建议：

1. 活动架构文档只描述 Wiki v2。
2. v0.8 旧实现移入单独 `docs/history/`，不要在当前模块说明中交叉叙述。
3. 删除指向已删除 `.ts` 文件的链接。
4. `check-doc-links.cjs` 不应只验证 `.md` 链接；至少同时验证 docs 中相对链接指向的源码、JSON 和目录是否存在。
5. 搜索并清理仍将 `project_wiki` 称为唯一知识主线的段落。

重点文件：

- `docs/arch/02-module-structure.md`
- `docs/arch/05-persistence.md`
- `docs/arch/06-knowledge-subsystems.md`
- `docs/basic/backend-structure.md`

## 9. 更新最终验收报告

现有 [result-final.md](./result-final.md) 已不再反映 HEAD：

- 仍声称 1M benchmark 尚未运行，但 `bench-1m.json` 已存在。
- 仍声称 G4/G5 running-session fixture 尚未补充，但 unit fixture 已存在。
- 声称安全刷新只发生在 idle/StepEnd，但新测试证明 policy publish 会 mid-call apply。
- 声称架构文档一致，但当前仍有大量活动/历史描述混杂。

不要直接修改结论为 PASS。应在上述问题修复并复验后重新生成报告，至少记录：

- 验收 HEAD commit SHA。
- 实际执行的完整命令。
- PASS/FAIL/SKIP 数量。
- 所有 skip 的阻塞性判定。
- 1M benchmark commit、硬件、命令和关键延迟。
- 已知限制与 SLA。
- 验收者与实现者独立性的说明。

## 10. 建议修复顺序

```text
1. StepEnd policy/context publication
2. Context compiler richness/filter/profile
3. Full unit gate + A7 cleanup
4. Database backup ownership/contract
5. Project semantic-sync status
6. Remove compatibility shims and false-success APIs
7. Rewrite architecture docs and link checker
8. Re-run all acceptance commands
9. Regenerate result-final.md
```

前两项完成前，不建议让其他 Agent 并行做文档 PASS 宣告，因为实现语义仍可能变化。

## 11. 最终复验命令

最低自动门禁：

```powershell
npm run typecheck
npm run build:lib
npm run build
npm run test:unit
npm run check:links
npx playwright test tests/e2e/wiki-browser.spec.ts tests/e2e/wiki-management.spec.ts tests/e2e/wiki-fresh-env.spec.ts tests/e2e/p8-wiki-and-agent-config.spec.ts
git diff --check
git status --short
```

还必须增加或保留以下专项测试：

- busy session grants/context publish 的 StepEnd 原子边界。
- 同 step 多工具调用不混用 policy revision。
- compact/standard/deep Prompt fixture。
- low-confidence/review_after/expired Memory fixture。
- 标准 Project Prompt 完整字段 fixture。
- 100+ 一级节点的真实 total/dropped count。
- semantic stale 状态与 Project UI/Prompt。
- DatabaseManager/BackupService 唯一所有权。
- 无 compatibility shim、伪成功 legacy API 和失效源码链接。

## 12. 建议最终通过标准

只有同时满足以下条件，才建议把结果改为 PASS：

- P0 两项全部关闭。
- 默认全量 unit test 连续两次通过。
- 关键 E2E 不再跳过 G4/G5；其余 skip 有明确非阻塞依据。
- Project Prompt 和 Memory Prompt 满足 `acceptance-final.md` 的真实内容要求，而不是只出现根路径和一级节点。
- DatabaseManager 与 backup service 契约一致。
- 项目结构同步和语义同步状态可区分。
- legacy shim/伪成功 API 被删除或明确返回未实现。
- 活动架构文档只描述 Wiki v2。
- `result-final.md` 与当前 HEAD、测试结果和 benchmark 证据一致。

在此之前，建议状态统一标记为：

```text
Implementation: substantially complete
Final acceptance: FAIL
Release readiness: blocked
```
