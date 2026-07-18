# 10 · 架构级技术债

> 核对基线：2026-07-18。这里只记录当前源码中仍可复现的风险。优先级是文档评估，不是修复授权；修复前仍需为目标问题补最小复现。

## 1. 优先级定义

| 级别 | 含义 |
| --- | --- |
| P0 | 可能造成持久数据丢失、越权或关键功能不可达 |
| P1 | 中断/恢复不可靠、跨层一致性薄弱，或显著扩大修改成本 |
| P2 | 可观测性、性能、维护性或未接通能力问题 |

## 2. P0

### D-001：启动时无条件删除 `messages`

[`SessionDB.initSchema()`](../../src/server/session-db.ts) 每次构造都会 `DROP TABLE IF EXISTS messages` 后重建。`messages` 现在承载滚动摘要和压缩游标，不再是可以随时从历史无损重建的缓存。

**影响**：正常重启可能丢失已生成摘要与压缩位置，后续上下文组成和再次压缩会偏离重启前状态。

**缺口**：现有测试覆盖 fresh/upgrade schema，但没有覆盖“写入摘要 → 关闭 DB → 用同一 DB 重启 → 摘要仍存在”。

### D-002：桌面后端缺少明确的本机安全边界

Electron main 把业务调用代理到本地 HTTP/WS 后端。当前架构文档与代码中没有看到完整的请求认证协议、来源校验和统一的 loopback-only 保证。

**影响**：如果监听地址或端口信息暴露，同机进程可能绕过 Renderer/preload 直接调用业务 API。工具、文件和配置 API 的风险高于普通 UI API。

**修复前要确认**：真实 bind 地址、端口文件权限、是否存在未文档化 token，以及 standalone server 的预期威胁模型。

**计划**：[`local-backend-security-boundary`](../plan/local-backend-security-boundary/README.md)
已完成并确认设计与分阶段计划，当前为 Ready、尚未实施；当前事实仍是本节所述风险。

### D-003：GitHub template IPC 调用不可达

Renderer/template store 调用 `templates:github-preview` 和 `templates:import-github`，preload 也暴露了它们；契约测试把它们列为例外，但当前 main proxy/local handler 中没有对应接线。后端 router 存在相关 endpoint。

**影响**：UI 功能可能在 invoke 处失败；测试白名单把缺口固化成“允许遗漏”。

## 3. P1

### D-004：Session / Turn 生命周期与取消传播不完整

- Provider 的 `ConcurrencyQueue.acquire()` 支持 `AbortSignal`，但 provider factory 获取许可时没有传入当前 loop 的 signal。
- `ToolRateLimiter` 的等待接口没有 abort 参数。

进一步核对发现该问题同时涉及 Stop 后输入队列继续 drain、Wait/AskUser 挂起、后台任务跨
Turn 事件、force-Wait 二次放行、compacting 和 UI 状态双真相源。

**影响**：用户中止后，仍在排队的模型请求或工具调用可能晚些时候获得许可并继续产生副作用；
Stop 还可能自动启动 queued Turn，后台任务结果也缺少稳定的跨 Turn 交付语义。

**计划**：[`session-turn-lifecycle`](../plan/session-turn-lifecycle/README.md) 已完成并确认
设计与分阶段计划，当前为 Ready、尚未实施；当前事实仍是本节所述风险。

### D-005：DB 与文件系统写入不是统一事务

Wiki、附件、归档、大工具输出都跨 SQLite 和磁盘。局部流程使用临时文件、rename、SQLite transaction 或恢复扫描，但没有通用的原子提交协议。

**影响**：崩溃点不同会留下孤儿文件、缺失正文或状态与 payload 不一致。每个域必须独立实现补偿，保证不一致。

### D-006：schema 有多处真相源且没有版本台账

部分核心 DDL 在 `SessionDB.initSchema()`，升级逻辑在 `runMigrations()`，部分 Store 又自行 `CREATE TABLE IF NOT EXISTS`。迁移按当前结构幂等探测，每次启动执行，没有 migration id/version ledger。

**影响**：无法直接回答某个数据库经历了哪些迁移；fresh 与 upgraded schema 容易漂移；回滚和故障定位困难。

### D-007：核心编排文件过大

截至核对日，`agent-service.ts`、`agent-loop.ts`、`session-db.ts`、`wiki-node-store.ts`、`db-migration.ts` 与 `server/index.ts` 都承担多个职责。

**影响**：跨域改动集中、审查困难、测试替身复杂，也增加把服务层状态直接塞回 runtime 的诱因。

**方向**：先按生命周期监督、事件广播、恢复协调、领域 Store 等稳定边界拆分，不按行数机械切文件。

### D-008：Wiki live prompt 缓存失效不完整

Wiki anchors 被合并进缓存的 system section。普通 Wiki 工具写入没有统一使当前 loop 的快照失效；force memory turn 和部分配置变更会刷新。

**影响**：刚写入的知识可能已经落盘，却要到后续生命周期才出现在模型上下文。

### D-009：Hook 副作用存在双路径风险

系统同时有 per-loop hooks、global hooks、data-change hub 和 runtime StreamEvent。历史重构后仍有注释和兼容入口描述旧触发方式。

**影响**：新增 handler 容易重复持久化、重复计数，或只在 main/delegated 其中一条路径触发。

### D-019：Backend 无边界同步重 I/O 阻塞事件循环

backend 在单个 Node.js 事件循环中运行 HTTP、WebSocket、Agent runtime、同步
`better-sqlite3` 和多处同步文件 I/O。当前 migration、archive export/recovery/sweep 等
路径包含随数据库或 Session 大小增长的同步循环、序列化和文件操作；`wiki-system-redesign`
还会增加全量/增量索引、FTS、完整性检查、备份校验和布局迁移。

**影响**：重任务期间 Stop、WS stream、Provider timer、其他 Session 和普通 API 都可能
停顿；启动迁移还缺少可区分“仍在工作/卡死/崩溃”的 lifecycle heartbeat。独立 SQLite
connection 或 `async` 函数声明本身不会移出主事件循环。

**计划**：[`backend-io-scheduling`](../plan/backend-io-scheduling/README.md) 已完成设计与
分阶段计划，当前为 Ready、尚未实施；它保留短同步 CRUD，把大事务放到专用 worker
connection、可拆任务改为短事务协作调度、启动迁移放到 maintenance child，并加入
event-loop latency 门禁。

## 4. P2

### D-010：WebFetch 数据目录与 Cookie 状态分裂

后端 WebFetch 的路径构造直接使用 `homedir()/.zero-core/webfetch`，没有完全遵守 `ZERO_CORE_DIR`。Electron main 登录流程和 backend fetch 各维护一个内存 Cookie Jar，并写同一磁盘文件。

**影响**：自定义数据目录失效；main 登录后的 Cookie 不一定立即进入已运行 backend 的内存状态。

### D-011：部分推送通道只有订阅者

`tools:changed`、`session:lifecycle`、`github-import:progress`、`github-preview:progress` 在 preload/Renderer 有订阅代码，但当前未找到对应 `webContents.send` 生产者。

**影响**：维护者会误以为 UI 已是实时更新，实际只能靠重新拉取或永远不会收到事件。

### D-012：重连恢复并未覆盖所有 Store

主重连路径会刷新 chat/core 数据，但 Dashboard metrics 和 MCP status 的调用结果没有完整写回对应状态。

**影响**：backend 重启后部分页面显示旧状态，直到用户执行其他刷新动作。

### D-013：Extractor B 是休眠子系统

Extractor B 的 service、Store 和测试仍存在，但当前生产启动工厂和触发路径没有装配它。Extractor A 已删除，向量 KB/RAG 也已删除。

**影响**：代码与配置暗示存在自动抽取能力，实际在线路径主要依赖模型主动写 Wiki 和 memory turn。

### D-014：日志同步写入且缺少敏感信息治理

日志文件 sink 使用同步 I/O；没有统一字段化结构、轮转策略或 secret redaction。代理 URL 等配置可能进入日志。

**影响**：高频日志会阻塞事件循环；支持日志可能泄露凭证或本地路径。

### D-015：Renderer/Electron 防护未系统化

当前启用了 context isolation 并关闭 node integration，但 webview 能力开启；没有在架构入口看到统一 CSP、导航限制和 permission handler 策略，sandbox 也未形成明确契约。

**影响**：Renderer 内容、外部导航或 webview 一旦出现注入问题，防御层不足。

### D-016：代理只覆盖部分网络客户端

[`proxy-manager.ts`](../../src/runtime/proxy-manager.ts) 主要设置 backend 的 undici dispatcher，不自动覆盖 Electron、MCP 子进程或所有 SDK/外部命令。

**影响**：UI 显示“已配置代理”时，不同网络路径仍可能行为不一致。

### D-017：崩溃处理可能让进程在未知状态继续运行

全局 `uncaughtException` handler 记录错误，但未形成“记录后退出、由 supervisor 重启”的统一策略。

**影响**：捕获不可恢复错误后继续服务，可能扩大内存/状态损坏。

### D-018：缺少持续集成与行为质量评估

仓库有大量 unit/E2E 测试和 mock model，但当前没有 `.github/workflows`，也没有 Agent trajectory/outcome eval harness。

**影响**：本地测试能力强，但没有仓库级自动门禁；Prompt、记忆和工具策略变化难以用行为指标回归。

## 5. 已退役但仍会误导维护者的叙事

以下内容不是当前债务，继续把它们当活跃模块反而会制造错误修复：

- `turns` / `turn_state` 表：已由 `steps` 与 `sessions` 取代。
- `MemoryStore` / `MemoryNodeStore` 在线后端：类和表已移除或迁移清理，当前记忆走 Wiki subtree。
- `knowledge.db` / KB embedding / RAG hook：不在当前生产路径。
- `src/runtime/tools`：工具已移动到 `src/tools`。
- `src/main/ipc/`：旧 handler 树已删除。

## 6. 建议处理顺序

1. 先为 D-001 写重启持久性复现，再决定 schema 修复。
2. 明确 backend bind/auth 威胁模型，处理 D-002。
3. 补齐或删除 D-003 的不可达 UI 能力。
4. Wiki 合并后按 Backend I/O Scheduling 计划治理迁移、索引、归档和维护任务的主线程
   阻塞。
5. 按 Session / Turn lifecycle 计划统一 Stop、等待、队列、后台任务和 compacting。
6. 再处理 schema 台账、跨介质一致性和大文件拆分。
7. 最后收敛推送、日志、代理和休眠子系统。
