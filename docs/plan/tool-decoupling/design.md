# Design:tool-decoupling

> 状态:**Draft,待决策**。
> 对应 issue:[`./issue.md`](./issue.md)。

## 问题回顾(详见 ./issue.md)

工具经 per-loop `ctx` 拿依赖,把 **app 级服务** 与 **调用者身份** 混进一个袋子 → 同一逻辑两入口(agent 工具 / REST)+ per-loop 注入易漏(work/cron 漏 `platformObserver` 已发 bug)。目标:**工具 = 纯函数 `f(input) -> output`**,在哪调都一样;loop 只做权限闸 + 调用者身份作 input;UI 与 agent 共用同一工具。

## 关键事实(审计 —— 现状已接近目标)

- **`buildTool` wrapper 已经是 loop 侧关注点**([tool-factory.ts:155](../../../src/runtime/tools/tool-factory.ts#L155)):
  - PreToolUse hook(可 block = 权限闸,:173)
  - rate limiting(:186)
  - toolCallId stamping(:200)
  - PostToolUse / PostToolUseFailure hook(:202/:216)
  - tool_usage 日志(:213/:226)
  - result 截断(:214)
- **`__execute` 是原始纯函数** `(input, ctx) => Promise<string>`(:275),经 `getToolExecute(tool)`(:312)可直取 —— **UI 今天理论上就能调**,绕过 wrapper。
- **权限两层都在 loop 侧**:可见性(`buildToolsSet` / toolPolicy)+ per-call 闸(PreToolUse hook)。**已符合目标模型**。
- **唯一没对齐的**:execute 的 `ctx` 参数混了服务+身份;输出是 string(LLM 文本)非结构化。

### ctx 现状(`ToolExecutionContext`,[types.ts:697](../../../src/runtime/types.ts#L697))
混了两类:
- **app 级服务**(全 app 一份):db / wikiStore / wikiStoreGlobal / platformObserver / management / requirementStore / pmService / toolUsageStore / rateLimiter / getMcpTools …
- **调用者身份**(随调用变):sessionId / agentId / turnSeq / currentToolCallId / workingDir …

### 两入口(同逻辑两适配)
- agent:buildTool wrapper → `ctx.platformObserver.listParentSessions()`(文本)
- UI:REST router → `agentService.listParentSessions()`(JSON)

### 输出形态冲突
agent 要**文本**(`"● agent-general · running"`),UI 要**结构化 JSON**。强行合并入口会让 UI 收文本再解析(糟)。

## 方案

### 决策 0:工具归属 —— 中立纯函数层(已定 2026-07-08)

工具既不绑 runtime、也不是 server 的一部分、更不是 MCP server 本身。它是**共享的纯函数层 `src/tools/`**,被多 host 调:

```
src/tools/                  ← 中立纯函数层(Wiki / Platform / Read / Cron …)
   ▲            ▲            ▐
   │ import     │ import     ▐ import
src/runtime/          src/server/
AgentLoop             ├─ REST router     (host: UI)
(buildTool wrapper:   └─ MCP server      (host: 外部 agent,见 external-subagent-mcp)
 权限/rate/日志)          (scope 沙箱)
```

- **MCP 不是工具的家,是外部 host**(内部调用留直接函数调用,避开 RPC 开销 + 有状态工具跨进程问题)。
- 边界挪到正确位置:runtime 只剩 loop 机制(可单测);tools 中立、数据工具 import server stores(诚实);server 加 MCP host。
- **无循环**:tools → server-stores(单向);runtime → tools;server-hosts → tools。
- 迁移内容:`src/runtime/tools/` + `src/runtime/mcp-tools/` → `src/tools/`;数据工具改 import server store getter 单例。

### 决策 1:app 级服务怎么暴露 —— 工具直读数据源模块(已定,2026-07-08)

工具 execute 体内**直接 import 它需要的数据源模块**,不搞中央聚合类。每个数据源模块(server store / agentService)自带 **getter/setter 单例**;启动时 `setXxx(instance)`,工具 `import { getXxx }` 直读。

```ts
// src/server/agent-service.ts
let _inst: AgentService;
export const getAgentService = () => _inst;
export const setAgentService = (s) => { _inst = s; };

// src/tools/platform/sessions.ts
import { getAgentService } from "../../server/agent-service.js";
execute(input, callerCtx) {
  return getAgentService().listParentSessions();   // 工具自己去拿
}
```

- 每个工具的依赖**显式写在文件顶部 import**,读代码即知这工具靠什么。
- **否定聚合 `appServices` 类**:没必要再搞个数据汇聚类(god object 风险);工具直接认它的数据源。
- **否定 ctx 拆 services+caller**:仍是注入,per-loop 拼装仍在,注入遗漏坑不根治。
- server store 句柄仍可测试替换(`setXxx(mock)`),可测性不丢。
- 含义:**放开 runtime→server import 给数据工具**(它们本就 headless 无意义);OS 工具(Read/Grep/Bash)继续不碰 server。

### 决策 2:调用者身份怎么传(已定 B,2026-07-08)

身份(sessionId / scope)由 **host 在调用点按调用位置自动填入** execute 第二参 `callerCtx`,**LLM 看不见、填不了**(安全靠结构,不靠约定)。

```ts
interface CallerCtx {
  sessionId?: string;      // 内部 agent(loop 注入)
  agentId?: string;
  scope?: { projectId: string; readOnly?: boolean; allowedTools?: string[] };  // 外部(MCP server 按 token 注入)
  caller: "internal" | "ui" | "external:mcp";
  toolCallId?: string;
  turnSeq?: number;
}
execute(input, callerCtx: CallerCtx): Promise<Result>
```

- loop 调:填 `{sessionId, agentId, caller:"internal", toolCallId, turnSeq}`。
- MCP server 调:按 scope token 填 `{scope, caller:"external:mcp"}`。
- REST/UI 调:`{caller:"ui", scope?}`。
- LLM-visible schema **只**描述 input(做什么);身份(我是谁/能看哪)在结构上与 input 分离。

**否定 A(input 字段)**:sessionId/scope 若在 input schema 里,LLM 能填能伪造;靠 `internal:true` 标记剥离是脆弱约定,不安全。

### 决策 3:输出形态 —— 工具返 JSON,host 决定是否 format(已定,2026-07-08)

工具 `execute` 永远返**结构化 JSON**;每个工具自带一个纯函数 `format(result): string`(文本形态)。

- **UI/REST** → execute → JSON 直渲染(不调 format)。
- **agent loop** → execute → `format(JSON)` → 文本喂 LLM。
- **MCP server** → execute → `format(JSON)` → 文本(或 JSON 给外部 client 自决)。

```ts
execute(input, callerCtx): Promise<ResultJSON>
format(result: ResultJSON): string   // 自带,纯函数,可单测
```

- formatter 工具特定,定义在工具旁;由**需要文本的 host**(agent / MCP)调用,UI host 不调。
- **旧返 string 的工具**:host 把 string 当"已格式化文本"(agent 路径可用,UI 暂仍走 REST 取结构化)—— 增量迁,迁完的工具有 JSON + format 双形态。
- Platform 作首个范例。

**否定 B(双轨不动)**:两套输出逻辑(工具文本 + REST 结构化)需手动同步,漂移风险,没真统一。

### 决策 4:UI 怎么调工具 —— 统一 dispatcher,现在做(已定 A,2026-07-08)

UI 经 IPC → **统一 dispatcher** → `getToolExecute(tool)(input, callerCtx)` → JSON(UI 直渲染)。

```
UI → ipc.invoke("tool:run", {tool:"Wiki", input})
   → dispatcher: getToolExecute(wikiTool)(input, {caller:"ui", scope?})
   → JSON 返 UI
```

- **全工具暴露给 UI,无可见性策略**:UI 是用户可信端(调 Bash 写 = 用户在自家 app 跑命令,同 IDE 终端)。现有 Tool 页测试功能本就调所有工具 —— dispatcher 把该能力通用化给所有 UI 消费者。
- **可见性是外部 agent(MCP)那侧的事**(scope 沙箱,见 external-subagent-mcp),与 UI 无关。
- REST:**UI 侧退场**(dispatcher 取代);若外部 REST 消费者存在则留薄代理,否则删。
- agent / MCP / UI 三 host 全部经各自 wrapper 调同一 execute。

**否定 B(REST 共 service 过渡)**:REST 仍是第二入口,新工具要 UI 能用就得手写 REST handler —— 没真统一。既然 UI 本就可信、Tool 页已暴露全工具,A 现在做,不过渡。

## 推荐

| 决策 | 选 | 理由 |
|---|---|---|
| 0 工具归属 | 中立纯函数层 `src/tools/` | 多 host(runtime/server-MCP/server-REST)共调;MCP 是 host 不是家 |
| 1 服务暴露 | 工具直读数据源模块(getter/setter 单例) | 工具真纯函数,根治注入舞;依赖显式在 import;无 god object |
| 2 调用者身份 | execute 第二参 callerCtx(host 注入) | sessionId/scope 不能让 LLM 填(结构隔离,非约定) |
| 3 输出形态 | 工具返 JSON + 自带 format,host 决定是否格式化 | UI=agent=MCP 真同源;旧工具增量迁 |
| 4 UI 调用 | 统一 dispatcher(现在做,全工具暴露) | UI 可信端无需可见性策略;Tool 页已暴露全工具;REST UI 侧退场 |

## 迁移顺序(分类一次性 —— G3,不留长期双签名共存)

每类工具一次性迁完即删旧模型;类别间可分步交付,但**类别内不改双签名并存**(避免 buildTool 同时认两种签名的混乱)。

1. **基建 + 工具搬层**:各 server store/agentService 加 getter/setter 单例,启动注册;`src/runtime/tools/` + `src/runtime/mcp-tools/` → `src/tools/`(中立层);工具加 `exposable` 标记 + callerCtx 类型(含 scope)+ format 约定。无行为变化(搬运 + 标记 + 类型)。
2. **Platform 工具迁**(首例):直读 agentService 单例,**删 platformObserver ctx 字段** → 修当前 work/cron bug;返 JSON + format(决策 3 范例)。
3. **app 级工具迁**(Wiki 读 / Cron 列表 / info/logs/config/providers):ctx 服务 → 直读单例;增量加 JSON+format。
4. **session 作用域工具迁**(TodoWrite / Task / Wait):身份 → callerCtx(决策 2),服务 → 单例。
5. **UI 统一 dispatcher**:IPC `tool:run` → `getToolExecute(tool)(input, {caller:"ui", scope?})` → JSON;UI 侧 REST 退场(外部 REST 消费者若存在留薄代理)。

## 决策记录(全部已定,可进 plan)

1. ~~单例形态~~ ✅ 工具直读数据源模块 + 各模块 getter/setter 单例(否定聚合 appServices)。
2. ~~callerCtx 传法~~ ✅ execute 第二参 `callerCtx`(host 注入,LLM 不可见)。
3. ~~sessionId 安全~~ ✅ session 作用域工具只从 callerCtx 取 sessionId,**绝不**从 LLM input 取(acceptance 守这条;结构保证)。
4. ~~输出结构化范围~~ ✅ 增量:Platform 首例(返 JSON + format),其余工具按需迁;旧 string 返值兼容。
5. ~~REST 去留~~ ✅ UI 侧 dispatcher 取代 REST;外部 REST 消费者存在则留薄代理,否则删。
6. ~~headless/CLI~~ ✅ CLI 路径同样起 stores + 注册 getter 单例(server/index.ts 与 cli.ts 共用启动注册逻辑);数据工具在 headless 无 store 时 getter 返 undefined → 工具优雅报错(不崩)。

## 复审补遗(2026-07-08 —— G1-G6 漏洞补)

复审发现 app 级工具决策干净,但 session 作用域工具 + 流式有真空,补如下:

### G1 — per-session 状态(已定):走 callerCtx 访问器,不走全局单例
- 决策 1"直读单例"只对 **app 级数据**(wikiStore / agentService / providers DB)成立。
- **per-session 状态**(todos / TaskRegistry / input-queue)不是全局单例,其主人是 **loop**。loop 调 tool 时把**本 loop 的状态访问器**放进 `callerCtx`(如 `callerCtx.todos` / `callerCtx.taskRegistry`);tool 经访问器读/写 —— 数据"过 tool 一圈"回 loop。
- 安全:tool 只能碰 callerCtx 给的访问器(= 本 loop),**碰不到别的 loop 的状态**。
- **UI 也可调 session 工具**(Tool 页测试):callerCtx 无真实 loop 状态时,工具**返默认/示例值**(供测试预览);真实运行(loop 调)才用真状态。

### G2 — 流式 / 长任务 progress(已定):callerCtx.emit 可选回调 + 终态 JSON
- `callerCtx.emit?(event: ToolStreamEvent)` —— 可选副作用通道,**不影响"返 JSON"模型**。
- 流式工具(Bash / Subagent / Wait)执行中 `emit({type:"partial", text})` 边跑边吐;**最终返 JSON**(完整结果)。非流式工具(Wiki/Platform/Read)无视 emit。
- 三 host 各自接 emit:loop → runtime 事件流 → UI 实时(同今天 ctx.emit);MCP server → MCP progress notification;UI dispatcher → IPC streaming。
- emit 可选:测试/合成调用不提供 → 工具不流式,只返 JSON。

```ts
interface ToolStreamEvent { type: "progress" | "partial" | "step"; text?: string; data?: unknown }
```

### G3 — 迁移方式(已定):一次性,不留双签名共存
- 不逐工具增量长期共存。**分类一次性迁**(app 级一批、session 作用域一批),迁完即删旧 ctx 模型 —— 避免过渡期 buildTool 同时认两签名的混乱。

### G5 — 权限/scope/workingDir(已定):host 解析后注入,工具不自查
- 工具**不自己查权限**。host(loop / MCP server)按调用位置解析出 `scope`(权限/读写限制)+ `workingDir`,**注入 callerCtx**;工具只用,不查。
- callerCtx 补 `workingDir` 字段(loop 从 session cwd 注入;MCP 从 scope.projectId 推导)。
- **Wiki 也走 scope**:host 解析 scope 给 Wiki(限定 project 子树);MCP 外部 agent 只能看 scope 内的 wiki。

### G6 — 文本工具(已定):`{text}` 壳,不豁免
- Read / Bash / Grep 这类天生文本工具:JSON = `{text:"..."}`(+ 少量元数据如 `{path, text}` / `{stdout, stderr, exitCode}`);`format(r) = r.text`。简单壳,无需豁免,统一走 JSON+format。

### G4 — 外部 agent 配置(归 external-subagent-mcp)
- Claude / Codex 在 **agent 的 subagent 列表**里配(同内部 subagent),加 claude/codex 条目。getMcpTools 等 per-agent 配置经 agentStore + callerCtx.agentId 解。详见 external-subagent-mcp effort。

## callerCtx 最终形态(综合 G1/G5)

```ts
interface CallerCtx {
  // 身份(host 注入,LLM 不可见)
  sessionId?: string;       // 内部 agent
  agentId?: string;
  caller: "internal" | "ui" | "external:mcp";
  toolCallId?: string;
  turnSeq?: number;
  // host 解析后注入(工具不自查)
  workingDir?: string;      // loop: session cwd;MCP: scope 推导
  scope?: { projectId: string; readOnly?: boolean; allowedTools?: string[] };  // MCP token 解析
  // per-session 状态访问器(loop 注入;MCP/UI 无 → session 工具不暴露)
  todos?: TodoAccessor;
  taskRegistry?: TaskRegistryAccessor;
  emit?: (e: ToolStreamEvent) => void;   // 流式(G2 已定:可选,工具边跑边吐)
}
```

## 下一步

决策 + G1-G6 补遗全定 → `/effort plan` 拆 sub。**迁移按 G3 分类一次性**(app 级工具一批、session 作用域一批、UI dispatcher),不留长期双签名共存。**前置**:external-subagent-mcp 的 MCP server host 依赖本 effort 落地。
