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
- [x] docs/arch/04-tools-subsystem.md:工具注册/路由/权限模型 + 25 个工具 v0.8 矩阵 + buildTool 横切关注点(hook+遥测+限流)+ Agent vs AgentRegistry 区分 —— 见 #5
- [ ] docs/arch/05-persistence.md:SqliteStore 通用 CRUD + 各 Store + migration,加 ER 图(mermaid)
- [x] docs/arch/06-knowledge-subsystems.md:wiki 目录镜像树 + archivist 增量扫描 + 摘要懒加载(v0.8 本次刚改),务必同步 —— 见 #2
- [x] docs/arch/07-renderer-and-ipc.md:data-change-hub + data-sync + IPC ROUTE_MAP 派生 + non-2xx reject —— 见 #3
- [ ] docs/visualization/code-graph-data.json 与 src/ 当前结构对齐(27k 行,需谨慎,优先核对顶层节点而非全量重生成)
- [x] docs/arch/08-cross-cutting.md:后端子进程生命周期 / 全局错误兜底(v0.8 本次刚加) —— 见 #4
- [ ] 新增 docs/visualization/ 下可交互页:数据流(data-change-hub 推送)、wiki 懒加载树演示
- [ ] docs/arch/02-module-structure.md §2.1 边界约束提到 "test-seed.ts 有 type-only import" —— 核对是否仍准确(test-seed.ts 在 §2 表里标 n/a 行数,可能已移除/改名)
- [ ] docs/arch/03-runtime-engine.md §1 表 "subagent-delegation.ts(326) 已废" —— 核对 v0.8 Agent action 工具落地后该文件是否还在 src/ 实际被 import(若纯死代码可标 ✅ 删除候选)
- [ ] docs/arch/07-renderer-and-ipc.md §3.7 mermaid 拓扑图仍是 v0.7 store 集合 —— 下次可补 project/requirement/wiki/cron/notification store 节点 + data:changed 边(本次只改文字,未动图)
- [ ] docs/arch/04-tools-subsystem.md 或 08-cross-cutting.md:核对 orchestrate-handlers.ts / pm-handlers.ts 的 main 进程单例(ConfirmRegistry / PmService)为什么必须留主进程而不能下放 REST(07 §2.5 ① 提到但未展开)—— **08 §12.1 已部分回答(ABI 边界),但 ConfirmRegistry/PmService 单例本身未展开,留作下次**
- [ ] docs/arch/08-cross-cutting.md §12.3 自愈无退避策略 + §12.5 uncaughtException 不 exit —— 已在 §12.7 评价里标 open question,下次可补"重启计数 + 通知主进程弹窗"的具体设计提案(若用户认可)
- [ ] docs/arch/08-cross-cutting.md §2.4 "30 个事件 / 23 个未装载" 计数来自旧版,#1 已在 02/03 修正 hook 清单 —— 08 §2.4 的具体事件表还是旧的(本次只改了 §2.2/§2.3/§2.5/§2.6,没动 §2.4 表),下次可把 §2.4 表与 02 §3.2 实际注册清单对齐

## Progress log(最新在上)
<!-- 每次触发追加一行: #N | <time> | <做了什么> | files | <commit> -->
- #5 | 2026-06-26 21:51 | 重写 04-tools-subsystem.md 与 v0.8 工具子系统对齐(此前文档仍是 ≤ v0.7 视角,21 个工具 + buildAgentTools internal/CLI 二分)。改:① §1 标题与正文从"三层工具分类(built-in/MCP/Agent-as-Tool)"改为"物理来源(2 层) + 语义 category(9 类)",mermaid 图重画,补 v0.8 重要变更说明(原 Agent Tools 第三层取消 + 8 个 zero-admin → 4 action 工具 + Assistant→Platform 改名);② §2 buildTool 行号 92-211 → 163-273;新增 §2.0「buildTool 内置的横切关注点」(PreToolUse 阻断 hook / rateLimiter / 真正 execute / PostToolUse+PostToolUseFailure hook / recordToolUsage 遥测打点 v0.8 P3 §7.7 #4 / truncateResult),这是 v0.8 关键架构提升,此前文档完全没提;③ §2.2 extractInputFields 行号 249-273 → 324-349,补 enum 字段;④ §3 矩阵从 17 行扩到 25 行:新增 CreateRequirement/CreateRequirementWithDoc/Orchestrate/verify(workflow 域)+ Project/AgentRegistry/Cron/Wiki/Platform(management 域),Assistant 改 Platform 并加 RENAMED_TOOLS 说明,Wait 从 task 改为正确的 runtime(核对 src),每行加 CONDITIONAL 门控列,补 v0.8 memory-hooks 删除与同名陷阱(Agent ≠ AgentRegistry)说明;⑤ §5 完全重写——原 buildAgentTools internal/CLI 二分已废,改为 §5.1 Agent 委派工具(agent.ts,action=list/delegate,v0.8 sessionId=undefined 隔离修复跨 agent 写竞争)+ §5.2 AgentRegistry 注册表 CRUD(agent-tool.ts,7 个 action,toolPolicy MERGE 语义,zero 保护,summary 防 context 泛滥);⑥ §6 buildToolsSet 签名从 4 参数改 3 参数(agentTools 参数已删),补"tools map 优先于 autoApprove"的隐含契约;⑦ §8 执行链 mermaid 时序图重画——加 PreToolUse blocked 分支、rateLimiter acquire/release、recordToolUsage 打点(成功/失败两条路径)、truncateResult,删除原 ctx.emit(tool_end) 误述;⑧ §9 安全表删 stale 路径 assistant-tools.ts:29 BLOCKED_FILES(文件已不存在),改写 Platform redactSensitive 输出层、加 PreToolUse 阻断与子 Agent 委派隔离两行、修 evaluateToolCall 行号 core/tool-policy.ts:37;⑨ §12.1 加 buildTool 包装层 / action 合并 / CONDITIONAL 自动收口 / 委派隔离修复 4 项做对了;§12.2 删"internal 共享 DB 写竞争"陈旧评价(v0.8 已修),改为 requiresConfirmation 死字段 / 同名陷阱 / redactSensitive 是输出层补丁 / evaluateToolCall 与 buildToolsSet 双处读 blockedTools 的 drift 风险;⑩ §13 一图总览 21 entries → 25 entries/9 categories,加 buildTool 包装层节点 + RENAMED_TOOLS 节点,标注 agentTools 参数已取消。源码逐行核对:tools/index.ts:70-110,112-126,140-160,157,163-241,195-203 / tools/tool-factory.ts:58-67,163-273,178-235,274,324-349 / tools/agent.ts:1-60,46 / tools/agent-tool.ts:138-260,165,183 / core/tool-registry.ts:65-76,76(RENAMED_TOOLS) / core/tool-policy.ts:37-70 / mcp-tools/platform-tools.ts(全文,redactSensitive) / mcp-tools/fetch-tools.ts:487(WebFetch category) / mcp-tools/sequential-thinking-tools.ts:26-75 | docs/arch/04-tools-subsystem.md | 7f8eac1
- #4 | 2026-06-26 21:20 | 补 08-cross-cutting.md 缺失的 v0.8 后端子进程生命周期 + 全局错误兜底。新增 §12(7 小节 + mermaid flowchart):§12.1 为什么后端是子进程(better-sqlite3 ABI 隔离,dev spawn / packaged fork)、§12.2 启动握手协议(--port=0 + stdout JSON ready 行 + 30s 超时 + stderr 桥接到 logger)、§12.3 自愈(_shuttingDown flag 防竞争 + 重启 fire-and-forget + 端口会变)、§12.4 优雅关闭三段式(stdin shutdown → 5s SIGTERM → 3s SIGKILL)+ Windows SIGTERM/SIGKILL 无语义标注、§12.5 process.on 兜底(只 log 不 exit 的取舍 + stderr→logger 链路)、§12.6 端口暴露与 ipc-proxy 关系、§12.7 架构师评价(4 做对了 + 4 可改进)。同时修正 §2.5 已注册 handler 表(删已废 memory-hooks,补 notification/provider-options/todo-cleanup/extraction/tool-execution hooks,补注册顺序说明)、§2.2/§2.3/§2.6 把 first-writer-wins 改为正确的 "blocked 短路 + 字段 merge last-writer-wins"(与 02/03 #1 一致)、§2.3 时序图重画、§11 安全表 Renderer↔Backend 行从"约 140 代理通道"改为 v0.8 实际(120+ 代理 + 17 LOCAL + 3 INVOKE_NOT_PROXIED + ROUTE_MAP 派生)、§13 清单加两行(后端生命周期 ✅ / 全局错误兜底 ⚠️)。源码逐行核对:backend-spawn.ts:36,56-132,134-164,166-168 / server/index.ts:86-96,110-128 / runtime/hooks/index.ts:32-60 | docs/arch/08-cross-cutting.md | 782c1c3
- #3 | 2026-06-26 20:51 | 对齐 07-renderer-and-ipc.md 与 v0.8 IPC 层实际。改:① §1 store 计数 10→16(含 data-sync helper + project/requirement/wiki/cron/notification stores);② §2.2 R 表从"约 140 项"改为"约 120+ 项,按 26 个域分块注释"+ buildReq 的 params/body/query 三出口说明 + path 占位 encodeURIComponent;③ §2.3.1 data-change-hub 流程图细化(白名单 gate / coalesce / 单独 win.send 防 agent:event 污染)+ 新增"实际订阅矩阵"表(5 collection × 5 store,标 subscribeDataChange vs subscribeListDataChange + 增量策略);④ §2.5 重写"契约例外"——三组集合(LOCAL_CHANNELS 17 项含 orchestrate/pm-handlers / INVOKE_BUT_NOT_PROXIED 3 项 / 退役 agent-as-tool 反向断言)+ 关键澄清 ROUTE_MAP 是测试从 ipc-proxy.ts 源码正则派生而非手写常量 + 标注 search-provider:* 已 v0.8 清理;⑤ 新增 §2.6 v0.8 non-2xx reject(ipc-proxy.ts:324-337,过去静默 resolve 吞 4xx/5xx,现在 throw 带 status+path+excerpt);⑥ §4 AppLayout handler 表 11→14(补 ask_user / requirement_notification / step_failure / verification_failure + message_end 不带 usage 的历史 bug 说明);⑦ §3.2 store 列表补全 v0.8 工作流域 store;⑧ §7 方法计数 150→149 + ROUTE_MAP 派生说明;⑨ §12.2 改写"手写契约"评价 + non-2xx 落地但调用方 try/catch 仍欠缺。源码核对:ipc-proxy.ts:51-274,278-349,355-406 / data-change-hub.ts:31-107 / data-sync.ts:30-70 / rest-routers.test.ts:480-527 / preload/index.ts:87-110,171-174 / AppLayout.tsx:100-205 / store/*.ts 订阅点(agent:136/cron:127/project:90/requirement:184/wiki:198) | docs/arch/07-renderer-and-ipc.md | 15c0d6f
- #2 | 2026-06-26 20:35 | 在 06-knowledge-subsystems.md 新增 §2.5「Wiki 体的磁盘镜像树布局(v0.8 P1 §10.1)」+ §2.6「archivist 增量扫描与摘要懒加载(v0.8 M2)」。§2.5 覆盖:WIKI_DISK_ROOT 隔离根 + isInsideWikiDisk FS 隔离、diskPathFor 路径推导规则表(folder=目录/leaf=文件,global/container/subtree/regular 四类)、leaf→folder promote、改名/reparent 时正文 rename 跟随、migrateWikiDiskLayout 启动一次性幂等迁移、writeNodeDetail/readNodeDetail 永远走推导路径不信任 docPointer、拆库+镜像树的动机。§2.6 覆盖:WikiSkeletonService 命名澄清、buildSkeleton/rescanProjectFull 入口、(archivist,project) git cursor 增量(mermaid 时序图)、ensureSummary 懒加载物化(扫描期零读盘 / 首次 expand 付钱)、唯一调用方 + scope/type 护栏。源码逐行核对:wiki-node-store.ts:197,274,447-469,471-510,584-627,637-740,757-819 / fresh-db-seed.ts:325-337 / wiki-skeleton-service.ts:1-60,160-250,460-540,630-660 / archivist-git.ts:10-15 | docs/arch/06-knowledge-subsystems.md | 5f4dd02
- #1 | 2026-06-26 19:45 | 新增 Hook 系统专节(执行模型 last-writer-wins + blocked 短路 + 错误吞掉、事件→触发点→handler 全景表、PreLLMCall 现查+注入模式、含 mermaid 时序图);修正 02 §3.2 hooks 文件清单(删 memory-hooks、补 notification/provider-options/todo-cleanup/extraction、改注释为实际注册顺序)与 §2 表 hook-registry 描述(改 "first-writer-wins" 为正确的 "last-writer-wins merge + blocked 短路");02 §3.2 加 v0.8 memory-hooks 删除说明。源码核对:hook-registry.ts:78-91 / hook-types.ts:29-39 / hooks/index.ts:47-59 / agent-loop.ts:228,251,296,312,466,497,678,705,726,766 | docs/arch/02-module-structure.md, docs/arch/03-runtime-engine.md | 08117f6

## Open questions(给用户的)
<!-- 拿不准的写这里 -->
- **[new, #5]** `meta.requiresConfirmation` 字段在 buildTool/tool-registry/registerRuntimeTools 三处都已贯穿(写进 ToolMeta),但 `agent-loop.ts` 不读它——是死字段。是否要落地一个 PreToolUse handler 把它真正接起来(执行前 AskUser 弹窗)?这会改变"工具自动执行"的默认体感,需要用户拍板默认行为(哪些工具默认 ask、哪些不 ask)。
- **[new, #5]** `Agent`(委派) vs `AgentRegistry`(注册表 CRUD)两个工具名前缀相同,LLM 容易混淆(工具描述里已加一句澄清)。长期是否把 `AgentRegistry` 改名为 `RoleRegistry` / `ManageAgents` 更直观?需权衡 RENAMED_TOOLS 迁移成本 + 用户已有 toolPolicy 配置。
- **[new, #5]** `evaluateToolCall`(core/tool-policy.ts) 与 `buildToolsSet`(tools/index.ts) 双处独立读 `blockedTools`,数据源一致但维护时易 drift。是否要合并成单一真值源?
- **[new, #4]** backend 自愈(`backend-spawn.ts:117-130`)目前无重启计数/退避:连续崩溃会无限静默重启,用户感知不到 backend 死了。是否要加"N 次失败后通知主进程弹用户提示"?
- **[new, #4]** `server/index.ts:86-96` 的 `process.on("uncaughtException", ...)` 只 log 不 exit。这意味着 backend 即使状态已损坏仍继续服务(可能写脏数据)。是否应改为"log + 主动 `process.exit(1)`"让 §12.3 自愈路径接管?权衡是频繁重启可能比脏跑更糟,需要用户拍板默认行为。
- 暂无历史遗留。#1~#5 改进全部基于源码逐行核对,无猜测。
