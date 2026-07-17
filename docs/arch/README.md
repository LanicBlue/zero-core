# Zero-Core 架构文档

> 当前状态：12 章均已于 2026-07-16 对照源码、测试和构建配置复核。代码仍是最终事实源；尤其不要仅凭源码注释、历史行号或归档计划判断当前行为。

## 阅读顺序

| # | 文档 | 主要问题 |
| --- | --- | --- |
| 01 | [系统全景](01-system-overview.md) | 进程、入口和主数据流是什么？ |
| 02 | [模块结构与边界](02-module-structure.md) | 代码应放在哪一层？ |
| 03 | [核心执行引擎](03-runtime-engine.md) | Turn、Step、Hook、压缩和恢复如何运行？ |
| 04 | [工具子系统](04-tools-subsystem.md) | 工具如何声明、筛选、执行和接入 MCP？ |
| 05 | [持久化层](05-persistence.md) | SQLite、文件 payload、迁移和归档如何配合？ |
| 06 | [知识子系统](06-knowledge-subsystems.md) | Wiki、anchors、memory 和项目扫描是什么关系？ |
| 07 | [Renderer 与 IPC](07-renderer-and-ipc.md) | React 如何通过 preload/IPC/HTTP/WS 访问后端？ |
| 08 | [横切机制](08-cross-cutting.md) | 事件、日志、并发、代理、恢复和安全如何实现？ |
| 09 | [扩展点与架构决策](09-extension-points-and-adrs.md) | 新能力应该接到哪里，关键决策为什么存在？ |
| 10 | [架构级技术债](10-tech-debt-architect-view.md) | 当前仍可复现的系统性风险有哪些？ |
| 11 | [质量属性与验证基线](11-quality-attributes.md) | 当前能证明哪些质量，哪些仍未测量？ |
| 12 | [术语表](12-glossary.md) | 当前名称、边界和退役名如何区分？ |

新人建议先读 [`../basic/README.md`](../basic/README.md)，跨层修改再回到这里。

## 事实优先级

1. 可执行测试和当前生产入口。
2. 当前源码与 `package.json` / TypeScript / 构建配置。
3. `docs/basic/` 与本目录。
4. `docs/issues/`、`docs/design/`、`docs/plan/` 中尚未实施的方案。
5. `docs/archive/` 与 `docs/visualization/` 的历史或生成快照。

“类存在”“类型存在”“有测试文件”都不能单独证明功能已接入生产；还要沿入口确认实例化、注入和触发路径。

## 本轮确认的关键事实

- 当前完整会话历史保存在 `steps`；`turns` 与 `turn_state` 已退役。
- `messages` 是滚动摘要与压缩游标，但启动时无条件删表，存在重启数据丢失风险。
- 当前知识/长期记忆主线是 Wiki tree；不存在在线向量 KB/RAG 或 `knowledge.db`。
- 工具位于 `src/tools`，并通过 `buildTool`、`ALL_TOOLS` 与 `ToolRegistry` 接入。
- Runtime 使用 per-loop HookRegistry；部分协议事件仍可能只有类型而无生产触发。
- Renderer 的普通请求走 IPC → HTTP，流事件走 WebSocket → IPC。
- GitHub template invoke、若干 subscriber-only 事件和部分重连刷新仍有接线缺口。
- Provider/工具等待队列的 abort 传播不完整。
- SQLite 与 Wiki/附件/归档/大工具输出之间没有统一跨介质事务。

## 维护规则

- 避免把行数、通道数、工具数等高漂移数字写成长期架构结论；确需列出时注明核对日期和真相源。
- 描述未来方案时使用“计划/目标/验收要求”，不要用现在时。
- 性能数字只有在仓库内有可复现 benchmark 时才能称为实测或 SLO。
- 修改数据模型时同时检查 fresh schema、升级 migration、Store 自建表和 reopen 测试。
- 修改 IPC 时同时检查 shared 类型、preload、main proxy/local handler、backend router 和 Renderer。
- 修改文档后至少运行 `npm run check:links`，并补充目录/anchor/源码链接检查。
