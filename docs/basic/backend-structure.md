# 后端架构设计

## 适用范围

本文档适用于 zero-core 的后端架构，包括主进程、服务层、Hook 系统和数据流。

## 服务边界

**主要服务**：
- `src/main/index.ts` - Electron 主进程入口
- `src/server/agent-service.ts` - Agent 执行服务
- `src/server/session-db.ts` - 会话数据库服务（含工具执行记录和统计）
- `src/server/session-metrics.ts` - 会话指标收集服务（Welford 在线统计算法）
- `src/server/mcp-manager.ts` - MCP 服务器管理
- `src/runtime/agent-loop.ts` - Agent 循环执行引擎

**模块职责**：
- `src/main/ipc/` - IPC 处理器（21 个），连接渲染进程和主进程
- `src/runtime/` - Agent 运行时，包括工具调用、状态管理、子代理委派
- `src/server/` - 服务层，提供数据持久化、业务逻辑和指标收集
- `src/core/` - 核心逻辑，包括配置、上下文管理和 Hook 系统

## Hook 系统

**注册表**：
- `src/core/hook-registry.ts` - 单例 Hook 注册表，支持 27 个生命周期事件

**Hook 事件类型**：
- 工具生命周期：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`
- 会话生命周期：`SessionStart`、`SessionEnd`、`Stop`、`StopFailure`
- 子代理：`SubagentStart`、`SubagentStop`
- 压缩：`PreCompact`、`PostCompact`
- 配置变更：`ConfigChange`、`CwdChanged`、`FileChanged`

**Hook 消费者**：
- `src/server/tool-execution-hooks.ts` - 工具执行记录
- `src/server/metrics-hooks.ts` - 指标收集
- `src/server/durable-hooks.ts` - 持久化执行钩子

## CLI 接入面

**不适用** - zero-core 是 Electron 应用，不提供 CLI 接入面。

## API 接入面

**内部 IPC 接口**：
- `session-handlers.ts` - 会话管理（创建、删除、查询）
- `agent-handlers.ts` - Agent 执行（启动、停止、流式输出）
- `tool-handlers.ts` - 工具管理（列表、配置、测试）
- `tool-execution-handlers.ts` - 工具分析（统计、清理、AI 诊断）
- `config-handlers.ts` - 配置管理（获取、更新）
- `chat-handlers.ts` - 聊天交互
- `agent-tool-handlers.ts` - Agent 工具绑定
- `provider-handlers.ts` - Provider 配置
- `mcp-handlers.ts` - MCP 服务器管理
- `kb-handlers.ts` - 知识库操作
- `template-handlers.ts` - 提示词模板
- `message-handlers.ts` - 消息编辑删除
- `log-handlers.ts` - 日志文件访问
- `dialog-handlers.ts` - 原生对话框
- `file-handlers.ts` - 文件操作
- `github-template-handlers.ts` - GitHub 模板导入

**协议**：Electron IPC（基于事件，通过 `typed-ipc.ts` 类型安全封装）

## 数据流

**输入路径**：
- 用户输入 → 渲染进程 → IPC → 主进程 → Agent 服务

**处理路径**：
- Agent 循环 → 工具调用 → Hook 触发 → 结果处理 → 状态更新
- Hook 触发 → 工具执行记录写入 SQLite
- Hook 触发 → 指标收集更新内存统计

**存储路径**：
- 会话数据 → SQLite（`session-db.ts`）
- 工具执行记录 → SQLite `tool_executions` 表
- Turn 状态检查点 → SQLite `turn_state` 表
- 配置数据 → JSON 文件（`config.yaml`）
- 指标数据 → 内存（Welford 在线统计，按会话聚合）

**输出路径**：
- Agent 结果 → IPC → 渲染进程 → UI 更新
- 工具统计 → IPC → Tools 页面统计 Tab
- 会话指标 → IPC → Dashboard 页面

## 维护规则

- 每次服务边界、IPC 接入契约、数据流、存储或外部依赖发生变化后，必须检查并更新本文件
