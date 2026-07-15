# Issue:tool-quality-pass

- **状态**:① issues(问题记录)
- **提出**:2026-07-15
- **类型**:bug + 改进(一批工具质量问题,跨 Grep / Wiki / Wait / Task 四个工具)

## 问题

一批 agent 工具在实际多 agent 实验中暴露的质量问题:静默错误(Grep 单文件、Wait timeout)、信息缺失(Wait 不带 task_id、Grep 截断无提示、Task list 无汇总)、路径误导(Task get 外部化指针)、UI 与 agent 视图不一致(TaskTree 残留已完成任务)、以及若干可用性增强(Wiki search 正则、Wiki expand 子节点计数与跳层)。共 10 条,需统一一轮加固。

## 现状 / 真相源 / 影响面

### Task 工具(src/tools/task-tool.ts)

1. **TaskTree 完成任务残留(#1)** — 用户确认是 **UI 任务面板**。症状:**`Task get` 后消失,新消息进新 turn 后又出现**。
   - 完成链路:后台 task 完成 → [registry.complete()](../../../src/runtime/subagent-delegator.ts#L487) 标内存 registry=completed(不删)→ [fireOnTaskTerminal](../../../src/runtime/subagent-delegator.ts#L260) → [archiveDelegatedSession](../../../src/server/agent-service.ts#L979) → deleteSessionData 意在删 DB 行,但归档 **async detached + 会 skip**([agent-service.ts:992](../../../src/server/agent-service.ts#L992))→ completed **DB 行持续存在**(非"完成即删")。
   - 根因:`Task get`→acknowledge→[registry.delete](../../../src/runtime/task-registry.ts#L178) **只清内存,不删 DB 行**(链路本身通,3 个 acknowledge 单测绿,get 后确从 UI 消失)。行持续存在 → 新 turn loop 重建([createLoopForSession→restoreDelegatedTasks L1424](../../../src/server/agent-service.ts#L1424))re-seed 这行 → task 复活。= "get后消失，新turn后又出现"。
   - UI 读内存 registry:[TaskTreePanel](../../../src/renderer/components/layout/TaskTreePanel.tsx#L49) ← task-store ← `getRuntimeTaskTree`([agent-loop.ts:1235](../../../src/runtime/agent-loop.ts#L1235)) = `taskRegistry.list()` + 递归 running 子 loop。
   - 修法(design 已定):acknowledge 同步删 DB 行(Task get + abandon 两路);session-db 加 `deleteDelegatedTask(id)`,无 schema 变更。详见 design #1。

9. **Task get 外部化路径误导(#9)** — 大结果外部化指针显 `.zero-core/tool-outputs/<hash>.txt`([tool-result-externalizer.ts:113-117](../../../src/runtime/tool-result-externalizer.ts#L113) `relPathForPointer`,相对 `ZERO_CORE_DIR`≈homedir)。文件实在 `C:/Users/Administrator/.zero-core/tool-outputs/...`(dataDir),不在 workspace。agent 误当 workspace 相对路径,得另调 Platform info 拿 dataDir 再拼。

10. **Task list 无汇总(#10)** — [list action](../../../src/tools/task-tool.ts#L242)只输出 per-task 行 + `Total: X tasks, Y running`([L289](../../../src/tools/task-tool.ts#L289)),无 token/耗时聚合。多 agent 效率对比要手抄手算。

### Wait 工具(src/tools/wait.ts)

7. **timeout 形同虚设(#7)** — schema `until: z.string()`**必填**([wait.ts:68](../../../src/tools/wait.ts#L68) 无 `.optional()`),与 prompt "Parameters (provide one): until or timeout" 矛盾。`{timeout:30}` 缺 `until` 被 zod 直接拒。execute 逻辑([L77-86](../../../src/tools/wait.ts#L77))本就支持 timeout-only。一行 schema bug。

8. **wake 不带 task_id(#8)** — execute 只返 `woke: ${reason} elapsed ${elapsedSec}s`([wait.ts:127](../../../src/tools/wait.ts#L127))。`tryWake()`([task-registry.ts:300](../../../src/runtime/task-registry.ts#L300))触发 `"task finished"` 不带 id。多 task 并发时醒来不知是谁完成,得再调 Task list 轮询。

### Grep 工具(src/tools/grep.ts)

5. **单文件静默返回空(#5)** — Windows 无 rg → 走 native fallback,[walkFiles(searchPath)](../../../src/tools/grep.ts#L88) 对**文件**路径 `readdir` 抛错被 catch 吞 → 空生成器 → "No matches found."。rg 路径单文件正常,纯 fallback 缺陷(用户在 Windows)。

6. **截断无提示(#6)** — rg 路径有 `... (truncated, N total matches)`([grep.ts:359](../../../src/tools/grep.ts#L359));**native fallback 无**([L181](../../../src/tools/grep.ts#L181) 直接 slice),且 [L132](../../../src/tools/grep.ts#L132) `totalMatches >= head_limit` 提前 break 不知真实总数。Windows 截断静默。

### Wiki 工具(src/tools/wiki-tool.ts)

2. **search 缺正则(#2)** — **`type` 过滤已存在且生效**([wiki-tool.ts:568/574](../../../src/tools/wiki-tool.ts#L568)),用户可能未注意;真正缺的是**正则**(当前 `query` 是 `.toLowerCase().includes(q)` 子串匹配,[L557/L575-580](../../../src/tools/wiki-tool.ts#L557))。

3. **expand 子节点计数(#3)** — ▾N 已对每个"有子"的**渲染**节点显示直接子节点数([wiki-tool.ts:518](../../../src/tools/wiki-tool.ts#L518));诉求是 hidden-by-depth 时也显示计数 / 显示总子孙数 / 根节点 header 带计数。需 design 定计数口径。

4. **expand 不能跳层(#4)** — 只能按 `nodeId` + `depth` 逐层 expand。要到 `server/internal/realtime/hub.go` 得 expand 三次。可加 `path` 参数复用 [resolveNode](../../../src/tools/wiki-tool.ts#L279)(doc op 已有的 title 层级路径走法)直达目标节点。

## 下一步

进② design 细化方案(`/effort design`)。#1/#3/#4/#8/#9 各有决策点,需在 design 钉死后才能拆 plan。
