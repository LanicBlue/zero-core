# 产品流程说明

## 核心流程

1. **启动流程**
   - Electron 主进程启动（`src/main/index.ts`）
   - 初始化数据库、运行迁移（`db-migration.ts`）
   - 注册 Hook 系统 + 持久化 Hook + 工具执行记录 Hook + 运行时 feature hooks（**7 个**：turn / notification / rag / provider-options / compression / todo-cleanup / extraction；v0.7 的 `memory-hooks` 已在 v0.8 P2 §11.6 删除）
   - 创建 ToolRegistry、MCPManager
   - 启动时清理孤儿 **project_wiki 子树**（`server/index.ts:360-364`，v0.8 §8.6 bugfix —— 原 `agentToolStore.cleanupOrphans()` 随 v0.8 §11.5 Agent-as-Tool 退役一并下线）
   - 扫描中断的 turn 并恢复（`recovery.ts`）
   - 创建主窗口，加载渲染进程

2. **Agent 执行流程**
   - 用户发送消息 → IPC `chat:send` → `agent-service.ts`
   - 构建 SessionConfig（含 toolPolicy.tools map 传递到运行时）
   - AgentLoop 启动，组装 system prompt（base + tool_policy）
   - PreLLMCall hooks 注入动态上下文（memory recall、RAG、环境信息）
   - `streamText()` 调用 AI SDK，处理流式事件
   - PostTurnComplete hooks 执行后处理（compression、extraction —— 内容记忆 / 工具遥测双提取者，v0.8 M5）
   - 工具调用：`tool-call` 事件 → PreToolUse hook → ToolRateLimiter.acquire() → execute → release → PostToolUse hook
   - 并行工具调用通过 `toolCallId` 匹配结果，避免混淆
   - 结果通过 IPC 流式返回渲染进程

3. **工具限速流程**
   - 配置来源：`ctx.toolConfig[toolName].minInterval / maxConcurrent`
   - `tool-factory.ts` 的 execute 包装：hook → acquire → execute → release → hook
   - minInterval=0 && maxConcurrent=0 时零开销跳过

4. **中断恢复流程**
   - CheckpointManager 在每个 tool-result 后保存增量检查点
   - 中断后重启时 `recovery.ts` 扫描 `turn_state` 表
   - `AgentLoop.resume()` 加载已完成的 turn，继续执行

5. **Agent 删除流程**
   - 删除 Agent → `agent-router.ts` 直接删 `agents` 表行（v0.8 §11.5：原 `afterDelete` 回调级联删 `agent-tool` 条目的机制已随 `AgentToolStore` 退役 —— `agent-router.ts:70` 注释明示「no AgentToolStore rows to cascade」）
   - 启动时清理的孤儿数据从 v0.7 的 `agent-tool` 记录改为 v0.8 的 `project_wiki` 子树（见上文启动流程）

## 用户路径

- **创建 Agent**：Agents 页面 → 选模板或从空白创建 → 配置模型/工具/prompt → 保存
- **运行 Agent**：选择 Agent → 发送消息 → 查看流式结果和工具调用
- **管理工具**：Tools 页面 → 启用/禁用工具 → 配置参数（限速等）→ 测试
- **查看统计**：Tools 页面 → 统计 Tab → 调用概况 + AI 错误分析
- **监控会话**：Dashboard → 实时会话指标

## 事件流

```
session_init → text_delta → [thinking_delta] → [tool_start {toolCallId}] → [tool_end {toolCallId}] → ... → agent_end
```

Hook 生命周期：
```
SessionStart → [PreLLMCall → PreToolUse → PostToolUse/PostToolUseFailure]* → PostTurnComplete → Stop → SessionEnd
```

## 状态变化

zero-core 三个核心实体（session、tool-execution、requirement）各有独立状态机，由对应模块强制流转，非法转换会被拒绝并记录错误。

### Session 生命周期状态机

定义在 `src/server/session-lifecycle.ts`，由 `SessionManager` 强制流转，`VALID_TRANSITIONS` 是白名单：

```
created → idle → queued → streaming ⇄ executing_tools → idle
              ↓        ↓           ↓
           disposed   error      disposed
```

| 状态 | 含义 | 合法后继 |
|------|------|---------|
| `created` | 会话刚建，尚未初始化完成 | `idle`、`disposed` |
| `idle` | 空闲，可接受新 prompt | `queued`、`streaming`、`disposed` |
| `queued` | 已排队，等待限速器/调度 | `streaming`、`error`、`disposed` |
| `streaming` | 正在调用 LLM 流式输出 | `executing_tools`、`idle`、`error`、`disposed` |
| `executing_tools` | 本轮工具调用执行中 | `streaming`（回到 LLM）、`idle`、`error`、`disposed` |
| `error` | 出错，需恢复或重置 | `idle`、`disposed` |
| `disposed` | 已销毁，终态 | （无） |

`AgentLoop.busy` 标志在 `run()` / `resume()` 时置 true，结束（正常 / abort / error）时置 false，与 `streaming`+`executing_tools` 对应。

### Turn 状态机（单轮执行 + 检查点恢复）

持久化在 `turn_state` 表（`phase` 字段），由 `CheckpointManager` 在每个 tool-result 后写增量检查点，`recovery.ts` 在启动时扫描：

| phase | 含义 | 谁写入 |
|-------|------|--------|
| `pending` | turn 刚创建，尚未开始执行 | `CoreDatabase.createTurnState` |
| `running`（含 checkpoint） | 执行中，每个 tool-result 后更新 checkpoint | `CoreDatabase.updateTurnState` |
| `completed` | 本轮正常结束 | `CoreDatabase.completeTurnState` |
| `failed` | 本轮出错，记录 error | `CoreDatabase.failTurnState` |

启动时 `scanIncompleteTurns` 找出 `phase NOT IN ('completed', 'failed')` 的记录，由 `AgentLoop.resume()` 从 checkpoint 继续；超过 24 小时的 `turn_state` 行由 `cleanOldTurnState` 清理。

### Tool 执行状态机

每次工具调用经过 `tool-factory.ts` 的 execute 包装，状态从 `running` 流转到 `done` 或 `error`，全程被 Hook + 限速器包裹：

```
tool_start → PreToolUse hook（可阻断）→ ToolRateLimiter.acquire（FIFO 排队）
  → execute → release → PostToolUse / PostToolUseFailure hook → truncateResult → tool_end
```

- `running`：从 `tool_start` 事件发出，到 `tool_end` 之前；UI block 通过 `toolCallId` 匹配（不是工具名）。
- `done`：execute 成功返回，PostToolUse hook 执行后置操作。
- `error`：execute 抛错或 PreToolUse hook 阻断，PostToolUseFailure hook 记录失败原因。
- 阻断（PreToolUse hook 返回 abort）会被记录为失败，而非 `running` 永久挂起。

### Requirement 状态机（多 agent 工作流）

定义在 `src/server/requirement-state-machine.ts`，纯函数白名单，由 `RequirementStore` 在更新前校验，`triggeredBy` 区分 `user / analyst / lead / system`：

```
found → discuss → ready → plan → build ⇄ verify → closed
                                              ↑        ↓
                                              └─ build ┘
        （任意状态 → cancelled，仅 user 可触发）
```

- `found`：需求被 analyst 或 user 发现/录入。
- `discuss`：与用户澄清，往返后回到 `found` 或推进到 `ready`。
- `ready`：澄清完成，等待 lead 接手。
- `plan` → `build`：lead 拆解为任务并开始实现，可循环回 `ready`。
- `build` ⇄ `verify`：build 完成由 system 推进到 verify，verify 不通过由 lead 退回 build。
- `verify` → `closed`：analyst 或 user 确认通过即关闭；`closed` 可由 user 重新拉回 `found` 再次分析。
- `cancelled`：user 可在任意非空状态取消（特殊规则，不需匹配白名单）。

非法转换会被 `isValidTransition` 拒绝并返回 `validTargets` 提示合法后继。

## 维护规则

- 每次用户流程、事件流或异常处理变化后，必须检查并更新本文件
