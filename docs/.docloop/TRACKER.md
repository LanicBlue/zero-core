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
- [x] docs/arch/06-knowledge-subsystems.md:wiki 目录镜像树 + archivist 增量扫描 + 摘要懒加载(v0.8 本次刚改),务必同步 —— 见 #2
- [x] docs/arch/07-renderer-and-ipc.md:data-change-hub + data-sync + IPC ROUTE_MAP 派生 + non-2xx reject —— 见 #3
- [ ] docs/visualization/code-graph-data.json 与 src/ 当前结构对齐(27k 行,需谨慎,优先核对顶层节点而非全量重生成)
- [ ] docs/arch/08-cross-cutting.md:后端子进程生命周期 / 全局错误兜底(v0.8 本次刚加)
- [ ] 新增 docs/visualization/ 下可交互页:数据流(data-change-hub 推送)、wiki 懒加载树演示
- [ ] docs/arch/02-module-structure.md §2.1 边界约束提到 "test-seed.ts 有 type-only import" —— 核对是否仍准确(test-seed.ts 在 §2 表里标 n/a 行数,可能已移除/改名)
- [ ] docs/arch/03-runtime-engine.md §1 表 "subagent-delegation.ts(326) 已废" —— 核对 v0.8 Agent action 工具落地后该文件是否还在 src/ 实际被 import(若纯死代码可标 ✅ 删除候选)
- [ ] docs/arch/07-renderer-and-ipc.md §3.7 mermaid 拓扑图仍是 v0.7 store 集合 —— 下次可补 project/requirement/wiki/cron/notification store 节点 + data:changed 边(本次只改文字,未动图)
- [ ] docs/arch/04-tools-subsystem.md 或 08-cross-cutting.md:核对 orchestrate-handlers.ts / pm-handlers.ts 的 main 进程单例(ConfirmRegistry / PmService)为什么必须留主进程而不能下放 REST(07 §2.5 ① 提到但未展开)

## Progress log(最新在上)
<!-- 每次触发追加一行: #N | <time> | <做了什么> | files | <commit> -->
- #3 | 2026-06-26 20:51 | 对齐 07-renderer-and-ipc.md 与 v0.8 IPC 层实际。改:① §1 store 计数 10→16(含 data-sync helper + project/requirement/wiki/cron/notification stores);② §2.2 R 表从"约 140 项"改为"约 120+ 项,按 26 个域分块注释"+ buildReq 的 params/body/query 三出口说明 + path 占位 encodeURIComponent;③ §2.3.1 data-change-hub 流程图细化(白名单 gate / coalesce / 单独 win.send 防 agent:event 污染)+ 新增"实际订阅矩阵"表(5 collection × 5 store,标 subscribeDataChange vs subscribeListDataChange + 增量策略);④ §2.5 重写"契约例外"——三组集合(LOCAL_CHANNELS 17 项含 orchestrate/pm-handlers / INVOKE_BUT_NOT_PROXIED 3 项 / 退役 agent-as-tool 反向断言)+ 关键澄清 ROUTE_MAP 是测试从 ipc-proxy.ts 源码正则派生而非手写常量 + 标注 search-provider:* 已 v0.8 清理;⑤ 新增 §2.6 v0.8 non-2xx reject(ipc-proxy.ts:324-337,过去静默 resolve 吞 4xx/5xx,现在 throw 带 status+path+excerpt);⑥ §4 AppLayout handler 表 11→14(补 ask_user / requirement_notification / step_failure / verification_failure + message_end 不带 usage 的历史 bug 说明);⑦ §3.2 store 列表补全 v0.8 工作流域 store;⑧ §7 方法计数 150→149 + ROUTE_MAP 派生说明;⑨ §12.2 改写"手写契约"评价 + non-2xx 落地但调用方 try/catch 仍欠缺。源码核对:ipc-proxy.ts:51-274,278-349,355-406 / data-change-hub.ts:31-107 / data-sync.ts:30-70 / rest-routers.test.ts:480-527 / preload/index.ts:87-110,171-174 / AppLayout.tsx:100-205 / store/*.ts 订阅点(agent:136/cron:127/project:90/requirement:184/wiki:198) | docs/arch/07-renderer-and-ipc.md | 15c0d6f
- #2 | 2026-06-26 20:35 | 在 06-knowledge-subsystems.md 新增 §2.5「Wiki 体的磁盘镜像树布局(v0.8 P1 §10.1)」+ §2.6「archivist 增量扫描与摘要懒加载(v0.8 M2)」。§2.5 覆盖:WIKI_DISK_ROOT 隔离根 + isInsideWikiDisk FS 隔离、diskPathFor 路径推导规则表(folder=目录/leaf=文件,global/container/subtree/regular 四类)、leaf→folder promote、改名/reparent 时正文 rename 跟随、migrateWikiDiskLayout 启动一次性幂等迁移、writeNodeDetail/readNodeDetail 永远走推导路径不信任 docPointer、拆库+镜像树的动机。§2.6 覆盖:WikiSkeletonService 命名澄清、buildSkeleton/rescanProjectFull 入口、(archivist,project) git cursor 增量(mermaid 时序图)、ensureSummary 懒加载物化(扫描期零读盘 / 首次 expand 付钱)、唯一调用方 + scope/type 护栏。源码逐行核对:wiki-node-store.ts:197,274,447-469,471-510,584-627,637-740,757-819 / fresh-db-seed.ts:325-337 / wiki-skeleton-service.ts:1-60,160-250,460-540,630-660 / archivist-git.ts:10-15 | docs/arch/06-knowledge-subsystems.md | 5f4dd02
- #1 | 2026-06-26 19:45 | 新增 Hook 系统专节(执行模型 last-writer-wins + blocked 短路 + 错误吞掉、事件→触发点→handler 全景表、PreLLMCall 现查+注入模式、含 mermaid 时序图);修正 02 §3.2 hooks 文件清单(删 memory-hooks、补 notification/provider-options/todo-cleanup/extraction、改注释为实际注册顺序)与 §2 表 hook-registry 描述(改 "first-writer-wins" 为正确的 "last-writer-wins merge + blocked 短路");02 §3.2 加 v0.8 memory-hooks 删除说明。源码核对:hook-registry.ts:78-91 / hook-types.ts:29-39 / hooks/index.ts:47-59 / agent-loop.ts:228,251,296,312,466,497,678,705,726,766 | docs/arch/02-module-structure.md, docs/arch/03-runtime-engine.md | 08117f6

## Open questions(给用户的)
<!-- 拿不准的写这里 -->
- 暂无。本次改进全部基于源码逐行核对,无猜测。
