# 一夜文档循环 · 追踪文件

> 跨触发记忆。每次全新 session 读这里接着干。只有这个文件 + charter 是状态来源。

## Vision
把 zero-core 的 docs/ 做得更清晰、更详实、结构更好、更多可视化/可交互。允许打破现有结构。
独立分支 docs/overnight-20260625,明早人审后合并。

## 规则摘要
- 只动 docs/。每次一个连贯改进就 commit 收工。
- 不 push/merge/动源码/跑构建。
- commit 带 Co-Authored-By: Claude <noreply@anthropic.com>。

## 候选 backlog(初始种子,按价值排序,可改)
- [ ] 核对 docs/arch/02-module-structure.md 与 src/ 实际模块树,补/改过时路径
- [ ] 核对 docs/basic/file-structure.md 与当前目录布局
- [x] docs/arch/03-runtime-engine.md:补厚 AgentLoop / hook 机制(PreLLMCall/PostTurnComplete),加 mermaid 序列图 —— 见 #1
- [ ] docs/arch/04-tools-subsystem.md:工具注册/路由/权限模型,加交互式工具列表页(visualization/)
- [ ] docs/arch/05-persistence.md:SqliteStore 通用 CRUD + 各 Store + migration,加 ER 图(mermaid)
- [ ] docs/arch/06-knowledge-subsystems.md:wiki 目录镜像树 + archivist 增量扫描 + 摘要懒加载(v0.8 本次刚改),务必同步
- [ ] docs/arch/07-renderer-and-ipc.md:前端按需拉取(v0.8 本次刚改)+ data-change-hub + IPC ROUTE_MAP
- [ ] docs/visualization/code-graph-data.json 与 src/ 当前结构对齐(27k 行,需谨慎,优先核对顶层节点而非全量重生成)
- [ ] docs/arch/08-cross-cutting.md:后端子进程生命周期 / 全局错误兜底(v0.8 本次刚加)
- [ ] 新增 docs/visualization/ 下可交互页:数据流(data-change-hub 推送)、wiki 懒加载树演示
- [ ] docs/arch/02-module-structure.md §2.1 边界约束提到 "test-seed.ts 有 type-only import" —— 核对是否仍准确(test-seed.ts 在 §2 表里标 n/a 行数,可能已移除/改名)
- [ ] docs/arch/03-runtime-engine.md §1 表 "subagent-delegation.ts(326) 已废" —— 核对 v0.8 Agent action 工具落地后该文件是否还在 src/ 实际被 import(若纯死代码可标 ✅ 删除候选)

## Progress log(最新在上)
<!-- 每次触发追加一行: #N | <time> | <做了什么> | files | <commit> -->
- #1 | 2026-06-26 19:45 | 新增 Hook 系统专节(执行模型 last-writer-wins + blocked 短路 + 错误吞掉、事件→触发点→handler 全景表、PreLLMCall 现查+注入模式、含 mermaid 时序图);修正 02 §3.2 hooks 文件清单(删 memory-hooks、补 notification/provider-options/todo-cleanup/extraction、改注释为实际注册顺序)与 §2 表 hook-registry 描述(改 "first-writer-wins" 为正确的 "last-writer-wins merge + blocked 短路");02 §3.2 加 v0.8 memory-hooks 删除说明。源码核对:hook-registry.ts:78-91 / hook-types.ts:29-39 / hooks/index.ts:47-59 / agent-loop.ts:228,251,296,312,466,497,678,705,726,766 | docs/arch/02-module-structure.md, docs/arch/03-runtime-engine.md | (pending)

## Open questions(给用户的)
<!-- 拿不准的写这里 -->
- 暂无。本次改进全部基于源码逐行核对,无猜测。
