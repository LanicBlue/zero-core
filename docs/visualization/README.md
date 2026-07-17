# docs/visualization — 可视化快照

本目录包含手工交互页、SVG 和由源码分析生成的 code graph。它们适合帮助理解，不是当前架构的独立事实源。

| 文件 | 类型 | 当前用途 |
| --- | --- | --- |
| `agent-loop-anatomy.html` / `.svg` | 退役手工图 | 保留 2026-06 的旧 Hook 结构；**不要用于当前实现**，改读 [`../arch/03-runtime-engine.md`](../arch/03-runtime-engine.md) |
| `agent-loop-architecture.html` | 退役手工图 | 含已删除 Hook/handler，仅作历史重构快照 |
| `compression-flow.html` | 历史比较演示 | 旧压缩策略思想实验，不是当前算法、benchmark 或 SLO |
| `data-sync-flow.html` | 手工交互图 | data-change/流事件概念；已标记为快照，表名可能随迁移变化 |
| `tool-playground.html` | 独立演示 | 工具交互原型，不代表生产工具注册表 |
| `code-graph.html` / `code-graph-data.json` | 生成产物 | `npm run build:codegraph` 更新结构，但生成器的手工描述表仍有旧术语；只把它当导航 |

使用规则：

- 生产路径与术语以 [`../arch/`](../arch/README.md) 和源码为准。
- 修改模块结构后可运行 `npm run build:codegraph`，但生成器本身是启发式静态分析，无法证明运行时接线。
- 手工图出现 `turns`、`turn_state`、MemoryNode 或 KB/RAG 等名称时，应视为历史快照；当前对应关系见 [`../arch/12-glossary.md`](../arch/12-glossary.md)。
