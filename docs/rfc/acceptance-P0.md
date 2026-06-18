# Acceptance P0 — 数据模型 & schema 地基

> **前置**:`impl-plan.md` 全局完成定义(tsc + 测试绿 + migration 跑通)。
> **核心原则**:本阶段只验「类型 + 表结构 + migration」,不验业务逻辑(委派/调度/注入都是后续阶段)。**fresh DB + 旧库两条路径都要过**(契约 1.2)。

### AgentRecord
- [ ] `AgentRecord` 已加 `subagents?: [{agentId, name?, description?}]`、`wikiAnchors?: [{nodeId, inject, depth?}]`
- [ ] `AgentRecord` 已删 `roleTag`(类型层);`roleTag` 物理列保留但 store 不再读写(标注 legacy)
- [ ] `agent-store.ts` subagents/wikiAnchors 以 JSON 单列 round-trip(参考 knowledgeBaseIds 写法)
- [ ] `db-migration.ts` `AGENT_COLUMNS` 已同步(加 subagents/wikiAnchors,移除 roleTag 映射)

### wiki_nodes
- [ ] `project_wiki` 表已加 `links` 列(JSON 无向数组);`WikiNode` 类型加 `links?: string[]`
- [ ] `wiki-node-store.ts` links 序列化 round-trip;NULL 兜底成 `[]`
- [ ] `type`/`detail` 列**仍在**(本阶段不去除,留 P1)

### crons
- [ ] `crons` 表 `schedule` 列存结构化 JSON(三模式);`CronRecord`/`CronSchedule` 类型对齐 once/alarm/interval
- [ ] 已加列 `trigger_mode`/`last_run_at`/`last_status`/`last_error`/`next_run_at`
- [ ] migration 把旧 schedule 字符串行全表转成 JSON(off→enabled=false;hourly→interval 3600000;daily→alarm 09:00+[];weekly→alarm+[当日];数字串→interval)

### 新表
- [ ] `cron_runs` 表存在(id/cron_id/fired_at/agent_id/session_id/success/error/duration_ms/tokens/cost)+ `idx_cron_runs_cron`
- [ ] `tool_configs` 表存在(tool_name PK/config/updated_at)
- [ ] `tool_usage` 表存在(id/tool_name/agent_id/session_id/called_at/params/success/duration_ms)+ 索引

### migration 双路径(契约 1.2)
- [ ] **fresh DB** 启动:所有新表/新列齐全,zero-core 正常起,无报错
- [ ] **旧 DB**(当前 dev 库 `~/.zero-core/sessions.db`)启动:migration 跑通,不崩
- [ ] 旧库 agents 行数据保留(roleTag 列还在,只是不用);旧库 crons 行 schedule 已转 JSON
- [ ] 各 `*_COLUMNS` 数组与表一致(无 fresh 缺列)

### 类型检查
- [ ] `npm run build:lib`(tsc)通过——删 roleTag 后,所有引用 roleTag 的地方要么已清理(runtime 侧本阶段清,P2/P7 剩余),要么 TS 不报错(物理列保留)
- [ ] **注意**:若删 roleTag 导致大量 TS 报错超本阶段范围,在本阶段只删类型 + store 层引用,runtime/service 层 roleTag 引用先 `@ts-expect-error` 或临时保留,留给 P2/P7 清——不得为了让 tsc 过而越界改 runtime 逻辑

### 测试(sub2 写 + 跑)
- [ ] migration 测试:构造旧 schema 库 → 跑 migration → 断言新列/新表存在 + 旧 agents/crons 数据保留 + schedule 已转 JSON
- [ ] store CRUD 测试:AgentStore 读写 subagents/wikiAnchors round-trip;CronStore 读写三模式 schedule + 新列;WikiNodeStore links round-trip
- [ ] 新表 store 测试:cron_runs/tool_configs/tool_usage 基本 CRUD

### 边界(本阶段**不**验证)
- [ ] ~~委派走 subagents~~ → P2
- [ ] ~~cron 三模式调度触发~~ → P4
- [ ] ~~wiki 正文磁盘 + 多锚点~~ → P1
