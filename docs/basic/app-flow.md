# 产品流程说明

## 核心流程

1. **启动流程**
   - Electron 主进程启动（`src/main/index.ts`）
   - 初始化数据库、配置和 Hook 注册表
   - 注册指标收集 Hook 和工具执行记录 Hook
   - 创建主窗口
   - 加载渲染进程（React 应用）

2. **Agent 执行流程**
   - 用户发送消息（`ChatPanel`）
   - IPC 调用到主进程（`session-handlers.ts`）
   - Agent 循环执行（`src/runtime/agent-loop.ts`）
   - 工具调用（`src/runtime/tools/`）
   - Hook 系统触发 PreToolUse / PostToolUse 事件
   - 结果记录到 `turn-recorder.ts` 和 `tool_executions` 表
   - 结果返回渲染进程

3. **工具管理流程**
   - 工具注册（`tool-registry.ts`）
   - 工具执行（`tool-factory.ts`）
   - 工具执行记录（`tool-execution-hooks.ts` → `session-db.ts`）
   - 结果记录（`turn-recorder.ts`）

4. **工具分析流程**
   - 进入 Tools 页面统计 Tab
   - 查看工具调用概况（总调用、错误率、平均耗时）
   - 选择工具查看详细错误列表
   - 点击 AI 分析获取错误诊断建议

5. **仪表板流程**
   - 进入 Dashboard 页面
   - 查看会话指标（活跃会话、Token 用量、延迟统计）
   - 实时刷新（2 秒间隔）

6. **数据清理流程**
   - 调用清理接口（`tool-execution-handlers.ts` → `cleanup`）
   - 按时间阈值清理旧工具执行记录和 Turn 状态

## 用户路径

- **创建 Agent**：进入 Agents 页面 → 填写配置 → 保存
- **运行 Agent**：选择 Agent → 发送消息 → 查看结果
- **管理工具**：进入 Tools 页面 → 配置工具 → 测试工具
- **查看工具统计**：进入 Tools 页面 → 统计 Tab → 查看调用概况和错误分析
- **AI 错误分析**：工具统计页 → 选择工具 → 点击 AI 分析 → 查看诊断报告
- **监控会话**：进入 Dashboard 页面 → 查看实时指标

## 状态变化

- `session_init` → `text_delta` → `tool_start` → `tool_end` → `agent_end`
- Hook 生命周期：`SessionStart` → `PreToolUse` → `PostToolUse` / `PostToolUseFailure` → `SessionEnd`
- 异常状态：工具失败、超时、数据库错误、Hook 执行异常

## 维护规则

- 每次用户流程、页面跳转、任务状态或异常处理发生变化后，必须检查并更新本文件
