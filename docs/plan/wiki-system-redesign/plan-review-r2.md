# Plan Re-Review (round-2): wiki-system-redesign

- **日期**:2026-07-16
- **评审人**:独立 re-reviewer(非修订作者)
- **方法**:5 个并行 agent 核验修订——R1(B1 plan-05 hook)/ R2(B2/B3 plan-00+08)/ R3(B4/B5/B6 plan-01+design)/ R4(跨文档一致性 22 文档)/ R5(代码库新假设);每条 skeptical,只认文档实际文字 + 代码现实,不信 [plan-review-resolution.md](./plan-review-resolution.md) 自述。
- **结论**:✅ **PASS** —— 6 组 blocker 全 RESOLVED,跨文档 CONSISTENT,代码库新假设无一为假。可进入实施。
- **唯一显著 watch-item**:sub-00 的 `SessionDB`→`CoreDatabase` 类改名是 **50 文件 186 处**(plan-00 §2 已列范围+禁别名,但「改名」二字严重低估)—— 见下「sub-00 范围警示」。

---

## 1. Blocker 裁决

| Blocker | round-1 | round-2 裁决 | 关键证据(修订后) |
|---|---|---|---|
| **B1** plan-05 hook | NOT-RESOLVED | ✅ **RESOLVED** | plan-05 §7(L143-148)钉死:agent-service 构 `config.wikiContextSystemSection` 闭包注入;AgentLoop 三禁令(不 import compiler / 不出现字面段名 / 不 wiki 专用 invalidate / 不引用已删 PostTurnComplete);五触发源经 config-sync + StepEnd hook。acceptance-05 §D(L40-44)有 **grep 级 absence + wiring(防 dead-path 假阳性)+ E2E spec**。 |
| **B2** 独立 wiki.db 手术 | NOT-RESOLVED | ✅ **RESOLVED** | 新增 plan-00 DatabaseManager(独立 connection/migration/WAL/checkpoint/backup/close);plan-01 §1(L46-47)钉死 ready-order(wiki.db 先于 agent-service/recovery,锁住 race 面);design.md:119 重申跨库应用层协调。残留:DatabaseManager interface 草图偏 core-only,plan-01 需补对称方法(非阻断)。 |
| **B3** project_wiki 启动写入 | NOT-RESOLVED | ✅ **RESOLVED** | plan-08 §1 显式按名列出 db-migration.ts 全部 4 处启动写入(464-489/509-/717/821,逐一与源码核对一致)+ index.ts ensureWikiSkeleton/rebuildStaleStructureLayouts/WikiSkeletonService + data-change-hub 广播 + renderer 订阅;acceptance-08 §A 提供 fresh-DB 缺表 / 启动前后 schema·count 不变 / subscriber runtime 不可达三类可执行断言。残留:清单漏 2 个次要点(见 §3)。 |
| **B4** SQLite TEXT 亲和 | NOT-RESOLVED | ✅ **RESOLVED** | plan-01 §6(L141)禁 `SqliteStore<T>`、要求裸 DDL;acceptance-01(L20)**双重断言**:`PRAGMA table_info` 证 INTEGER 亲和 + revision 算术不字符串拼接(超出 round-1 建议)。 |
| **B5** 跨 sub 契约 | NOT-RESOLVED | ✅ **RESOLVED** | plan-01 §4(L104-111)贴出完整 **20-code WikiErrorCode 枚举**,design §8.10 逐字对齐,sub-02/03/04/acceptance-final 全部 in-enum 引用(无越界);auditId 改为 `audit_id TEXT` opaque receipt(结构性不再是整数 PK),三处文档划清 auditId/业务 ID/内部 PK;design §4.1/§7.1 统一**稳定业务 ID 路径段 + display_name 仅 attributes + rename 不移子树**。 |
| **B6** archived UNIQUE | NOT-RESOLVED | ✅ **RESOLVED** | design §5.1(L212-215)+ plan-01 §2(L64)改 **active partial unique `WHERE archived_at IS NULL`**,表级永久 UNIQUE 禁用;acceptance-01(L15)三条可执行测试:失败测试 + 同路径重建 + restore 冲突。 |

---

## 2. 代码库新假设核对(R5)—— 无一为假

| 修订假设 | 代码现实 | 裁决 |
|---|---|---|
| knowledge.db 退役(精确删除) | src/ **零运行时引用**(仅 docs + scripts/build-codegraph.ts 陈旧注释);磁盘 `~/.zero-core/knowledge.db{,-wal,-shm}` 是真孤儿;db-migration.ts:1193-1194 已 DROP kb_* 表 | ✅ 前提为真 |
| sessions.db→core.db 文件改名 | 功能性引用仅 [session-db.ts:107](../../../src/server/session-db.ts#L107) 1 行(+注释/字符串) | ✅ 文件改名 = 1 行 |
| DatabaseManager 多 DB 管理 | 服务端**无任何现成多 DB 基础设施**(仅 session-db.ts:108 一处 `new Database()`;WikiStore 复用 SessionDB 句柄;session-manager.ts:30 注释「无第二个连接」) | ✅ 诚实标「新增」,但属全新造 |
| project_wiki 4 处启动写入 | 复核 db-migration.ts:464-489/511/716-717/821 + index.ts:329/665 + data-change-hub.ts:48,与 round-1 所述一致 | ✅ |
| hook/inline(B1) | 复核 agent-loop.ts:269-296 内联建段、:956/:1488 内联 invalidate、PostTurnComplete 已删、StepEnd 每步触发(:2193/:2223) | ✅ 现状如所述 |

### 🔶 sub-00 范围警示(唯一显著 watch-item,非阻断)
`SessionDB`→`CoreDatabase` **类改名是 50 文件 186 处出现**(每个 store 构造参数类型都是它:`agent-store`/`archive-service`/`compression-core`/`cron-store`/.../`wiki-node-store`/`wiki-scan-cursor-store` 等 + runtime/hooks/core/CLI),3 处生产实例化(index.ts:123 / cli.ts:180 / agent-service.ts:265)+ 单例 `getSessionDB/setSessionDB`。plan-00 §2 **已列范围 + 禁别名**,所以不是「沉默假设错误」,但「改名」二字严重低估,漏一处 `import type { SessionDB }` 就编译挂。**建议**:sub-00 implementer 把类改名当独立的机械任务 + compile-gate 全覆盖;sub-00 的 3 方向验收里「架构约束」方向必须断言全仓无残留 `SessionDB` 引用。

---

## 3. 跨文档一致性(R4)—— CONSISTENT

9 维全 PASS,无硬冲突:
- design §14 与 README §2 阶段表对齐(00–08),contract ownership 明确(path normalizer→plan-01 / 地址解析→plan-02 / 授权→plan-02 / DatabaseManager→plan-00)。
- 依赖链 00→…→08→FINAL 在所有文档一致(逐 sub 核对 `## 依赖` 段),无循环/漏依赖;原依赖 01 的 sub 经 WikiDatabase/CoreDatabase 隐式继承 plan-00。
- sessions.db/SessionDB 旧名在 22 文档中**全部是有意的迁移/历史上下文**,无任何文档把它当改名后的当前名。
- CallerCtx.wikiAccess:plan-04 定义 / plan-05 注入,签名一致(`CompiledWikiAccess`);现有 [types.ts:268-379](../../../src/tools/types.ts#L268) 确认无 wikiAccess 字段、有 legacy wikiAnchorNodeIds,与 plan-04 §2 声明吻合。
- WikiService public API:plan-02 §1 给完整 TS 签名,plan-04 delegate 签名匹配;indexer 作 source-binding 的 trusted owner(design §6.3)三处一致。
- links 模型自洽:Agent 可见 links 但暴露 canonical path/地址,**绝不**整数 ID;B5b 三层区分(audit_id TEXT / 业务 ID 路径段 / 内部整数 PK)在全部文档一致。
- **acceptance-final 升级**:round-1 缺的 6 个 e2e 场景(在途 publish 安全边界 / 运行中 project switch / ProjectWikiStore runtime legacy absence / 双 DB 独立运行时断言 / 删最后 grant→`[]` / move 双 parent UI)全部补成**脚本化场景 + 具体断言 + 引用 e2e spec 文件**,非退化 checkbox。
- plan-review-resolution.md §3 的 **18 条声称全部落地**(逐条可追溯到文档正文),无「声称处理但文档没落地」。
- 共享契约(WikiErrorCode 20 码 / WikiNodeKind 10 类 / WikiAction 9 / regex·ripgrep·move 限额 / FTS 字段 / view·target·mode 枚举 / profile budgets / PostTurnComplete→StepEnd / DynamicSystemSection / partial unique)在 design/plan/acceptance **逐字对齐**。

---

## 4. 非阻断清理项(implementer 注意,不阻塞实施)

> **更新(2026-07-16):本节「进 sub-00/sub-01 前明确」5 项 + sub-00 改名范围警示已应用到 plan-00/02/08(随本次 re-review 一起提交)。下方「implementer 落地注意」项仍留作编码时留意。

**建议进 sub-00 / sub-01 前明确(R3/R2):**
- [ ] **N1** plan-02 §1 WikiService 接口无 `restore`,但 acceptance-01 要求测「restore 冲突被拒绝」 → plan-02 显式声明 restore 走 admin 还是 update 子操作。
- [ ] **N2** `DATABASE_LAYOUT_CONFLICT`(plan-00/acceptance-00)是 DatabaseManager 启动错误码,不在 plan-01 WikiErrorCode 枚举 → plan-00 显式列 DatabaseManager 错误码闭集或声明「本阶段仅此一个,非共享」。
- [ ] **N3** plan-02 地址管理 API 错误码未钉(循环/重复/越界映射到哪个枚举值) → plan-02 §2 补映射表。
- [ ] **plan-08 cutover 清单补 2 点名**:`project-work-hook-manager.ts:6`(server 订阅者)+ `ProjectPage.tsx:919`(UI `<option value="project_wiki">`)。
- [ ] **plan-00 DatabaseManager interface 补对称方法**(plan-01 加 wiki 时补 `checkpointWiki`/`backupCore/backupWiki` 签名,避免形状不规整)。

**implementer 落地注意(R1/R3/R4):**
- [ ] plan-05:`patch.wikiAnchors` / `SessionConfig.wikiAnchors` / `this.config.wikiAnchors`(agent-loop.ts:274,1480)退役路径未明文 → 进 sub 时显式化,防漏改 patch 通道。
- [ ] plan-05:`dynamicSystemSections[]` 与现有 work-context/skills 三闭包(各自独立字段 + 独立 invalidate)的收口关系未理顺 → 否则可能出现「新 wiki 进新数组、旧两个留旧字段」的 half-way。
- [ ] plan-01 §4 shared 类型补 `WikiRequestContext`/`WikiAdminRequestContext`(plan-02 §1 声称来自 plan-01 shared 但 plan-01 §4 未枚举)。
- [ ] design §7.1 `AgentRecord` 片段补 `wikiPolicyRevision`(plan-05 §1 已加,plan-07 publish 契约依赖它)。
- [ ] README §3.1 L56「links 和静态地址使用内部 ID」措辞收紧为「内部存储层用 ID;Agent view 暴露 canonical path」(防误读为 links 字段泄露内部 ID)。
- [ ] **sub-00 类改名**(见 §2 watch-item):当独立机械任务 + compile-gate;验收断言全仓无残留 `SessionDB`。

**可忽略的措辞差异(R4):**hybrid 排序元组 `(-normalized_score)` vs `normalized_score DESC` 语义等价;plan-07 §6「revision +1」实指各 publish 目标各自的 revision。

---

## 5. 结论与下一步

✅ **re-review PASS**。6 组 blocker 全部由**可执行验收**(非仅文字)覆盖;跨文档一致;代码库假设为真。路线图可从「等待 re-review」改为「待实施」。

**建议进入实施前的两个小动作(可选,docs-only):**
1. 应用 §4「进 sub-00/sub-01 前明确」的 5 项(N1/N2/N3 + plan-08 两点名 + DatabaseManager 对称方法)—— 都是几行 doc 编辑,避免 sub-01 返工。
2. sub-00 范围说明里把 `SessionDB`→`CoreDatabase` 改名标注为「50 文件 186 处的机械改名,须 compile-gate 全覆盖」,别让 implementer 低估。

**实施启动**:plan 全部就位后,`EnterWorktree`(from master)→ sub-00(Database Foundation)→ 3 方向验收(规约/对抗/架构,memory `feedback-three-verifier-directions`)→ 循环到全 PASS → sub-01 → … → acceptance-final。
