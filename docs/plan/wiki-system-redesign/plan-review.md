# Plan Review: wiki-system-redesign(实施前评审)

- **日期**:2026-07-16
- **方法**:4 个并行 agent 分块精读——A(design+README)/ B(plan-01..04+acceptance)/ C(plan-05..08+final)/ D(核对现有代码库)+ 主线自核命脉事实
- **状态**:✅ re-review(round-2)PASS —— 6 组 blocker 全 RESOLVED,跨文档 CONSISTENT;裁决见 [plan-review-r2.md](plan-review-r2.md)。待实施
- **结论**:设计自洽、sub 拆分合理,但 plan 现状直接实施会造成跨 sub 大返工(尤其「独立 wiki.db」被低估为「新建一个文件」,实际是结构性大手术)。**先修 🔴,再开 worktree。**

---

## 命脉事实(主线已自核,非转述)

- `PostTurnComplete` **已删**:[hook-types.ts:22](../../../src/core/hook-types.ts#L22) `→ DELETED (Step 3B): its operations moved to StepEnd`。凡是引用 PostTurnComplete 的实现会直接踩空,等价物是 **`StepEnd`**(每步,非每 turn)。
- wiki 注入**全内联**在 [agent-loop.ts](../../../src/runtime/agent-loop.ts):`:73` import `wiki-anchor-injection`、`:286` 内联建 `wiki-system-anchors` system section、`:956`/`:1488` 内联 `promptAssembler.invalidate(...)`。**没有任何 wiki 相关 hook**。

---

## 🔴 blocker(进实施前必修)

### B1 — plan-05 prompt 注入没走 hook(且 PostTurnComplete 已删)
- **问题**:plan-05 只做文件 1:1 替换(`wiki-anchor-injection.ts`→`wiki-context-compiler.ts`),全文 0 处提 hook / PreLLMCall / StepEnd / `src/runtime/hooks`。没碰现状的内联债,没说 closure/hook 接线方式 → 违反项目硬规则「AgentLoop 禁止内联功能代码,所有功能必须 hook 注册」(memory `feedback-agent-loop-hooks-only`)。且 acceptance-05 不验接线,继续内联也会绿(memory `feedback-verify-runtime-wiring` 的 dead-path 假阳性)。
- **证据**:[agent-loop.ts:269-296](../../../src/runtime/agent-loop.ts#L269)(内联建段)、[agent-loop.ts:956](../../../src/runtime/agent-loop.ts#L956) + [:1488](../../../src/runtime/agent-loop.ts#L1488)(内联 invalidate);sibling 对比:`work-context`/`skills` 已是 server-built closure([agent-loop.ts:302-322](../../../src/runtime/agent-loop.ts#L302) 注释)。
- **修法**:plan-05 §6/§7 钉死——(a) `wiki-context` section 由 **agent-service 构 `config.wikiContextSystemSection` 闭包注入**(类比 `config.workContextSystemSection`,design §9.3 本意如此),AgentLoop **不得 import 编译器、不得出现字面段名** `'wiki-context'`;(b) memory archive / grant publish / active-project 切换 三类 invalidate 一律经 `StepEnd` hook 或 agent-service config-sync 通道;(c) acceptance-05 D 增断言:`grep -E 'promptAssembler\.invalidate\(["'\''"]wiki-' src/runtime/agent-loop.ts` 命中 0。
- **状态**:☐

### B2 — 「独立 wiki.db」是结构性大手术,计划低估
- **问题**:计划把 wiki.db 当「新建一个文件」,但**现状 wiki 不是独立 db**——是 `sessions.db` 里的 `project_wiki` 表 + 磁盘 `~/.zero-core/wiki/` 正文;WikiStore 直接复用 SessionDB 的 better-sqlite3 句柄。拆独立 db 牵动 5+ 模块,且服务端**无「第二个 Database 实例」先例**。还引入**新启动 race**(第二 db 文件 + 第二连接,race 面扩大,正中 memory `project-recovery-wikistore-startup-race`)。
- **证据**:`wiki-node-store.ts:360-366`(WikiStore 复用 `sessionDB.getDb()`);耦合面:[data-change-hub.ts:48](../../../src/server/data-change-hub.ts#L48)(`project_wiki` UI 广播)、`project-wiki-store.ts`/`project-wiki-router.ts`(back-compat + REST)、`wiki-scan-cursor-store.ts` + `wiki-skeleton-service.ts`、[server/index.ts:165-218,439-477,599-665,846-857](../../../src/server/index.ts#L165)(装配 + 两套路由)、[project-work-hook-manager.ts:6](../../../src/server/project-work-hook-manager.ts#L6)(订阅)。
- **修法**:需用户显式认领这块成本;plan-08 补——(a) 启动顺序:wiki.db 必须先于 agent-service / recovery 扫描就绪;(b) wiki.db 与 sessions.db 的 WAL checkpoint **各自独立**;(c) 新库物理隔离(见 B5);(d) 给 WikiStore 自己的 better-sqlite3 实例 + 自己的 migration 入口(明确「服务端首个多 Database 实例」)。
- **状态**:☐

### B3 — project_wiki 停用范围低估 + 启动写入冲突
- **问题**:plan-08 §1 说「代码不得查/写 project_wiki、启动不得静默删」,但 `db-migration.ts` 有 **4 处启动期写 project_wiki**,删除清单漏列;`server/index.ts:325`「每次启动 ensure wiki skeleton」走旧 ProjectWikiStore,需重接线。→ acceptance-08 grep 审查必挂;migration 是 lossy(DROP TABLE)与「绝不静默删 sessions.db 数据」(memory `feedback-sessions-db-readonly`)直接冲突。
- **证据**:[db-migration.ts:464-489](../../../src/server/db-migration.ts#L464)(`migrateWikiTableSchema` DROP+CREATE)、[:511](../../../src/server/db-migration.ts#L511)(`migrateWikiDetailToDisk`)、[:716-717](../../../src/server/db-migration.ts#L716)(`safeAddColumn project_wiki links`)、[:821](../../../src/server/db-migration.ts#L821)(fresh-DB `CREATE TABLE project_wiki`);[server/index.ts:325](../../../src/server/index.ts#L325)(ensure skeleton)。
- **修法**:plan-08 §1 增列删除这 4 处 migration + 重接线 `ensure skeleton`;fresh DB 不再建 `project_wiki`;表本身在 sessions.db 中保留为「不被任何代码 touch 的历史表」。
- **状态**:☐

### B4 — sub-01 SQLite TEXT 亲和陷阱(连锁挂掉 sub-02)
- **问题**:`sqlite-store.ts` 的 `columnDef` 把几乎所有列声明 TEXT;design §5 DDL 用 INTEGER(revision/ids)。implementer 极可能照抄相邻 `wiki-node-store.ts` 复用 `SqliteStore<T>` → `revision` 被建成 TEXT,`revision + 1` 走字符串拼接,acceptance-02「revision 恰好 +1」必挂。design.md:837 禁 SqliteStore 但 plan-01 没复述,acceptance-01 不查列亲和。
- **证据**:[sqlite-store.ts:103-109](../../../src/server/sqlite-store.ts#L103)(TEXT 亲和根因);`wiki-node-store.ts:38-90`(现有 store 模板,易被抄);memory `reference-sqlite-text-affinity-numeric`。
- **修法**:plan-01 §6 钉死——用裸 `Database.exec()` 跑 design §5 的 DDL,**不得复用 `SqliteStore<T>`**;acceptance-01 §A 增断言 `PRAGMA table_info(wiki_nodes).revision.type = 'INTEGER'`(以及所有 INTEGER 列)。
- **状态**:☐

### B5 — 跨 sub 契约没钉死(3 条,都会返工)
- **error code union**:plan-01 说「shared 稳定 union」但无文档列全集;sub-02 补 `NOT_FOUND/ACCESS_DENIED/EDIT_TARGET_*/WRITE_CONFLICT/SOURCE_MANAGED`、sub-03 需 sync 失败码、sub-04 需 regex limit 码 → 后补者回改 sub-01 的 shared 类型。
- **auditId 矛盾**:acceptance-01「对 Agent/UI 暴露的 view 不含内部 id/parent_id/...」vs acceptance-04「mutation 返回 auditId」;auditId = `wiki_audit_log.id`(内部 PK)。两 implementer 一个抹掉一个必返,验收扯皮。
- **name vs id 路径段**:design §4.1 路径段用 `<agent-name>`/`<project-name>`,§7.1 grant 模板用 `${agent_id}`/`${active_project}` → name ≠ id,**永不相等,授权编译必挂**;agent/项目改名还会让 grant 失配。
- **修法**:plan-01 §4 在 shared 类型里贴出完整 `WikiErrorCode` 枚举初值(sub-02/03/04 引用而非新增)+ 显式声明 auditId 为 **agent-visible stable id(豁免「无内部 id」)**,但禁返 node/link/source 数字 PK;design §4.1/§7.1 统一路径段用 **stable id 或 slug**,并定改名级联规则(renamed → move + grant 重写)。
- **状态**:☐

### B6 — archived 撞 `UNIQUE(parent_id, name)`
- **问题**:delete 默认归档(§8.9),archived 节点仍带 `parent_id`+`name`;而 `UNIQUE(parent_id, name)`(§5.1)→ 同名节点无法重建。尤其 Git sync「file A 删除→归档;之后新建同名 file A」(§6.4 add 规则),indexer 撞 UNIQUE 报错。
- **修法**:二选一——(a) 归档时把节点移到 `wiki-root/.archived/...` 子树(并解决归档地址的 FK RESTRICT);(b) 唯一约束改为 partial index `UNIQUE(parent_id, name) WHERE archived_at IS NULL`。
- **状态**:☐

---

## 🟡 concern(在对应 sub 的 plan 里决策)

### 阶段 / 契约对齐
- [ ] design §14(6 phase)与 README §2(8 sub)颗粒度不对齐 → 谁负责 path normalizer / 地址解析 / 授权服务(现散在 01+02),implementer 会困惑。建议 README §2 表格补「每 sub 产物 contract 清单」对齐 design §15。
- [ ] 02 的授权服务需要 `AgentRecord.wikiGrants` 字段,但该字段的 store round-trip 归 05 → 02 要么把字段下沉到 02,要么只能用内存 fixture 测。
- [ ] sub-02 `WikiService` public API 只有文字列表,无 TS 签名(expand/read/create/.../move);`searchScopePreparation` 像 internal helper 却列在 public API。
- [ ] sub-03 source search、sub-04 `CallerCtx.wikiAccess` 均无签名;现有 `CallerCtx`([types.ts:268-369](../../../src/tools/types.ts#L268))只有 legacy `wikiAnchorNodeIds`,**没有 `wikiAccess` 字段**。
- [ ] sub-02 §5 Markdown section 编辑未选 parser(commonmark/remark/自写),ATX/Setext 是否都识别;acceptance-02 §A 四个边界无 input→expected oracle。
- [ ] sub-04 §1 action schema 形状未定(discriminatedUnion vs flat)→ **必须保持顶层 flat `z.object`**(project-v08-tool-hardening §2 + 现有 [wiki-tool.ts:351-356](../../../src/tools/wiki-tool.ts#L351) 注释)。
- [ ] sub-04 §5 regex worker 是隐藏工作量,timeout / 候选数上限 / 结果数上限 / 错误码名 全未定;无 worker pool 现状调查。
- [ ] sub-03 §6 commit/merge/reindex 接入点未指明文件路径;与旧 `WikiSkeletonService` 的迁移路径(更名/并行/inline 替换)未定。
- [ ] sub-02 §6 `ensureAgentMemoryRoot` 的 caller 未指明(plan-02 不接 AgentRecord → 谁调?签名会随 plan-05 接入而变)。

### 运行时语义
- [ ] 地址解析失败的错误码未定义:`memory://` 无 agent_id / `project://` 无 active project / `runtime://unknown` / scope 语法非法。建议补 `ADDRESS_UNRESOLVED`(区别于 `NOT_FOUND`:前者地址无效/无绑定,后者地址有效但节点不存在 + 防枚举)。
- [ ] move 子树时**后代 revision 是否 bump**未定(bump → 大型 rename 全员 WRITE_CONFLICT 风暴;不 bump → 基于路径的 update 语义丢失)。
- [ ] `runtime://` 含内部 id,与 §4.3「Agent 不见内部 id」冲突 → 需明确 `runtime://` 仅管理面/UI 用,Prompt 只发 `memory://`/`project://`/规范路径。
- [ ] 动态地址(`memory://`/`project://`)由谁、何时插入 `wiki_addresses` 表;`resolver` 字段是函数名还是声明式 spec;`${agent_id}`/`${active_project}` 展开在 resolver 内还是编译期。
- [ ] 首版 summary/content 全空(§5.1 默认 '')→ Prompt manifest 注入空文本,「切换后立刻可用」不成立。首版摘要由 Archivist 补 / 用户填 / indexer 一次性 pass,未定。
- [ ] `attributes_json` create 后不可改(§8.7 `changes` 只列 summary)→ Memory 的 `durability`/`memory_type` 无法提升,与 §9.2「按 durability 筛选注入」矛盾。需把 `attributes` 加入 update `changes`。
- [ ] 大子树 move 的 O(N) materialized path 重写未评估(事务大小/WAL 增长/阻塞);§15.1 性能验收只测 read/expand/backlink,没测 move 延迟。
- [ ] FTS5 与 nodes 同步策略(trigger vs 显式事务)未定 → 两 sub 可能各做各的;建议钉死显式事务(与 §5.6「工具执行/FTS/审计同事务」一致)。
- [ ] `wiki_source_bindings.source_path` 的 `UNIQUE(repository_id, source_path)` 在 A↔B rename swap 时撞约束 → 需补 rename 顺序与冲突处理规则。
- [ ] Memory 归档流程(近期 commits `5f55e03`/`ffc75ea` 的 cleanup-TTL + 父归档级联)与新 `delete` 默认归档(§8.9)是同一套还是两套;归档完成信号谁发;子树级联是否走新 Wiki delete。
- [ ] `wiki-root` 全权 grant 检测到之后是 block save / warning 允许 / 记审计,未定。

### cutover / 启动
- [ ] 新 wiki.db 与旧 `~/.zero-core/wiki/*.md` **同目录** → 清理命令有误删新库/WAL 风险。建议新库放子目录(`${ZERO_CORE_DIR}/wiki/db/`)物理隔离,或清理命令精确 glob 白名单 + dry-run 默认。
- [ ] 初始化固定根 + 全量重建 Project Wiki 是 eager(启动即扫)还是 lazy(首次访问);大型多项目仓库全量重建阻塞启动多久 / 可否跳过 / 进度。复刻 memory「dev watcher 重启 + 启动顺序 race」风险。
- [ ] 切换期两套并存的数据一致性窗口:旧 IPC/UI 残留调用查旧数据 → 误以为数据丢失;中间 commit 可能 anchor-injection 与 context-compiler 双跑 → Agent 拿双份 Prompt section。**建议 plan-08 加「删除-切换原子性」验收:同 commit 删 ProjectWikiStore/router/anchor-injection + 切新 service**。
- [ ] 外部(诊断/备份脚本)访问 wiki.db 的 readonly 约定(`?mode=ro`、绝不 VACUUM/checkpoint)未声明(对齐 sessions.db readonly 约定)。

### 代码现实偏差(照计划写会踩空)
- [ ] wiki 工具实际 **10 个 action**(漏 createMemory / updateMemory / docWrite)→ 漏了破坏 Force-档 memory 自写([agent-loop.ts:918-928](../../../src/runtime/agent-loop.ts#L918))与文档写入路径。schema **必须保持顶层 flat `z.object`**。
- [ ] `deriveTypeFromPosition` 是**模块级私有 fn**(不是 WikiStore 方法),签名 `(row) => WikiNodeTypeGlobal`;`upsertProjectNode` 是 **legacy 单-project 入口**(archivist 用),工具层走 `upsertNodeInScope`(多 anchor)。
- [ ] `wikiAnchors[].depth` 在 schema 里([agent-registry.ts:137](../../../src/tools/agent-registry.ts#L137))但渲染层已不消费(`wiki-anchor-injection.ts:282` 注释)→ dead field,改造时删或重接。
- [ ] renderer 有**两套 wiki IPC**:legacy `/api/project-wiki/*`(CRUD,`WikiPage.tsx:126` 仍用 `wikiUpdateNode`)+ P8 `/api/wiki/*`(只读浏览,**无 mutation 端点**)。plan-06 改 IPC 要明确动哪套或趁机合并。
- [ ] plan-06 §3「重写 wiki-store」低估:`renderer/store/wiki-store.ts` 整体按 `nodeById` 内部 ID 索引,被 `AppLayout/AgentEditor/WikiPage/WikiTree/WikiTreePanel` 至少 5 个组件消费 → 全 store 重写 + 5 消费方联动改 canonical path key。

### 验收可测性
- [ ] acceptance-01 FTS 列定义不在 acceptance(索引哪些字段),implementer 选不同字段集都能自洽但与 plan-04 fulltext 对不齐。
- [ ] acceptance-02 §A section 边界四个 case 无 oracle。
- [ ] acceptance-04 §B「format 紧凑、可重新寻址」主观 → 改可断言「format 输出的每个 canonical path 回灌 expand schema 必须解析成功」。
- [ ] acceptance-04 §D regex「无法阻塞主线程」「稳定 limit error」无 timeout/limit 阈值;hybrid 排名公式「确定且可测试」但公式没给(建议显式 tuple 如 `(match_type_rank, path_len, node_id)`)。
- [ ] acceptance-02/03/04 未把「新测试文件存在 + 数量 ≥ N」列为拒绝条件 → 测试漏建 `test:unit` 仍可能绿。
- [ ] plan-05 §6 截断「明确优先级」未列优先级表;acceptance-05 D「无关字段不失效」未定义无关白/黑名单。
- [ ] plan-08 §4 + acceptance-08 D「1M benchmark 有记录」降级为人工「有报告」→ 门禁形同虚设,至少要求附运行日志 + 日期 + SHA。
- [ ] **acceptance-final 是「分项叠加」非真 e2e**。缺:(1) publish→**在途 tool call** 安全边界(plan-05 §7 最关键验证);(2) active-project **运行中切换**→ wiki-context 重编译 + `${active_project}` 重展开;(3) ProjectWikiStore **运行时切除**断言(不止 grep,要 `data:changed 'project_wiki' 无订阅者`);(4) wiki.db 独立性运行时断言(两独立文件 / 各自 WAL / 写 Wiki 不触发 sessions.db checkpoint);(5) 删最后 grant→持久化 `[]`→下次 ACCESS_DENIED 一条龙(memory `feedback-ui-pull-on-display`);(6) move 事件 old/new parent 双失效跨 IPC + UI。
- [ ] acceptance-final H(Browser UI)7 条全 checkbox,无脚本步骤 → 应升级为脚本化 e2e 或显式引用 acceptance-06 F 人工走查。
- [ ] acceptance-final §14「无跨阶段不变量被破坏」**未枚举不变量清单** → 应固化 design §11 的 5 条 + memory wiki-v0.8 决策。

---

## 🔵 nit
- [ ] `kind` 枚举开放(§2/§8.5)→ UI 图标 / search 过滤 / source-bound 判定都依赖,建议给 v1 闭集。
- [ ] 局部编辑的「section」边界(按 `#` 计?按级别?)未定义。
- [ ] README §5 verify 对 05(runtime 改动)只跑 typecheck/unit → 05 是运行时关键路径,应也跑 e2e。
- [ ] sub-03 Windows fixture:symlink 需开发者模式/管理员、submodule 行为差异、fixture 脚本须 Windows + PowerShell 可跑。
- [ ] layering:plan-01 §1 显式引用 design 的旧→新文件迁移表,声明「sub-01 只新增 `src/server/wiki/` 子目录,不删旧 `src/server/wiki-*.ts`」。

---

## 原评审建议（已由 resolution 文档落实）

1. 修 🔴 B1–B6(起草 plan/design 修订,docs-only 留 master)——可全 6 组一起,或先做最阻塞的 B1/B2/B5。
2. 🔴 修完后开 worktree(`EnterWorktree`,from master),启动 sub-01。
3. 每个 sub 验收派 **3 个独立 verifier agent**(方向:**规约符合 / 对抗边界 / 架构约束**,见 memory `feedback-three-verifier-directions`),全 PASS 才进下一 sub。
4. 全部 sub 过后跑 acceptance-final(同样 3 方向)。

> 评审原始材料:4 份 agent 报告(主线汇总于此)。关键代码定位见各条「证据」。
