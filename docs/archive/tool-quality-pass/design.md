# Design:tool-quality-pass

> 状态:**Decisions locked,待确认进 plan**。
> 对应 issue:[`./issue.md`](./issue.md)(同目录,随文件夹流转)。
> 本文 2026-07-15 修订:#1 模型纠正(完成 task 完成即归档删行,非重启 re-seed)+ #9 改虚拟前缀。

## 问题回顾(详见 ./issue.md)

10 条工具质量问题,跨 Grep / Wiki / Wait / Task。所有决策点已与用户拍板(见文末「决策已定」)。

## 关键事实(审计)

- **#1 完成链路**:后台 task 完成 → [registry.complete()](../../../src/runtime/subagent-delegator.ts#L487) 标内存 registry=completed(**不删**)→ [fireOnTaskTerminal](../../../src/runtime/subagent-delegator.ts#L260) → [archiveDelegatedSession](../../../src/server/agent-service.ts#L979) → deleteSessionData → **意在删 delegated_tasks DB 行**。但归档是 **async detached + 会 skip/fail**([agent-service.ts:992](../../../src/server/agent-service.ts#L992) "could not build child config — skipping archive")→ completed 行在不少场景**持续存在**(不是"完成即归档删")。
- **#1 根因(用户观察定位)**:`Task get`→acknowledge 链**通的**(单测覆盖 + 实跑 3 个 acknowledge 测试绿,get 后 task 确实从 UI 消失)。但 acknowledge **只清内存 registry,不删 DB 行** → 行持续存在 → 新 turn loop 重建([createLoopForSession→restoreDelegatedTasks](../../../src/server/agent-service.ts#L1424),eviction/fresh-rebuild 触发)re-seed 这行 → **task 复活**。= "get后消失，新turn后又出现"。详见 #1 方案。
- **#9 外部化现状**:[relPathForPointer](../../../src/runtime/tool-result-externalizer.ts#L113) 用相对 ZERO_CORE_DIR 的 `.zero-core/tool-outputs/<hash>.txt`,agent 误读为 workspace 相对。Read 工具**已会解析 `[skills]/`**([file-read.ts:45/117](../../../src/tools/file-read.ts#L45) import resolveSkillPath),加 `[tool-outputs]/` 是同类小扩展。
- **#8 wake 链路**:[tryWake()](../../../src/runtime/task-registry.ts#L300) 触发 `"task finished"` 不带 id;complete/fail/kill/acknowledge 四处都调它。要带 id 得在这四处捕获。
- **#3 现状**:[wiki-tool.ts:518](../../../src/tools/wiki-tool.ts#L518) `childMarker = childCount>0 ? ▾${childCount} : " leaf"`,childCount 是直接子。每个**渲染**非叶节点都带 ▾N。
- **Wiki 寻址已有 title-path 走法**:[resolveNode](../../../src/tools/wiki-tool.ts#L279)(doc op 用),#4 直接复用。
- **Grep 双路径**:rg 可用走 rg;不可用(Windows)走 [nativeGrepSearch](../../../src/tools/grep.ts#L103)。#5/#6 都是 native fallback 缺陷。

---

## 方案(按 issue 编号,决策已定)

### #1 TaskTree 完成任务残留 — acknowledge 必须清 DB 行(根因已定位)

**症状(用户观察)**:`Task get` 后 task 从 UI 消失;新消息进入新 turn 后**又出现**。

**根因(已定位,非 ping/refresh bug)**:
- `Task get` → `acknowledgeTask` → [taskRegistry.acknowledge](../../../src/runtime/task-registry.ts#L178) 只 `tasks.delete()` 清**内存 registry**,**不碰 `delegated_tasks` DB 行**。
- 完成的 task 的 DB 行本应由自动归档删([fireOnTaskTerminal](../../../src/runtime/subagent-delegator.ts#L260)→[archiveDelegatedSession](../../../src/server/agent-service.ts#L979)→deleteSessionData),但归档是 **async detached + 会 skip/fail**([agent-service.ts:992](../../../src/server/agent-service.ts#L992) "could not build child config — skipping archive")。故 completed 行在不少场景**持续存在**。
- 新 turn → loop 重建([evictSessionFromMemory](../../../src/server/agent-service.ts#L875) / [agent 配置改 fresh rebuild L309](../../../src/server/agent-service.ts#L309) / loop 缺失)→ [createLoopForSession→restoreDelegatedTasks L1424](../../../src/server/agent-service.ts#L1424) **re-seed 这行**回 registry → task 复活。
- 链路:acknowledge 只清内存 → DB 行留存 → 重建 re-seed → "get 了又冒回"。

**方案:acknowledge 同步删 DB 行(已定)**
- `session-db` 加 `deleteDelegatedTask(id)`(`DELETE FROM delegated_tasks WHERE id=?`,**无 schema 变更、无 migration**)。
- [delegator.acknowledgeTask](../../../src/runtime/subagent-delegator.ts#L612)(Task get 走)`registry.acknowledge` 后调 `this.config.db?.deleteDelegatedTask(id)`。
- [abandonTask](../../../src/runtime/subagent-delegator.ts#L560)(TaskKill interrupted→abandon 走)同样删行(它现在只 update killed + registry.acknowledge,行仍留 → 同 bug)。
- 效果:acknowledge 后 DB 行即清 → restoreDelegatedTasks 无行可 re-seed → 不再复活。归档若之后才跑,deleteSessionData 的 `DELETE WHERE session_id` 是 no-op,安全。
- **不影响 sub-8 interrupted re-seed**:interrupted 行从不 acknowledge(resume 前不消费),不会被删。
- 替代方案"加 acknowledged 列(B)"已否决:行是瞬态跟踪索引(归档本就会删),硬删(A)更简单且无 migration;B 的列在行被归档删后也短命,overkill。

### #2 search 正则 — 显式 `regex` flag(已定)

默认 substring(现状不回归);`regex:true` 时 `query` 按正则。type 过滤已有([wiki-tool.ts:568/574](../../../src/tools/wiki-tool.ts#L568))。Wiki search 历史是子串,不能静默变正则破行为 → 显式 flag 可控。

### #3 expand 计数 — ▾直接(总子孙)(已定 B)

[wiki-tool.ts:518](../../../src/tools/wiki-tool.ts#L518) childMarker 改 `▾${direct}(${total})`,direct=直接子数,total=整棵子孙数(小 BFS)。叶节点仍 `leaf`。子树大时 BFS 开销:加 per-render cache 或限制(acceptance 定边界)。

### #4 expand 跳层 — 加 `path` 参数,末段 `*` glob,path 优先(已定 A)

expand 加 `path`(title 层级,相对 scope 根,与 doc op 一致),复用 [resolveNode](../../../src/tools/wiki-tool.ts#L279) 走到目标节点再对该节点 depth expand。末段 `*` = 走到倒数第二段,展其全部直接子节点(depth=1)。path 与 nodeId 同传 → **path 优先,nodeId 忽略**(向后兼容纯 nodeId 调用)。

### #5 Grep 单文件静默空(native fallback)— stat 判文件(无争议)

execute 里 `stat(searchPath)`:文件 → 单文件分支(直接 readFile+匹配,不 walkFiles);目录 → 现状。rg 路径不动(本就支持单文件)。抽出"匹配单文件内容"为可复用函数,文件/目录两入口共用。relPath:文件时 = basename。

### #6 Grep 截断无提示(native fallback)— 计真实总数 + 提示(无争议)

native fallback 不在 `totalMatches >= head_limit` 处 break(继续扫计真实总数,不 push 新行),末尾 `totalMatches > head_limit` 追加 `... (${totalMatches-head_limit} more matches truncated, refine your pattern)`。对齐 rg 路径([grep.ts:359](../../../src/tools/grep.ts#L359))风格。

### #7 Wait timeout schema — until 改 .optional()(无争议)

[wait.ts:68](../../../src/tools/wait.ts#L68) `until: z.string()` → `.optional()`。execute 已支持 timeout-only。一行。

### #8 Wait wake 带 finishedTaskIds — registry 累积回传,进 text(已定 A + text)

- [TaskRegistry](../../../src/runtime/task-registry.ts#L25) 加 `finishedDuringWait: string[]`;complete/fail/kill/acknowledge 四处若 `waitResolver` 活跃则 push taskId。
- suspendUntilWake 返回时 reason="task finished" 带上快照并清空;`WaitWakeResult` 加 `finishedTaskIds?: string[]`。
- [wait.ts:127](../../../src/tools/wait.ts#L127) text:`woke: task finished elapsed Ns finishedTaskIds: [a,b]`(空则原样)。结构化 data 也带。

### #9 外部化指针 — 虚拟前缀 `[tool-outputs]/` + Read 解析(已定,照搬 skill)

- 新前缀 `[tool-outputs]/`(常量,镜像 `SKILL_VIRTUAL_PREFIX`)。
- [relPathForPointer](../../../src/runtime/tool-result-externalizer.ts#L113) 改输出 `[tool-outputs]/<hash>.txt`。
- [file-read.ts](../../../src/tools/file-read.ts#L117) 在现有 `[skills]/` 解析旁加 `[tool-outputs]/` 通道:前缀 → `join(ZERO_CORE_DIR, "tool-outputs", rest)`,沙箱限该目录。
- [resolvePointerRelPath](../../../src/runtime/tool-result-externalizer.ts#L135) 识别新前缀(向后兼容旧 `.zero-core/tool-outputs/` 相对形态)。
- 可选新 helper 模块 `src/tools/tool-output-paths.ts`(镜像 skill-paths.ts)或内联进 file-read + externalizer(acceptance 定)。

### #10 Task list 汇总 — 末尾默认追加聚合行(已定 A)

[list action](../../../src/tools/task-tool.ts#L289) 末尾加 `Summary: N tasks | tokens X | elapsed Ys (running Z, max Ws)`,不加参数。tokens=所有 task tokens 和;elapsed=各 task elapsed 和;max=最长单 task。

---

## 决策已定(进 plan 前全部 locked)

| # | 决策 |
|---|------|
| 1 | acknowledge 同步删 `delegated_tasks` DB 行(Task get + abandon 两路);加 `deleteDelegatedTask(id)`,无 migration |
| 2 | 显式 `regex` flag(默认 substring 不回归) |
| 3 | `▾直接(总子孙)` |
| 4 | expand 加 `path` + 末段 `*` glob;path 优先于 nodeId |
| 5 | stat 判文件,单文件分支 |
| 6 | native fallback 计真实总数 + 截断提示 |
| 7 | `until` 改 `.optional()` |
| 8 | registry 累积 id 回传;finishedTaskIds 进 text + data |
| 9 | 虚拟前缀 `[tool-outputs]/` + Read 解析(照搬 skill) |
| 10 | list 末尾默认追加聚合行 |

## 拆 plan 预案(5 sub,实现↔验证分 agent)

- **sub-1 Grep**:#5 单文件 + #6 截断提示(同 grep.ts,两独立验收)
- **sub-2 Wait**:#7 until optional + #8 finishedTaskIds(wait.ts + task-registry.ts + types)
- **sub-3 Wiki**:#2 regex flag + #3 计数 + #4 path 跳层(同 wiki-tool.ts)
- **sub-4 Task**:#1 acknowledge 删 DB 行(task-tool / delegator / session-db)+ #10 list 汇总
- **sub-5 外部化路径**:#9 `[tool-outputs]/` 虚拟前缀(externalizer + file-read + 新 helper)

## 下一步

用户确认进 plan → `/effort plan` 写 sub-1..5.md + acceptance-1..5.md(配对),跑 link checker。**实施才建 branch,文档留 master。**
