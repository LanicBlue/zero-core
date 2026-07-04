# Plan P0 — 数据模型 & schema 地基

> **依赖**:无(根,所有阶段的地基)。
> **对应规范**: §1.2(schema 契约)/ §2.2(AgentRecord)/ §3.3(wiki_nodes)/ §3.4(crons)/ §7.7 / §11.9。
> **验收**:`acceptance-P0.md`(前置见 `impl-plan.md` 全局完成定义)。
> **文件**:`src/shared/types.ts`、`src/server/db-migration.ts`、`src/server/agent-store.ts`、`src/server/cron-store.ts`、`src/server/wiki-node-store.ts`。

**为什么第一**:P1–P9 全建在这些类型/表上。这层不立,后面每个阶段的 store/runtime/UI 都没字段可用。本阶段**只动类型 + schema + migration,不含业务逻辑**——故意把「数据形状」和「行为」分开,避免中间态破坏。

## 设计细节要求

### AgentRecord(§2.2 / §11.9)

1. `src/shared/types.ts` 的 `AgentRecord`:**加** `subagents?: Array<{ agentId: string; name?: string; description?: string }>`、`wikiAnchors?: Array<{ nodeId: string; inject: "system"|"context"|"off"; depth?: number }>`;**删** `roleTag?: string`(§1.4 身份 = name+systemPrompt)。
2. `agent-store.ts`:JSON 序列化 subagents / wikiAnchors 存单列(参考现有 `knowledgeBaseIds` 的 json 存法)。
3. `db-migration.ts`:`AGENT_COLUMNS` 数组同步——加 `subagents`(json)、`wikiAnchors`(json)映射项;**移除 `roleTag` 映射**。
4. **migration 策略**(契约 1.2):
   - 旧库 `agents` 表 `ALTER TABLE ADD COLUMN subagents/wikiAnchors`(新列,默认 NULL)。
   - `roleTag` 列**保留物理列不 DROP**(避免破坏现有数据/回滚困难),只是 AgentRecord 类型 + store 不再读写它。在 `AGENT_COLUMNS` 注释标注「legacy,不再用」。
   - 空库(fresh):新 schema 直接建。

### wiki_nodes 表(§3.3 / §10.1)

5. 加 `links TEXT`(JSON,无向 nodeId 数组)列。`type`/`detail` 列**本阶段不去除**——留到 P1 随「正文移磁盘」一起做(避免 P0 后 wiki 处于「detail 还在但没人写」的中间破坏态)。
6. migration:`ALTER TABLE project_wiki ADD COLUMN links`(默认 `'[]'` 或 NULL)。
7. `wiki-node-store.ts`:WikiNode 类型加 `links?: string[]`;序列化 round-trip。

### crons 表(§3.4 / §9.1 / §9.3)

8. `schedule` 列语义改为**结构化 JSON**(三模式 once/alarm/interval,§9.1 的 `CronSchedule` 类型)。store 层按 JSON 读写;旧的字符串值(off/hourly/daily/weekly)由 migration 转换。
9. 加列:`trigger_mode TEXT`(once/alarm/interval,冗余便于查询)、`last_run_at TEXT`、`last_status TEXT`(ok/failed/missed)、`last_error TEXT`、`next_run_at TEXT`。
10. `CronRecord` 类型(`shared/types.ts`)对齐:三模式 schedule + 新字段。
11. migration 映射旧 schedule 字符串 → 新 JSON:
    - `off` → `enabled=false`(schedule 留空或 `{mode:"interval",everyMs:0}`)
    - `hourly` → `{mode:"interval",everyMs:3600000}`
    - `daily` → `{mode:"alarm",time:"09:00",days:[],tz:<local>}`(时间无原始信息,默认 09:00)
    - `weekly` → `{mode:"alarm",time:"09:00",days:[<today>],tz:<local>}`
    - 数字串(ms) → `{mode:"interval",everyMs:<n>}`

### 新表

12. **`cron_runs`**(§9.3):`id TEXT PK, cron_id TEXT, fired_at TEXT, agent_id TEXT, session_id TEXT, success INTEGER, error TEXT, duration_ms INTEGER, tokens INTEGER, cost REAL`。索引 `idx_cron_runs_cron`(cron_id)。新 `CronRunStore`(或并入 CronStore)。
13. **`tool_configs`**(§7.7#4):`tool_name TEXT, config TEXT(JSON), updated_at TEXT`。PK = tool_name。工具默认参数配置。
14. **`tool_usage`**(§7.7#4):`id TEXT PK, tool_name TEXT, agent_id TEXT, session_id TEXT, called_at TEXT, params TEXT(JSON 摘要), success INTEGER, duration_ms INTEGER`。索引 `idx_tool_usage_tool`(tool_name)、`idx_tool_usage_session`(session_id)。注意:这是**工具调用日志**,与 token 资源消耗(sessions 表)是两回事(§8.5)。

### 类型与 store 对齐

15. 所有新表/新列在 `db-migration.ts` 的 `CREATE TABLE`(fresh)和 `safeAddColumn`/migration(旧库)两条路径都覆盖——契约 1.2 的「fresh + 旧库都跑通」。
16. 各 store(agent/cron/wiki + 新 cron_runs/tool_configs/tool_usage)的 `*_COLUMNS` 数组与表一致。

## 风险

- **`roleTag` 物理列保留但类型删**:`agent-store.ts` 的 SELECT/INSERT 不能再带 roleTag 列引用,否则 TS 报错或列不匹配。需确认 store 的列拼装是数据驱动(从 `*_COLUMNS`),不是硬编码 SQL 字符串。
- **schedule JSON 化破坏现有 cron 读取**:旧库 cron 行的 schedule 是字符串,migration 必须把它们全转成 JSON,否则 P4 调度器读到字符串会崩。migration 要扫全表转换,不能只改 DDL。
- **`links` 默认值**:`'[]'` vs NULL——store 读取时统一兜底成 `[]`,避免 NULL 解析崩。
- **AGENTS_COLUMNS 同步遗漏**:这是踩过的坑(§1.2 / `feedback-fresh-db-migrations`),fresh DB 会缺列。subagents/wikiAnchors 两列务必加进数组。

## 不在本阶段(明确边界)

- wiki 正文移磁盘、去 type/detail → **P1**。
- agent-as-tool 废除、subagents 委派逻辑、memory 合并 → **P2**。
- 4 action 工具、verify 工具 → **P3**。
- cron 三模式调度器逻辑、cron_runs 写入触发 → **P4**(本阶段只建表 + 类型,调度逻辑不动)。
- ProjectNotificationRouter / notify 删除 → **P7**。
