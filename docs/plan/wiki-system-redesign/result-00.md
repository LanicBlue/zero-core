# Result 00：数据库基础、统一布局与命名

对应 [Acceptance 00](acceptance-00-database-foundation.md) / [Plan 00](plan-00-database-foundation.md)。

- **实施 commit**：`09dac9a`(branch `worktree-wiki-redesign`)— feat(wiki-system-redesign): sub-00 数据库基础
- **验收**：3 方向独立 verifier(规约 / 对抗 / 架构)全 PASS,30/30 acceptance 项零 FAIL、零 lens 分歧(round-2,见下"验收记录")
- **结论**：✅ Acceptance 00 全部通过,可进入 Plan 01。

---

## 1. 布局状态矩阵(§A / §B)

| 状态 | core.db | sessions.db | marker | 行为 | 测试 |
|---|---|---|---|---|---|
| **fresh** | 无 | 无 | 无 | 创建 `db/core.db`;写 marker(`writeMarkerForFreshCreate` complete:false → `open()` 后 `finalizeFreshCreateMarker` 翻 complete:true);**不**创建 wiki.db / 根目录 sessions.db / knowledge.db | `database-layout.test.ts:214,245` |
| **legacy 迁移** | 无 | 有 | 无 | 独占开旧库 → `wal_checkpoint(TRUNCATE)` → close → `copyFileSync(legacy, tmp)` → `integrity_check`+`foreign_key_check` → 原子 promote(tmp→core.db) → 旧库 move 到 `backups/core/pre-layout-<ts>.db` → 删旧 WAL/SHM → 写 `complete:true` marker | `database-layout.test.ts:267`(5 fixture round-trip)/ `:304`(WAL 存活)/ `:412`(一次性 backup)/ `:437`(marker 字段) |
| **conflict** | 有 | 有 | 无有效 marker | 抛 `DATABASE_LAYOUT_CONFLICT`,不猜测事实源,**不**删任一库 | `database-layout.test.ts:458`;`database-bootstrap-adversarial.test.ts:412`(坏 JSON)/ `:503`(complete:false+双库)/ `:535`(未知 version) |
| **incomplete** | — | — | complete:false | 迁移路径**不引入** complete:false marker(FIX2 重排:marker 在 promote 前以 complete:true 写入);fresh-create 的 complete:false 是中间态,`open()` 完成即 finalize 为 true。任何"双库 + 无效 marker"都归 conflict 分支处理(结构覆盖) | `database-manager.ts writeMarkerForFreshCreate`+`finalizeFreshCreateMarker` |

**中断恢复幂等(§B4)**:marker(`complete:true`)在原子 promote **之前**写入 →
- marker 写入前 crash:无 marker + legacy 在位 + core.db 不存在 → Case B 重新迁移(顶部清残留 tmp),幂等。
- promote 后 crash(marker 已写):core.db + complete:true marker → Case E(legacy 仍在位)或 Case A(legacy 已移)正常打开,**不 brick**。
- 验证:`database-layout.test.ts:531`(stale tmp 替换、恰好一个 core.db+marker+backup)、`:561`(fresh-create 后重跑 no-op);`database-bootstrap-adversarial.test.ts:164/197/221/239/277/337`(两 FIX2 崩溃窗口)。

> **nit(非阻断)**:崩溃窗口 B(promote 完成、legacy 尚未 move 到 backup)会让 sessions.db 留在活动路径而非 backup 目录——但 impl 已文档化为可接受(`database-manager.ts:388-394`:不 brick、不产生第二活动源、Case E 确定性选 core.db,sessions.db 作 litter 待运维清理)。可选硬化:Case E 时 best-effort 把遗留 legacy move 到 backup。

## 2. 旧库切换 count/hash(§F2)

- **round-trip**:legacy 路径用 `CoreDatabase + runMigrations + AgentStore/ProjectStore/CronStore/ProjectWorkStore` 播种 5 条 fixture(各 1 行:agent / project / session / work / cron)→ 迁移后 `core.db` 5 行全部可查,**0 数据丢失**。`database-layout.test.ts:267`
- **hash**:`layout-v1.json` 记 `sourceSha256`(legacy,即将移为 backup)+ `targetSha256`(core.db.tmp,与 promote 后 core.db 字节一致),64-hex。`database-layout.test.ts:437`
- **WAL 存活证明(crash-sim)**:把 schema+data 全留 `-wal`(裸主库连 probe 表都没有)→ 迁移后 `core.db` 拿到行,**证明** `wal_checkpoint(TRUNCATE)` 在 `copyFileSync` 前把 WAL 折回主库。`database-layout.test.ts:304` / `database-bootstrap-adversarial.test.ts:669`

## 3. integrity / foreign key(§F3)

promote 前在 `core.db.tmp` 上跑:`integrity_check = "ok"`、`foreign_key_check = []`。`database-layout.test.ts:392`;impl `database-manager.ts:317-335`(不过直接抛错、绝不 promote)。

## 4. knowledge.db 精确删除 + 邻居保留(§F4)

- 3 个白名单字面量(`knowledge.db` / `-wal` / `-shm`)删除,**不**备份/导入/读内容。`retired-knowledge-db-cleanup.test.ts:130,146`
- 幂等:不存在 no-op、二次调用 no-op、部分存在只删在的。`:287,296,308`
- **邻居全保留**:`knowledge.db.keep` / `unrelated.db` / `other.db` / 子目录 `knowledge.db.d/` 全存活。`:324`
- **9 个 decoy 攻击全失败**:`knowledge.db*` / `knowledge*` / `*.db` glob、子目录递归、return-value 子集不变量 —— deleted[] 恒为 3 字面量子集。`:176,204,224,244,258`
- 结构化日志 `retired_database_deleted`(console.error + log.db 双通道),no-op 静默。`:347,369,387`
- impl:`database-manager.ts deleteRetiredKnowledgeDb`(`RETIRED_KNOWLEDGE_DB_PATHS` 为 `as const` 字面量数组,无运行时输入)

## 5. 硬编码旧路径 grep 分类(§F5)

| 范围 | 结果 |
|---|---|
| `src/` 生产代码 | **0** 个 `sessions.db`/`knowledge.db`/`wiki.db`/`core.db` 字面量(除 `database-paths.ts`+`database-manager.ts` allow-list);**0** 个可调用 `SessionDB`(仅 `core-database.ts:1/62/98/99` 4 处历史注释)。`core-database-compat.test.ts:145,192` |
| `scripts/` | `check-turns.cjs`(readonly URI `db/core.db?mode=ro`)、`self-update-restore.cjs`(检测 `core.db-shm` + 兼容 legacy)、`build-codegraph.ts`(KB/session-db 陈旧描述已清)、`itest-step-storage.cjs`(FIX3:`SessionDB`→`CoreDatabase`、弃 `hasStepSchema`)全部更新 |
| `dist/` | `session-db.js` 不存在(改名后);`node -e import('../dist/server/session-db.js')` → ERR_MODULE_NOT_FOUND |

## 6. DatabaseManager 生命周期 / 架构(§D / §G)

- **sole owner**:`new DatabaseManager(` 仅 3 处(`server/index.ts`、`cli.ts`、`agent-service.ts` 的 `resolveCoreDatabase` 单例感知 fallback —— 先 `getDatabaseManager()`,未注册才 new+`setDatabaseManager`,**至多一个** live owner)。`database-manager.test.ts:219-298`
- **无跨库 transaction**:`database-manager.ts` 无 `ATTACH` / `BEGIN…COMMIT`;`migrateLegacyToCore` legacy 句柄与 tmp probe **顺序**开/关(各 try/finally),从不并发。`:622-655,657-692`
- **接口锁定**:`wiki`/`checkpointWiki`/`backupCore`/`backupWiki` 占位抛 `WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00`,签名按 plan-00 §3 锁定待 plan-01/08 补(对称、core/wiki 独立)。
- **readonly 诊断**:`check-turns.cjs` `{readonly:true}`+`?mode=ro`,无 checkpoint/VACUUM/migrate;`checkpointCore` 仅在 open 后本进程持有 core.db 时跑(启动维护路径)。`:758-784`
- **open/close 顺序**:open 幂等、close 释放句柄(better-sqlite3 `.open`→false)、open→checkpointCore→close 无异常。`:388-507`

## 7. 验证命令 + 结果(§E)

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0(`tsc -p tsconfig.{cli,web,node}.json`) |
| `npm run build:lib` | exit 0(`tsc -p tsconfig.cli.json` + copy-bundled-skills) |
| `npm run test:unit` | 5 新文件联合 **85/85 PASS**;全量套件(154 文件,按 per-file/`-t` 分批绕开 Windows better-sqlite3 退出崩 exit 127/139)**0 新回归** |
| `npm run build` | exit 0(electron-vite build,9.53s) |
| `npm run check:links` | 256 个相对 .md 链接全解析,exit 0 |

**Windows vitest/better-sqlite3 退出崩**:单进程关大量 temp DB 时 STATUS_STACK_BUFFER_OVERRUN/SIGSEGV(exit 127/139),发生在测试**全部通过后**的进程退出阶段,非测试失败;按 per-file/`-t` 分批取真实信号(memory `reference-vitest-better-sqlite3-windows-crash`)。

**全量套件 2 个非 lens 失败(预存、与本 sub 无关)**:
- `sub5-dead-code-removed`:git-diff `--shortstat` 纯减法形状断言,被 worktree 自身未提交(现已提交)的 wiki-redesign 大量新增打破 —— 环境性。
- `deferred-dangling-tasklink`:子代理 resume `Cannot read 'id'`,用自己 throwaway `new CoreDatabase`,与改名/FIX 无关 —— 预存 bug。

## 8. 修改文件(§F6)

commit `09dac9a`:166 文件,+10604/−6367。
- 新增:`src/core/database-paths.ts`、`src/server/database-manager.ts`、`src/server/wiki-database.ts`、5 个 `tests/unit/database-*.test.ts` + `retired-knowledge-db-cleanup.test.ts` + `core-database-compat.test.ts`
- 改名:`src/server/session-db.ts → core-database.ts`(97% 相似,类 `SessionDB→CoreDatabase`)
- 机械改名:~134 个 src/test 文件(`SessionDB`→`CoreDatabase` 类型/导入/单例;测试 fixture `"sessions.db"`→`"core.db"`)
- 周边脚本:`check-turns.cjs`、`self-update-restore.cjs`、`build-codegraph.ts`、`itest-step-storage.cjs`
- 文档:`docs/arch/*`、`docs/basic/*`、`README.md`、`.env.example`、`docs/visualization/code-graph.{html,json}`(KB/knowledge.db 描述退役、改名同步)

## 验收记录(round 摘要)

- **round-1**(3 lens + synthesis):FAIL —— blocker(migrateLegacyToCore 的 async `source.backup()` 未 await,迁移路径废)+ 6 concern。独立定位,非 implementer 自述。
- **implementer FIX 轮**:copyFileSync 替 async backup(3 lens 共识 Option A);§B4 marker 重排;itest 脚本;arch docs 退役 KB;probeHealth 死码;agent-service DI fallback 走 DatabaseManager;cli singleton parity。
- **round-2**(3 lens + synthesis):**PASS** —— 30/30 acceptance 项,零 FAIL,零 lens 分歧。round-1 剩余行为失败经独立诊断为**测试 setup bug**(SQLite 关库时 shutdown-checkpoint 删 `-wal`;§G(a) 断言过严查目录而非备份文件),verifier 自修并**强化**断言(crash-sim 证 WAL-only 数据靠 checkpoint 存活)。
