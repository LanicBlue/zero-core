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

本文档集已于 2026-06-12 对照实际代码库进行勘误修订，主要修正包括：

1. **Hook 事件数**：29 → 30（InstructionsLoaded 事件此前遗漏）
2. **内置工具数**：18 → 21（工具清单统计更正）
3. **agent-service.ts 行数**：639 → 773
4. **session-db.ts 行数**：633 → 812
5. **agent-loop.ts 行数**：583 → 646
6. **D-013 SQLite WAL**：标记为已解决（session-db.ts:56 和 kb-db.ts:52 已执行 `db.pragma("journal_mode = WAL")`）
7. **D-007 ToolRateLimiter**：标记为已解决（已在 agent-loop.ts:53 导入、line 117 实例化、tool-factory.ts:121-156 调用 acquire/release）
8. **D-004 死代码行数**：520 行 → ~2,246 行
9. **ToolRateLimiter 状态**：从"未装载"更正为"已装载运行"
10. **IPC 通道描述**：从"49 通道"更正为"49 路由 + 3 本地通道"
