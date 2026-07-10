# acceptance-1:表重建 + sessions 收状态

## 验收清单
- [ ] fresh DB 启动:sessions 表有 7 新列(`phase`/`last_completed_step_seq`/`source`/`error`/`turn_count`/`step_count`/`token_usage`);**无 `turn_seq`、无 `checkpoint` 列**;`updateTurnPhase`(零 caller)已删;`steps` 表(原 turns);`turn_state` 表不存在。
- [ ] `db-migration.ts` `*_COLUMNS` 含 sessions 7 新列(⚠️ fresh DB 不缺列)。
- [ ] `getTurnCount()` 读 `sessions.step_count`(保原 COUNT(*) 语义,step seq 分配不漂);`turn_count` 列建好但留 sub-9 读;in-memory turn-seq-tracker 分配不变。
- [ ] 计数器在 step-row 写入点 bump/重算(不在 createTurnState);压缩重建路径重算防漂移。
- [ ] 老 sessions 行 `phase` 默认 `'completed'`(不触发恢复扫描)。
- [ ] recovery 扫 `sessions.phase NOT IN ('completed','failed')`(不再扫 turn_state);`cleanOldTurnState` 已删(职责被 recovery 吸收)。
- [ ] 一个 session 同时只有 1 个 in-flight turn(invariant 保持)。
- [ ] 旧压缩路径(sub-3 前)仍在 `steps` 表上工作(过渡,本 sub 编译 + 测试通过)。
- [ ] `getIncompleteTurnSessionIds`/`doRecoverIncompleteSessions`/workbench 核对/子 agent resume 全走 sessions 单行。
- [ ] 配置表(agents/projects/wiki/tool/provider_usage)未动。
- [ ] 三层 tsc + build:lib + vitest 通过。

## 怎么验
readonly 查 sessions.db schema(`PRAGMA table_info`);跑 recovery 单测;fresh DB 启动测试。
