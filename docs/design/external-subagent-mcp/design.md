# Design:external-subagent-mcp

- **状态**:② design(讨论细化)
- **提出**:2026-07-08(issue);design 2026-07-09
- **类型**:架构 / 集成
- **依赖**:[`../../archive/tool-decoupling/`](../../archive/tool-decoupling/)(工具纯函数化 + `exposable` + `CallerScope`)— 已合并 ✅

> **实现状态（2026-07-16）**：本设计尚未进入 plan/acceptance，也未在生产入口接通外部 Agent 或 MCP host。下文“已有”只描述设计基线能力，“目标/组件”均为提案。

## 目标(本 effort 范围,用户已定)

1. **外部 agent 当 subagent**:把任务委派给外部 agent 进程(Claude Code / Codex),拿回结果。
2. **MCP host 暴露内部工具**:我们 host 一个 MCP server,把选定的**应用级内部工具**(Wiki / Platform / 文件读类)暴露给外部 agent,让它们能看到本项目上下文。
3. **scope 沙箱**:parent 委派时签发 scope token,外部 agent 持 token 连 MCP,server 按 token 解析沙箱(项目 + 读写限制 + 工具集)。

**非目标**(本层不做,后续 effort 再开):
- 不做"我们当 MCP client 接外部 MCP server"(那是反向,现有 `mcp-store` 配置形态另说)。
- 不做通用 config 驱动的 agent 插件系统(用户选:Claude Code + Codex **硬编码**两个 adapter;两个模块共享一个极简 TS 接口属正常代码复用,不是插件化)。
- 不做 OS 级强沙箱(容器/chroot)。外部 agent 用其**原生权限**在 workspace 跑(信任模型 = 用户显式委派给可信二进制;见决策 6)。

## 顶层不变量:父 agent 视角下内外 subagent **无差别**(uniformity)

用户定调(2026-07-09):**父 agent 用内部 subagent 和外部 subagent 在使用上完全无差别**。底层实现可讨论,但接口层必须统一:

- **同一委派入口**:父 agent 的 delegate/agent 工具只认 **target**(target picker 里的一项),不认 engine。target 是内部 agent 还是外部 agent,对 LLM 不可见。
- **同一套 Task 工具**:TaskGet / TaskList / TaskKill / TaskResume / TaskFinish 对任何 taskId 都work,不因 engine 分叉。
- **同一种进度/结果语义**:status 迁移(running→completed/failed/interrupted)、progress(step/current_tool)、usage(tokens)、result 文本 —— 内外同构。
- **engine 是 target 属性,接口层之下 dispatch**:**顶层只把名字 `"Claude"` 和 `"Codex"` 解析为外部 agent**(用户 2026-07-09 裁决 #1);其余名字一律走内部 agent。`resolveTarget(name)` → name ∈ {`Claude`,`Codex`} ? external(对应 engine) : internal agent 查表。无独立 engine 参数、无 `external:` 前缀 —— **名字本身即 dispatch key**。所有 engine 分支(delegate、resume、kill、重启恢复)都在 delegator 层以下,LLM 看到的 API 零 engine 分支。
  - **保留名**:`Claude` / `Codex` 两个名字保留给外部 agent;内部 agent 不可用这两个名(若重名,外部解析优先)。

这条不变量主导下面所有组件设计 —— #1/#2/#3 的答案都是它的推论。

## 现状(真相源)

| 件 | 现状 | 文件 |
|----|------|------|
| 工具 `execute` | 纯函数 `(input, callerCtx) => ToolResult` | `src/tools/tool-factory.ts:306` |
| `exposable` 标记 | 已在 `ToolMeta`(默认按类别) | `src/tools/tool-factory.ts:47-62` |
| `CallerScope` | `{ projectId, readOnly?, allowedTools? }` 已定义 | `src/tools/types.ts:230-234` |
| `CallerCtx` | 含 `caller: "internal"\|"ui"\|"external:mcp"` + `scope` | `src/tools/types.ts:253-372` |
| UI dispatcher | 已有 `tool-execution-router`(按 CallerCtx 派发,sub-5) | `src/server/tool-execution-router.ts` |
| subagent-delegator | **只**起内部子 AgentLoop,无外部 target | `src/runtime/subagent-delegator.ts` |
| HTTP server | express + http,已挂 N 个 router | `src/server/index.ts` |
| MCP 协议 | `@modelcontextprotocol/sdk` 在 package.json **零 import**;`mcp-store` 仅存配置(client 形态) | — |
| delegated_tasks | 列齐(id/target_agent_id/model_id/turns/tokens/…) | `src/server/session-db.ts:203` |

**地基齐了** —— 本 effort 纯做 MCP host + 外部 adapter + 委派接线,不动工具签名。

## 架构总览

```
                parent AgentLoop (内部)
                       │ delegateTask(target="Claude")  ← 名字即 dispatch key
                       ▼
            ┌──────────────────────┐
            │  subagent-delegator  │  ① resolveTarget("Claude") → external
            │  (external 分支)     │  ② mint scope token T → in-mem map
            └──────────┬───────────┘  ③ insert delegated_tasks(engine='claude')
                       │              ④ spawn 外部进程(mcp-config 指向本机 MCP host + Bearer T)
                       │
            ┌──────────▼───────────┐
            │  claude-adapter /    │  spawn `claude -p … --mcp-config … --dangerously-skip-permissions`
            │  codex-adapter       │  spawn `codex exec --json -c approval_policy=never …`
            │  (硬编码,共享接口)  │  解析 stream-json/ndjson → 进度事件 + 最终文本
            └──────────┬───────────┘
                       │ 子进程
        ┌──────────────┴───────────────┐
        ▼                              ▼
  外部 agent进程              连本机 MCP host(HTTP,loopback)
  (claude/codex,              ┌─────────────────────────────┐
   自带 file/bash             │  mcp-host(挂在主进程        │
   在 workspace 跑)           │   express server,/mcp 路由) │
                              │  ① 验 Bearer T → 解 CallerScope│
                              │  ② 列工具 = exposable ∩     │
                              │     allowedTools(∩ readOnly)│
                              │  ③ buildCallerCtx(          │
                              │     caller="external:mcp",  │
                              │     scope, projectId,…)     │
                              │  ④ 复用 tool-execution-     │
                              │     router 的派发路径执行    │
                              └─────────────────────────────┘
```

## 组件设计

### 1. MCP host(主进程内,HTTP transport)

**形态**:在现有 express server(`src/server/index.ts`)上加 `/mcp` 路由,跑 `@modelcontextprotocol/sdk` 的 **Streamable HTTP transport**(loopback only,127.0.0.1)。用 SDK 的 `McpServer` 注册工具,工具 handler 转调内部派发。

**工具集**:启动时遍历 ToolRegistry,对每个 `meta.exposable === true` 的工具注册一个 MCP tool。handler 收到调用后:
- 从请求的 `Authorization: Bearer <T>` 解出 token → 查 in-mem `tokenStore` → 得 `CallerScope` + `delegatingTaskId` + `expiresAt`。
- 过滤本次可见工具:`exposable && (scope.allowedTools 为空 ? 全部 : ∈ allowedTools) && (scope.readOnly ? meta.isReadOnly : true)`。
- 建 `CallerCtx { caller: "external:mcp", scope, projectId, workingDir: 项目 workspace, … }`(不带 sessionId / todos / taskRegistry → session 作用域工具天然不可达)。
- **复用** `tool-execution-router` 已有的派发逻辑(同一套 CallerCtx→execute→format),不另造执行路径(呼应 [[../../../archive/tool-decoupling]] sub-5)。
- 返回结果给外部 agent(MCP tool result)。

**生命周期**:app 启动即起 `/mcp`(端口复用现有 server 的端口,无新端口);tokenStore 为内存 Map,app 重启清空(外部进程也随重启死亡,无持久化必要)。

### 2. Scope token(内存不透明 id)

- `tokenStore: Map<T, { scope: CallerScope; delegatingTaskId; expiresAt; createdAt }>`。
- `T` = `crypto.randomUUID()`(不透明,非 JWT;够用且零依赖)。
- 签发:delegator 外部委派时 mint,写 Map。
- 验证:host 中间件查 Map + 校验 expiresAt(默认 = 委派超时)。
- 撤销:委派结束(成功/失败/超时/中断)即 `tokenStore.delete(T)`。
- **不持久化**:外部进程活不过 app 重启;重启后旧 token 失效是期望行为。

### 3. 外部 agent adapter(Claude Code + Codex,硬编码)

共享一个极简接口(纯代码复用,**非** config 插件系统):

```ts
interface ExternalAgentAdapter {
  kind: "claude" | "codex";
  spawn(opts: {
    task: string;                 // 委派任务 → 外部 agent 的 prompt
    cwd: string;                  // = 项目 workspace
    mcpEndpoint: string;          // http://127.0.0.1:<port>/mcp
    token: string;                // Bearer
    systemPromptAppend?: string;  // 角色提示(可选)
    timeoutSec?: number;
  }, onEvent: (ev: ExternalAgentEvent) => void): Promise<{ result: string; tokens?: number }>;
}
```

**claude-adapter**(`claude -p` headless):
```
claude --bare -p "<task>" \
  --dangerously-skip-permissions \
  --append-system-prompt "<append>" \
  --mcp-config '{"mcpServers":{"zero-core":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <T>"}}}}' \
  --output-format stream-json --verbose
```
- `--bare`:跳过自动发现 hooks/skills/CLAUDE.md,可复现(对应 [[issues/../../]] 无关)。
- `--dangerously-skip-permissions`:headless 必须 bypass,否则 bash/git 处卡死(记忆 [[feedback-headless-claude-permissions]])。
- `--output-format stream-json`:NDJSON,逐行解析 `system/init` / `stream_event`(token delta)/ `turn.completed`(usage)→ emit 进度 + 抽最终文本 + tokens。

**codex-adapter**(`codex exec` headless):
```
codex exec --json -C <cwd> -c approval_policy=never -c sandbox_mode=workspace-write "<task>"
```
- MCP server 经 **临时 config.toml** 注入(codex 的 mcp_servers 在 `~/.codex/config.toml`;per-spawn 用 `-c mcp_servers.zero-core...` 传嵌套 TOML 不便 → impl 时核实是否支持 `--config <file>` 指向生成的临时 config,或 `-c` 传 `mcp_servers.zero-core.command/url/http_headers`)。**【impl 待核实项】** codex per-spawn MCP 注入的确切机制。
- `--json`:NDJSON,解析 `thread.started` / `item.started` / `item.completed` / `turn.completed`(usage)。
- `approval_policy=never` + `sandbox_mode=workspace-write`:无人值守必需。
- system prompt:codex 无 CLI flag,走临时 `AGENTS.md` 或 `-c` instructions(impl 定)。

**两个 adapter 共享**:进程 spawn/stdout 流式读取/超时 kill/退出码判定/事件归一化(`ExternalAgentEvent` → 复用 delegator 现有 emit 链路推 UI)。

### 4. subagent-delegator 外部 target 接线

- **不增 `engine` 参数**(用户裁决 #1)。target 用现有 `target_agent_id`(= 名字)传入;`resolveTarget(name)` 见名字 ∈ {`Claude`,`Codex`} → 外部分支,否则内部(现状不变)。
- `delegateTask`:外部名字 → 走**新分支**:
  1. mint token(写 tokenStore,scope 由 callerBundle.projectId + readOnly/allowedTools 推导)。
  2. insert `delegated_tasks`(新增 `engine` 列,值 `claude`/`codex`;`target_agent_id` 存该名字;无 session_id/owner_session —— 外部进程非 AgentLoop)。
  3. 调对应 adapter.spawn,onEvent → emit 进度(更新 delegated_tasks.turns/tokens/step)。
  4. 完成 → 写 result、status;`tokenStore.delete(T)`。
  5. 超时/中断 → kill 进程、mark interrupted、撤销 token。
- **复用** delegated_tasks 表 + delegated-task-router(只读 surface,TaskTree UI 天然能看外部委派)。
- 阻塞/后台两种语义对齐现有 `delegateTask` / `delegateTaskBackground`(后台 = 立即返 taskId,进程异步跑)。

### 5. 委派工具入口(agent tool)+ Target 选择器(D5)

- 外部 agent **不**经任何额外入参暴露给 LLM。已配置+启用+测试通过的外部 agent(见组件 7)作为 **target** 出现在委派的 Target agent 选择器里(与内部 agent 同列),名字即 `Claude` / `Codex`(保留名,见顶层不变量)。
- 现有 `agent`/delegate 工具(`src/tools/agent.ts`)的 target 解析路径扩展:`resolveAgent("Claude"|"Codex")` → 命中外部 target → delegator 走外部分支(组件 4)。内部 target 路径不变。
- **管控点 = target 可用性**:外部 target 必须在设置页配置+启用+测试通过才进 picker;未配置则对 LLM 不可见。任何 agent 都能选已启用的外部 target(无 per-agent 布尔开关,D5)。

### 6. 持久化 / 可观测

- `delegated_tasks` 加列 `engine TEXT`(值 `internal`/`claude`/`codex`)。**记忆陷阱** [[feedback-fresh-db-migrations]]:同步更新 `db-migration.ts` 的 `DELEGATED_TASKS_COLUMNS` 数组,否则 fresh DB 缺列。
- 进度事件复用现有 emit → delegated task view(已有 UI,无需新页)。
- 外部进程 stdout 原始 NDJSON 可选落 debug log(排障)。

### 7. 外部 agent 配置 + 连通性测试(设置页,D5)

**形态**:设置页新增"外部 agent"区,参考 provider/MCP server 配置页风格。每个外部 agent(claude / codex)一行:
- **二进制路径**:手动填或自动探测 PATH(记录绝对路径)。
- **启用开关**:关 → 不进 target picker。
- **测试连通性按钮**:点 → 跑一次极简探测(spawn `<bin> --version` 或一条 trivial prompt,如 `claude -p "reply OK" --dangerously-skip-permissions`),判定 OK/失败 + 给出错误信息。**测试通过**才能标"可用"。
- **状态**:三态 —— 未配置 / 已配置但未测试 / 已测试可用。只有"已测试可用 + 启用"才进 target picker。

**存储**:新 `external-agent-config` store + router(CRUD,落 config.json 或独立表;参考 mcp-store 形态)。renderer 经 preload 暴露的 IPC 读写。

**Target picker 接线**:agent 委派设置里的 Target agent 下拉 = 内部 agents ∪ 已启用可用的外部 targets。外部 target 显示带来源标识(Claude Code / Codex 图标或文字)区分。

**测试 fixture**:E2E 用 `ZERO_CORE_TEST_FIXTURE` 注入 mock 外部二进制(一个吐固定 stream-json 的脚本),让"测试连通性"在 CI 可跑。

## 状态跟踪 / Task 适配 / Resume(uniformity 落地,#1/#2/#3)

> 现状真相源:Task 工具(TaskGet/List/Kill/Resume/Finish)读 delegator 上的**内存 `TaskRegistry`**(`subagent-delegator.ts:145`),由**子 AgentLoop 遥测事件**喂(`updateProgress`/`addUsage`,行 235/248);`delegated_tasks` 表是持久化镜像。现有 `TaskResume`(`task-resume.ts`)= 重启后重建内部冻结子 loop 续 interrupted turn(带 turn_seq 守卫),**仅内部**。

### #1 状态跟踪 + 数据保存(两层,内外同构)
- **外部 agent 自己的 session**:claude stream-json 吐 `session_id`、codex 吐 `thread_id` → adapter 捕获 → 持久化到 `delegated_tasks.external_session_id`(新列)。resume 前提。
- **我们的跟踪** = 与内部子 agent 同构:内存在 `TaskRegistry`、持久化在 `delegated_tasks`(status/turns/tokens/step/current_tool/result + engine + external_session_id)。
- **逐步动作**:claude tool_use/tool_result、codex item.started/completed → 归一成统一事件 → 喂 TaskRegistry + 表(见组件 8)。
- **数据产出**:外部 agent 写文件落 workspace(磁盘持久);result → delegated_tasks.result。
- **全量 transcript**:v1 **不存逐字 transcript**(外部 agent 自己 session 文件里有,靠 external_session_id 取回),只存 result+usage+progress。可定。

### #2 适配现有 Task 后台管理工具(关键:事件映射,非白送)
外部进程不是 AgentLoop、不吐遥测事件。要适配须:
1. `delegateTask` 外部分支也往 **TaskRegistry 注册**(返 taskId,与内部一致)。
2. **adapter 归一事件 → 映射成 TaskRegistry 的 updateProgress/addUsage/状态迁移** + delegated_tasks 镜像(组件 8)。
接上后 TaskGet/List/Kill/Finish 对外部 taskId 开箱即用(只读 TaskRegistry);TaskKill 外部 = kill 子进程 + 标 killed。
- **重启语义不同(重要)**:内部 interrupted task 重启后重建 loop 续跑;外部 task **进程**重启即死,但 claude/codex 的 **session 还在它们自己的存储** → 靠 external_session_id + `--resume` 重新拉起(见 #3)。故"外部 interrupted task"的 resume 走 session resume,非重建进程。

### #3 Resume(机制不同于现有 TaskResume,但接口统一)
claude `--resume <session-id>`、codex `exec resume <SESSION_ID>` 原生支持。前提 = external_session_id(已在 #1)+ adapter resume 模式。
- 现有 TaskResume = 重建内部子 loop;外部 resume = 重新 spawn 带 `--resume` + 存的 session_id + 新 prompt。两套机制。
- **uniformity 要求**:对外仍是同一个 TaskResume 入口(对 LLM 不可见),内部按 engine dispatch:internal→重建 loop(现有),external→spawn `--resume`(组件 9)。
- 外部 resume 比内部更干净:内部得重建未完成 turn(turn_seq 守卫),外部直接续它自己的 session。

### 组件 8:adapter 归一事件层 + TaskRegistry 映射(uniformity 胶水)
- 两个 adapter(claude/codex)解析各自 stream 后,都产出**同一 `ExternalAgentEvent` 形态**:`{ type: "started"|"progress"|"usage"|"completed"|"failed"; step?; currentTool?; tokens?; externalSessionId?; resultText?; error? }`。
- delegator 外部分支:注册 TaskRegistry → 订阅 adapter 事件 → 映射到 `taskRegistry.updateProgress/addUsage` + 状态迁移 + delegated_tasks 镜像更新(复用内部 sub-loop 已有的"事件→registry→表"路径,抽公共)。
- 效果:外部委派在 TaskRegistry 里跟内部子 agent **同形**,Task 工具无差别。

### 组件 9:TaskResume 按 engine 统一 dispatch
- 扩展 `TaskResume`:resolveTarget(taskId) → engine;internal→现有 `resumeTaskBackground`(重建 loop);external→`adapter.resume(externalSessionId, newPrompt)`(spawn `--resume`),同样非阻塞、经组件 8 的事件映射回流。
- **重启恢复**:`markRunningDelegatedTasksInterrupted`(已有)扫到外部 interrupted task → 标 interrupted(进程已死,不可重建)→ 经 external_session_id 由 TaskResume 外部分支恢复。

## 决策(含理由)

| # | 决策 | 理由 |
|---|------|------|
| D1 | **MCP transport = 主进程内 HTTP(Streamable HTTP,loopback)**,不另起 stdio bridge 进程 | 主进程直接访问 store/CallerCtx/tool 派发;复用现有 express server,零新进程零 back-channel IPC。stdio 方案要造独立 entry + 回连 IPC,复杂度高一档。claude/codex 都支持 HTTP/SSE url 形态 MCP server。 |
| D2 | **Token = 内存不透明 UUID Map**,非 JWT | 外部进程活不过 app 重启;重启失效是期望。零依赖、撤销 O(1)。JWT 的无状态优势在此场景无意义(token 必须能即时撤销)。 |
| D3 | **Tool 派发复用 tool-execution-router 路径**(CallerCtx→execute) | 呼应 tool-decoupling:UI/external 走同一条派发,单一执行路径,行为一致。 |
| D4 | **两个硬编码 adapter 共享极简 `ExternalAgentAdapter` 接口** | 用户定调"硬编码,不抽通用层"。共享 TS 接口是正常代码复用(非 config 插件系统)。尊重选择,接口仅服务于这两个固定实现。 |
| D5 | **外部 agent 经设置页配置 + 连通性测试;启用后作为委派 target 出现在 Target agent 选择器**(用户定) | 与 provider/MCP server 的"配置后可用"模式一致,而非 per-agent 布尔开关。管控点 = target 可用性(须配置+启用+测试通过),任何 agent 都能从 target picker 选已配置的外部 target。详见组件 7。 |
| D6 | **信任模型 = 可信二进制 + workspace 边界,不做 OS 强沙箱**(用户已接受) | claude/codex 是用户已信任的二进制。外部 agent 用原生权限在 workspace 跑;readOnly 仅在我们 MCP 工具层强制。强沙箱另开 effort。 |
| D7 | **readOnly 强制点 = mint token 时 + MCP host 双重** | parent 签 token 时按 readOnly 收紧 allowedTools(去掉写类);host 再按 `meta.isReadOnly` 兜底过滤。外部 agent 自带写工具不可控,见 D6 限制说明。 |
| D8 | **codex per-spawn MCP 注入 = 临时 config.toml 方案(impl 核实)** | codex mcp_servers 在全局 config.toml;`-c` 传嵌套 TOML 不便。impl 时核实 `--config <file>` 或 `-c mcp_servers.x.*` 的确切写法。若都不可行 → 退化为临时 `~/.codex/config.toml` override(注意并发污染,需隔离)。 |

## 决策点(design→plan gate)

**已敲定**:
- **#1(用户 2026-07-09 裁决)**:外部 agent 靠**名字**识别 —— 顶层只解析 `Claude` / `Codex` 两个名字为外部 agent(见顶层不变量 + 组件 4/5)。无独立 engine 参数、无前缀。
- **D5(用户定)**:外部 agent 经设置页配置 + 连通性测试;启用且测试可用 → 作为委派 target 出现在 Target agent 选择器。**非 per-agent 开关**。
- **D6(用户接受)**:无 OS 强沙箱;信任模型 = 可信二进制 + workspace 边界。

**待讨论(以后,2026-07-09 标记)**:
- **#2 adapter 接口缺 `resume`**:组件 3 的接口只有 `spawn`,但组件 9 调 `adapter.resume`。接口要补 `resume`,与 sub-8 对齐。
- **#3 暴露工具集未定**:`exposable===true` 太宽(bash/file-write 会**权限升级**:我们的 bash 跑 app 进程身份,比外部 agent 在 workspace 的权限宽)。倾向收窄到**应用级数据**(Wiki 读 / Platform 读 / 项目数据)+ 受 scope 限的 workspace 文件读;**不**暴露 bash/file-write/file-edit。待拍。
- **#4 orphaned 外部进程**:崩溃/重启时被 spawn 的外部子进程(detached?)可能存活,继续写 workspace、无人看、token 已废。子进程 lifecycle(随 app exit kill?detached?)待定。

## 风险

- **codex per-spawn MCP 注入**(D8):若临时 config 方案有并发污染风险(多委派同时跑改同一个 `~/.codex/config.toml`),需 per-spawn 隔离目录(`CODEX_HOME` 环境变量?impl 核实)。退路:codex 首版**不接 MCP**,只做进程委派(MCP host 仅 claude 用),codex 后续补。
- **headless 权限**:[[feedback-headless-claude-permissions]] `--dangerously-skip-permissions` 必加;codex `approval_policy=never`。漏了 → 子进程卡在确认 prompt,父超时。
- **安全面**:外部 agent 在 workspace 任意读写(D6)。需 UI 上对"外部委派"有视觉区分(已是 `engine` 列 + 不同 target 标识)。
- **流式解析脆性**:claude/codex 的 stream-json 事件 schema 随版本变;adapter 解析需防御性(未知事件忽略,关键字段缺失降级为纯文本)。
- **MCP SDK 版本**:`@modelcontextprotocol/sdk@^1.29.0` 已在 deps 但零使用;impl 时确认其 Streamable HTTP server API(版本可能已演进)。

## sub 拆分预案(进 plan 阶段细化,这里仅草图)

> uniformity 原则主导:每个 sub 落地后,内外 subagent 在已建成的接口层无差别。

- sub-1:MCP host 骨架(express `/mcp` + SDK McpServer + 注册 exposable 工具,固定占位 scope)+ 单测。
- sub-2:scope token store(mint/verify/revoke)+ host 鉴权中间件 + 单测。
- sub-3:host 工具执行接线(复用 tool-execution-router 派发 + scope 过滤)+ 集成测(mock MCP client 调 read 类工具,断言 scope 生效)。
- sub-4:外部 agent 配置 store + router + 设置页 UI(二进制/启用/连通性测试/三态)+ 单测。D5 配置侧。
- sub-5:adapter 归一事件层(`ExternalAgentEvent`)+ **claude adapter**(spawn + stream-json 解析 → 归一事件)+ 单测(fixture)。
- sub-6:**codex adapter**(spawn + ndjson 解析 → 同一归一事件)+ 临时 config 注入核实 + 单测。
- sub-7:**delegator engine dispatch + TaskRegistry uniformity 胶水**:delegateTask(targetId) 解 engine;外部分支(mint token + adapter.spawn + 注册 TaskRegistry + 组件8事件映射 + delegated_tasks `engine`/`external_session_id` 列 + db-migration COLUMNS 同步)+ target picker(内部 ∪ 已启用外部,engine 不可见)。
- sub-8:**TaskResume 统一 dispatch + 外部重启恢复**:扩展 TaskResume 按 engine dispatch(external → `adapter.resume(externalSessionId)`);外部 interrupted task 经 external_session_id 恢复 + 单测。
- sub-9:E2E(ZERO_CORE_TEST_FIXTURE mock 外部二进制;配置→测试→委派(blocking+background)→TaskGet/List/Kill/Resume 全 uniform 表面;断言父 agent 视角无法区分 engine)。

## 下一步

进③ plan:用户定 **D5 + D6** 后,把上面 sub 草图细化成 `sub-N.md` + `acceptance-N.md` 一一对应,然后 `/effort next` 建 branch 逐 sub 实施。

## 参考

- CLI 事实(claude/codex headless + MCP):见 design 调研(claude `-p --mcp-config --dangerously-skip-permissions --output-format stream-json`;codex `exec --json -c approval_policy=never`)。
- 地基:[`../../archive/tool-decoupling/design.md`](../../archive/tool-decoupling/design.md)。
- 记忆:[[feedback-headless-claude-permissions]] [[feedback-fresh-db-migrations]] [[feedback-verify-runtime-wiring]]。
