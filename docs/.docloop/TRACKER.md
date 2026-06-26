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
- [ ] docs/arch/03-runtime-engine.md:补厚 AgentLoop / hook 机制(PreLLMCall/PostTurnComplete),加 mermaid 序列图
- [ ] docs/arch/04-tools-subsystem.md:工具注册/路由/权限模型,加交互式工具列表页(visualization/)
- [ ] docs/arch/05-persistence.md:SqliteStore 通用 CRUD + 各 Store + migration,加 ER 图(mermaid)
- [ ] docs/arch/06-knowledge-subsystems.md:wiki 目录镜像树 + archivist 增量扫描 + 摘要懒加载(v0.8 本次刚改),务必同步
- [ ] docs/arch/07-renderer-and-ipc.md:前端按需拉取(v0.8 本次刚改)+ data-change-hub + IPC ROUTE_MAP
- [ ] docs/visualization/code-graph-data.json 与 src/ 当前结构对齐
- [ ] docs/arch/08-cross-cutting.md:后端子进程生命周期 / 全局错误兜底(v0.8 本次刚加)
- [ ] 新增 docs/visualization/ 下可交互页:数据流(data-change-hub 推送)、wiki 懒加载树演示

## Progress log(最新在上)
<!-- 每次触发追加一行: #N | <time> | <做了什么> | files | <commit> -->

## Open questions(给用户的)
<!-- 拿不准的写这里 -->
