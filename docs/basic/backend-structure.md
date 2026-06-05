# 后端架构设计

## 适用范围

本文档适用于 zero-core 的后端架构，包括主进程、服务层和数据流。

## 服务边界

**主要服务**：
- `src/main/index.ts` - Electron 主进程入口
- `src/server/agent-service.ts` - Agent 执行服务
- `src/server/session-db.ts` - 会话数据库服务
- `src/server/mcp-manager.ts` - MCP 服务器管理
- `src/runtime/agent-loop.ts` - Agent 循环执行引擎

**模块职责**：
- `src/main/ipc/` - IPC 处理器，连接渲染进程和主进程
- `src/runtime/` - Agent 运行时，包括工具调用和状态管理
- `src/server/` - 服务层，提供数据持久化和业务逻辑

## CLI 接入面

**不适用** - zero-core 是 Electron 应用，不提供 CLI 接入面。

## API 接入面

**内部 IPC 接口**：
- `session-handlers.ts` - 会话管理（创建、删除、查询）
- `agent-handlers.ts` - Agent 执行（启动、停止、流式输出）
- `tool-handlers.ts` - 工具管理（列表、配置、测试）
- `config-handlers.ts` - 配置管理（获取、更新）

**协议**：Electron IPC（基于事件）

## 数据流

**输入路径**：
- 用户输入 → 渲染进程 → IPC → 主进程 → Agent 服务

**处理路径**：
- Agent 循环 → 工具调用 → 结果处理 → 状态更新

**存储路径**：
- 会话数据 → SQLite（`session-db.ts`）
- 配置数据 → JSON 文件（`config.yaml`）

**输出路径**：
- Agent 结果 → IPC → 渲染进程 → UI 更新

## 维护规则

- 每次服务边界、IPC 接入契约、数据流、存储或外部依赖发生变化后，必须检查并更新本文件
