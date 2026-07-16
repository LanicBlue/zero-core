# Zero-Core 架构分析文档

> 这是一套**基于代码反向推导**的架构文档集。作者仅通过阅读 `src/` 下的源代码（不参考现有的 `docs/`）得出结论，然后以资深软件架构师的视角重新整理出可指导决策的文档。
>
> 适用人群：需要修改架构、做跨层重构、规划演进路线的工程师 / 架构师 / Tech Lead。

## 设计原则

这份文档遵循以下原则：

1. **不依赖既有文档**。所有结论都能在 `src/<file>.ts` 中找到对应证据。
2. **先讲边界，再讲实现**。模块的接口比实现细节更耐久。
3. **决策与代价并陈**。每条设计选择都列出它替代的方案与代价。
4. **可演进性优先**。架构是否能让下一次改动更便宜，是衡量它的最高标准。
5. **承认负债**。从代码里读出的"现实状态"不会被美化。

## 文档清单

| # | 文档 | 主题 | 主要读者 |
|---|------|------|----------|
| 01 | [系统全景](./01-system-overview.md) | 进程模型、IPC/WS 拓扑、技术栈、关键数据流 | 所有读者 |
| 02 | [模块结构与边界](./02-module-structure.md) | 各 src/* 子系统的职责、依赖方向、跨层契约 | 跨层修改者 |
| 03 | [核心执行引擎](./03-runtime-engine.md) | AgentLoop / Session / Provider / 重试 / 流式事件 | Runtime 改造者 |
| 04 | [工具子系统](./04-tools-subsystem.md) | ToolRegistry、tool-factory、built-in / MCP / Agent 工具 | 工具扩展者 |
| 05 | [持久化层](./05-persistence.md) | SQLite Schema、KV、消息/Turn、迁移 | 数据层维护者 |
| 06 | [知识子系统](./06-knowledge-subsystems.md) | MCP、KB(RAG)、Memory、MemoryNode | 知识检索改造者 |
| 07 | [渲染层与 IPC 桥](./07-renderer-and-ipc.md) | Renderer、Zustand、preload、IPC↔HTTP 代理 | UI / 集成开发者 |
| 08 | [横切关注点](./08-cross-cutting.md) | Logging、Hooks、并发、代理、Recovery | 平台 / 可观测性 |
| 09 | [扩展点与 ADR](./09-extension-points-and-adrs.md) | 显式扩展点 + 关键架构决策记录 | 决策者 |
| 10 | [架构级 Tech Debt](./10-tech-debt-architect-view.md) | 架构师视角的债务清单与影响评估 | 规划清理 |
| 11 | [质量属性与 SLO](./11-quality-attributes.md) | 延迟/吞吐/一致性/可用性/可演进的权衡 | 性能 & 容量规划 |
| 12 | [术语表](./12-glossary.md) | 跨文档使用的术语、缩写、内部命名 | 所有读者 |

## 阅读路径建议

- **新人入门**：01 → 02 → 03 → 04
- **修一个具体问题**：先 02 找到层，再读对应层文档
- **规划演进**：01 → 09 → 10 → 11
- **理解 UI 与后端如何对话**：01 → 07
- **理解 Agent 为什么这样跑**：03 → 04 → 08（hook 部分）

## 文档生成方式说明

本文档完全基于源代码静态分析得出。**未运行项目**，未读 `docs/`、未读 `CLAUDE.md`、未读 `openprd/` 任何文件。所有结论的证据来自 `src/` 中的 TypeScript 文件，并附带对应文件名+行号范围以便追溯。

每条结论的可信度由源文件的体量与重要性决定：
- **强证据**：来自 `agent-loop.ts` / `agent-service.ts` / `server/index.ts` 等核心入口代码。
- **中证据**：来自路由器、Store、子模块的代码。
- **弱证据（仅作提示）**：来自单文件注释、未被引用的工具。

文档中所有流程图采用 Mermaid 描述，可在支持 Mermaid 的 Markdown 渲染器中直接查看。

---

## 勘误修订

本文档集已于 2026-06-21 再次对照实际代码库进行勘误修订。当前版本优先采用"代码事实 + 测试契约"描述，避免把易变的行号当作架构事实。主要修正包括：

1. **P9 IPC 死代码清理已完成**：`src/main/ipc.ts` 与 `src/main/ipc/` 目录当前均不存在，`tests/unit/p9-dead-path-removal.test.ts` 已把这一点固化为契约。
2. **IPC 代理规模更新**：`src/main/ipc-proxy.ts` 当前约 350 行，`R` 映射表约 140 个后端代理通道；main 进程另有 5 个本地 `ipcMain.handle` 通道（3 个窗口控制 + `dialog:openDirectory` + `webfetch:login`），`app:ready` 是健康检查通道。
3. **preload 契约规模更新**：`src/preload/index.ts` 当前暴露约 150 个 `ipcRenderer.invoke` 通道。`rest-routers.test.ts` 已检查大多数 preload invoke 都必须有 proxy/local 映射。
4. **仍存在的 IPC 漂移**：测试中显式放行了 `search-provider:get/set`、`templates:github-preview/import-github` 这 4 个未走 `R` 映射的通道；其中 template GitHub 后端路由存在，search provider 后端入口仍待确认。
5. **核心大文件规模更新**：`wiki-node-store.ts`、`agent-service.ts`、`db-migration.ts`、`core-database.ts`、`server/index.ts`、`agent-loop.ts` 均已进入大文件区间，架构债务不再只集中于 AgentService / CoreDatabase。
6. **记忆主线已切到 Wiki tree**：当前默认 Agent 会话通过 Wiki anchors 注入项目/Agent 记忆；`rag-hooks.ts` 仍注册但普通会话未注入 `getRagContext`，应视为 legacy optional hook，而不是当前主线功能缺陷。
7. **D-013 SQLite WAL**：保持为已解决（`core-database.ts` 和 `kb-db.ts` 均执行 `db.pragma("journal_mode = WAL")`）。
8. **D-007 ToolRateLimiter**：保持为已解决（已在 AgentLoop / tool-factory 执行路径中运行）。
