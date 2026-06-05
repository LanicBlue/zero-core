# 项目文件结构

## 项目定位

zero-core 是一个基于 Electron 的自定义 Agent 核心应用，支持可配置的工具扩展、MCP 集成和工具分析。应用采用主进程（Electron main）+ 渲染进程（React）+ 服务层（Node.js）的架构。

## 核心目录

- `src/` - 主要源码目录
  - `core/` - 核心逻辑：配置、上下文管理、工具策略、提示词、Hook 系统、日志
  - `main/` - Electron 主进程：IPC 处理器（21 个）、生命周期管理
  - `preload/` - 预加载脚本：IPC API 暴露
  - `renderer/` - React 前端：组件（9 个页面目录）、状态管理（10 个 store）、样式
  - `runtime/` - Agent 运行时：循环执行、工具调用（20 个内置工具）、MCP 工具（4 个）、子代理委派
  - `server/` - 服务层：Agent 服务、会话管理、数据存储（12 个 store）、指标收集、Hook 集成
  - `shared/` - 共享类型、IPC 契约、工具函数
- `scripts/` - 构建和工具脚本
- `tests/` - 单元测试和 E2E 测试
- `docs/` - 项目文档
- `.openprd/` - OpenPrd 工作区状态

## renderer/ 子目录

- `components/agents/` - Agent 管理组件
- `components/chat/` - 聊天界面组件
- `components/common/` - 共享 UI 组件
- `components/dashboard/` - 仪表板页面
- `components/kb/` - 知识库管理
- `components/layout/` - 布局组件
- `components/mcp/` - MCP 设置组件
- `components/settings/` - 设置页面组件
- `components/tools/` - 工具配置和统计分析页面
- `components/workspace/` - 工作区组件
- `store/` - 10 个 Zustand store（agent, agent-tool, chat, interaction, kb, mcp, page, provider, template, theme）

## runtime/ 子目录

- `tools/` - 20 个内置工具（bash, file-read, file-write, file-edit, grep, glob, agent, agent-tool, ask-user, web-search, mcp-tool, syntax-check, task-list, task-status, task-stop, todo-write, wait, tool-factory, index, file-read-helpers）
- `tools/outline/` - 代码大纲提取器（27 种语言）
- `mcp-tools/` - 4 个 MCP 工具包装（assistant, fetch, memory, sequential-thinking）

## server/ 子目录

- 数据存储层：12 个 store（sqlite-store, agent, agent-tool, provider, mcp, kb, template, message, memory, key-value, persona, session-db）
- 知识库：kb-db, kb-embeddings, kb-ingest, kb-search, kb-router
- 指标系统：session-metrics, metrics-hooks, metrics-events
- Hook 集成：tool-execution-hooks, durable-hooks
- 路由层：agent, agent-tool, config, mcp, provider, template router
- 基础设施：db-migration, recovery, session-lifecycle, workspace-config

## 文件组织规则

- 新增文件时，应同步确认所在文件夹说明书是否需要更新
- 跨模块移动文件时，应更新本文件中的目录结构和职责说明

## 维护规则

- 每次新增、删除、移动目录或核心文件后，必须检查并更新本文件
- 本文档只记录项目结构事实，不承载具体功能需求细节
