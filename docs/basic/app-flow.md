# 产品流程说明

## 核心流程

1. **启动流程**
   - Electron 主进程启动（`src/main/index.ts`）
   - 初始化数据库、运行迁移（`db-migration.ts`）
   - 注册 Hook 系统 + 持久化 Hook + 工具执行记录 Hook + 运行时 feature hooks（compression、memory、RAG）
   - 创建 ToolRegistry、MCPManager
   - 启动时清理孤儿 agent-tool 条目（`agentToolStore.cleanupOrphans()`）
   - 扫描中断的 turn 并恢复（`recovery.ts`）
   - 创建主窗口，加载渲染进程

2. **Agent 执行流程**
   - 用户发送消息 → IPC `chat:send` → `agent-service.ts`
   - 构建 SessionConfig（含 toolPolicy.tools map 传递到运行时）
   - AgentLoop 启动，组装 system prompt（base + tool_policy）
   - PreLLMCall hooks 注入动态上下文（memory recall、RAG、环境信息）
   - `streamText()` 调用 AI SDK，处理流式事件
   - PostTurnComplete hooks 执行后处理（compression、memory extraction）
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
   - 删除 Agent → `afterDelete` 回调级联删除关联 agent-tool 条目
   - 启动时 `cleanupOrphans()` 清理引用已删除 Agent 的 agent-tool 记录

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

## 维护规则

- 每次用户流程、事件流或异常处理变化后，必须检查并更新本文件
