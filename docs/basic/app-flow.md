# 产品流程说明

## 核心流程

1. **启动流程**
   - Electron 主进程启动（`src/main/index.ts`）
   - 初始化数据库和配置
   - 创建主窗口
   - 加载渲染进程（React 应用）

2. **Agent 执行流程**
   - 用户发送消息（`ChatPanel`）
   - IPC 调用到主进程（`session-handlers.ts`）
   - Agent 循环执行（`src/runtime/agent-loop.ts`）
   - 工具调用（`src/runtime/tools/`）
   - 结果返回渲染进程

3. **工具管理流程**
   - 工具注册（`tool-registry.ts`）
   - 工具执行（`tool-factory.ts`）
   - 结果记录（`turn-recorder.ts`）

## 用户路径

- **创建 Agent**：进入 Agents 页面 → 填写配置 → 保存
- **运行 Agent**：选择 Agent → 发送消息 → 查看结果
- **管理工具**：进入 Tools 页面 → 配置工具 → 测试工具

## 状态变化

- `session_init` → `text_delta` → `tool_start` → `tool_end` → `agent_end`
- 异常状态：工具失败、超时、数据库错误

## 维护规则

- 每次用户流程、页面跳转、任务状态或异常处理发生变化后，必须检查并更新本文件
