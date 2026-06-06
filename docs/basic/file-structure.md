# 项目文件结构

## 项目定位

zero-core 是基于 Electron 的 AI Agent 运行时，采用 main + preload + renderer + runtime + server 五层架构。

## 核心目录

- `src/core/` — 核心逻辑：配置（config, constants）、上下文管理、工具策略、系统提示词、Hook 注册表、日志、工具注册中心
- `src/main/` — Electron 主进程：入口、IPC 处理器（typed-ipc, 16 个 handler 模块）
- `src/preload/` — 预加载脚本：IPC API 暴露给渲染进程
- `src/renderer/` — React 前端：组件（10 个页面目录）、10 个 Zustand store、样式
- `src/runtime/` — Agent 运行时：执行引擎、工具集、限速器、子任务委派、检查点
- `src/server/` — 服务层：Agent 服务、数据存储、REST 路由、MCP 管理、知识库
- `src/shared/` — 共享类型、IPC 契约、工具函数

## runtime/ 详细结构

- `agent-loop.ts` — 核心执行引擎
- `session.ts` — 会话消息和 token 管理
- `subagent-delegator.ts` — 子任务委派
- `checkpoint-manager.ts` — 对话检查点
- `tool-rate-limiter.ts` — per-tool FIFO 限速
- `turn-recorder.ts` — 流式输出记录
- `prompt-sections.ts` — 系统提示词组装
- `provider-factory.ts` — 模型解析
- `agent-utils.ts` — 错误分类和重试逻辑
- `tools/` — 17 个内置工具 + tool-factory + index
  - `outline/` — 代码大纲系统（27 种语言提取器 + renderer）
- `mcp-tools/` — 5 个内置 MCP 工具（assistant, browser-render, fetch, memory, sequential-thinking）

## server/ 详细结构

- 数据存储：AgentStore、AgentToolStore、ProviderStore、TemplateStore、McpStore、KbStore、SessionDB
- 基础设施：SqliteStore、db-migration、recovery、workspace-config、session-lifecycle
- 路由层：agent、agent-tool、config、mcp、provider、template、kb router
- 服务：agent-service、mcp-manager
- Hook 集成：tool-execution-hooks、durable-hooks、metrics-hooks
- 知识库：kb-db、kb-embeddings、kb-ingest、kb-search

## renderer/ 详细结构

- `components/` — 10 个页面目录：agents、chat、common、dashboard、kb、layout、mcp、settings、tools、workspace
- `store/` — 10 个 Zustand store：agent、agent-tool、chat、interaction、kb、mcp、page、provider、template、theme
- `styles/` — 全局样式 + 主题
- `types/` — 前端类型定义

## 维护规则

- 每次新增、删除、移动目录或核心文件后，必须检查并更新本文件
- 本文档只记录项目结构事实，不承载功能需求细节
