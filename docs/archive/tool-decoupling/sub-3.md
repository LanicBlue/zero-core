# sub-3:app 级工具批迁(Wiki / Cron / OS 类)

> 决策 1/2/3 批量落地。app 级数据工具 + OS 类工具一次性迁新模型。依赖 sub-2(模式已验证)。

## 任务

一次性迁以下工具到新签名(execute(input, callerCtx) → JSON + format):

1. **Wiki 工具**(`src/tools/wiki/`):expand/search/create/update/delete/docRead/docWrite/docEdit —— 直读 wikiStore 单例;**scope 从 callerCtx 取**(限定 project 子树,G5)。
2. **Cron / 管理 list 类**:经 management 单例 + callerCtx。
3. **OS 类工具**(Read / Grep / Bash / Edit / Write / Glob):workingDir + emit 从 callerCtx 取;Bash 流式经 `callerCtx.emit`。返 `{text}` + 元数据(G6:`format = r.text`)。
4. **info/logs/config/providers**(若 sub-2 未含):同 Platform 模式。

## 范围

- **类别内一次性**(G3):这批工具一起迁,不留双签名。
- buildTool wrapper 继续支持新签名工具(sub-2 已铺)。
- callerCtx 注入 workingDir / emit / scope。

## 风险

- 数量多(10+ 工具)→ 工作量大,但模式统一(sub-2 验证过)。
- Wiki scope 改动:现 wiki-anchor 解析靠 session context;改 callerCtx.scope 后要保证 project 子树隔离不回归。
- Bash 流式 emit 从 ctx.emit 挪到 callerCtx.emit。

## 验收

见 `acceptance-3.md`。

---

## 完成记录(2026-07-08,sub-3 落地)

### 改了哪些文件

**Wiki**(`src/tools/wiki-tool.ts`):
- 直读 `getWikiStoreGlobal()` 单例(决策 1)—— 删 `resolveWikiStore(ctx)`。
- **scope 回退(G5)**:`resolveAnchorsCtx(callerCtx)` 首选 `callerCtx.scope`(`{projectId, readOnly?}` → `wiki-root:<projectId>` 子树,readOnly 拒写);scope 为空(内部 agent loop 还没填,sub-4/5 接)时**回退**到 `callerCtx.wikiAnchorNodeIds`(现有 wiki-anchor 注入,不回归)。
- execute → `ToolResult{data:{text, action, nodeId?}}`(G6 文本壳);format = `r.data.text`。文本逐字保留(sub-3 前 agent 视角)。

**Cron / 管理 list**(`cron-tool.ts` / `project-tool.ts` / `work-tool.ts`):
- 直读 `getManagementService()` 单例。
- execute → `ToolResult{data:{text, result}}`(result = store 原始返值,UI 直渲染);format = `r.data.text`(JSON.dump,同 sub-3 前)。
- Project 的 `via: { agentId }` 改读 `callerCtx.agentId`。

**OS 类**(`file-read.ts` / `grep.ts` / `bash.ts` / `file-edit.ts` / `file-write.ts` / `glob.ts`):
- workingDir / toolConfig / readScope 全从 `callerCtx` 取(不经 `ctx.*`)。
- **Bash 流式(G2)**:读 `callerCtx.emit`,结果就绪后推 `{type:"partial", text:<stdout>}`;`ctxToCallerCtx` 已桥接 `ctx.emit → callerCtx.emit`(loop 侧 `ctx.emit` 真接到 `callerCtx.emit`,链路已验证)。
- execute → `ToolResult{data:{text, ...元数据}}`(G6:Read=`{path,text,mode,offset,limit,totalLines,truncated}`,Bash=`{text,stdout,stderr,exitCode,elapsedSec}`,Grep=`{pattern,text,outputMode,searchPath,matchCount,truncated}`,Edit=`{path,text,replaced}`,Write=`{path,text,bytes,action}`,Glob=`{pattern,text,matches,totalMatched,truncated}`);format = `r.data.text`。
- Bash 失败(非 0 exit / timeout)从 `throw` 改为返 `ToolResult{ok:false}`(与 Platform 一致:错误也返 JSON,agent 看到错误文本作为工具结果;不再触发 PostToolUseFailure)。文本形态逐字保留。

**基建**(`src/tools/types.ts` / `src/tools/tool-factory.ts`):
- `CallerCtx` 加 5 个**过渡字段**(sub-4/5 收敛后删):`toolConfig` / `readScope` / `wikiAnchorNodeIds` / `contextBundle` / `projectId`。
- `ctxToCallerCtx` 从旧 `ToolExecutionContext` 桥这 5 个字段到 `callerCtx`(过渡;sub-4/5 把 scope/workingDir 改成 host 显式填后删)。

**测试**(`tests/unit/helpers/tool-decoupling-helpers.ts` 新增 + 4 个测试文件):
- `runTool(tool, input, ctx)` → `{json, text}`:execute 拿 JSON,format 拿文本。
- `p3-management-tools.test.ts` / `m1-cron.test.ts` / `p5-project-container.test.ts` / `work-tool.test.ts`:在 `beforeEach` 注册单例(`setManagementService` / `setWikiStoreGlobal`);调 `runTool` 同时断言 JSON 边 + 文本边。

### scope 回退策略(过渡期)

- **G5 目标**:host 在调用点解析 scope(`{projectId, readOnly?}`)注入 `callerCtx.scope`,Wiki 从 scope 取子树。
- **过渡(sub-3)**:AgentLoop 侧**还没**填 `callerCtx.scope`(那是 `sendProjectPrompt` 的事,sub-4/5 接)。Wiki 工具:`callerCtx.scope` 有 → 用(scope.readOnly 拒写);无 → 回退 `callerCtx.wikiAnchorNodeIds`(现有 wiki-anchor 解析,zero/global 含 GLOBAL_ROOT,project 含自己子树 + memory + free wikiAnchors)—— **保证现有行为不回归**。
- 5 个过渡字段(`toolConfig`/`readScope`/`wikiAnchorNodeIds`/`contextBundle`/`projectId`)在 `CallerCtx` 上标了 "sub-4/5 收敛后删"。

### 留给 sub-4 的注意点(per-session 访问器桥接)

1. **Flow 工具未迁**(本 sub 范围外,接近 session 作用域):它读 `ctx.flowActions` + `ctx.gitIntegration` + `ctx.requirementStore`(PM session 注入)+ `ctx.contextBundle` + `ctx.featureWorkspace`(可变 session 状态)。`gitIntegration` 来自 caps(session 配置),不是全局单例 —— 比 management 类更接近 session 作用域(TodoWrite/Task 那一类)。sub-4 迁 session 作用域工具时一并处理 Flow;过渡期靠 `ctxToCallerCtx` 桥的 `contextBundle` + `projectId` 让它继续跑(legacy 路径)。

2. **per-session 访问器(G1)**:TodoWrite / Task* / Orchestrate / Agent / Ask-user 仍走 legacy(`ctx.delegateTask` / `ctx.emit` / `ctx.sessionTodos` 等 session 状态)。sub-4 把这些迁到 `callerCtx.todos` / `callerCtx.taskRegistry` / `callerCtx.emit`(已铺好类型)。

3. **删过渡字段时机**:sub-4/5 把 `callerCtx.scope` 在 AgentLoop 侧接通后(`sendProjectPrompt` / `setSessionContext` 注入),Wiki 的 `wikiAnchorNodeIds` 回退分支 + `CallerCtx.wikiAnchorNodeIds` 字段可删;toolConfig/readScope 并入 scope 或 host 显式填后删对应字段 + `ctxToCallerCtx` 桥。

4. **删 legacy 双返值分支时机**:所有工具迁完(sub-4 session 作用域 + Flow),`buildTool` 的 `BuildToolOptionsLegacy` / `isMigrated` 分流 + `ctxToCallerCtx` 整个删。

5. **Bash 失败路径(已修)**:migrated 工具返 `{ok:false}` 后,buildTool wrapper **throw**(`new Error(raw.error ?? formattedText)`)→ 走既有 catch → AI SDK 发 `tool-error` → agent-loop stream handler 触发 **per-loop** PostToolUseFailure → turn-hooks(isError=true)+ tool-execution-hooks(success=false, errorMessage)+ recordToolUsage(false)三表失败标记全对。execute 仍返 ToolResult(JSON 契约保留),wrapper 把失败转 throw。注:`buildTool` 自调的 `triggerHooks` 指向已废弃 HookRegistry 单例(生产 no-op);真 hook 经 per-loop registry + stream 事件触发。**sub-5 dispatcher 注意**:UI 调工具走 `getToolExecute`(原始 execute,返 JSON)拿结构化结果,**不要**调 `toolDef.execute`(AI SDK wrapper,migrated 失败会 throw)。

