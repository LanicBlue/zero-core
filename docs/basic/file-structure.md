# 项目文件结构

## 项目定位

zero-core 是一个基于 Electron 的自定义 Agent 核心应用，支持可配置的工具扩展和 OpenClaw harness 集成。应用采用主进程（Electron main）+ 渲染进程（React）+ 服务层（Node.js）的架构。

## 核心目录

- `src/` - 主要源码目录
  - `core/` - 核心逻辑：配置、上下文管理、工具策略、提示词等
  - `main/` - Electron 主进程：IPC 处理器、生命周期管理
  - `preload/` - 预加载脚本：IPC API 暴露
  - `renderer/` - React 前端：组件、状态管理、样式
  - `runtime/` - Agent 运行时：循环执行、工具调用、MCP 集成
  - `server/` - 服务层：Agent 服务、会话管理、MCP 路由
  - `shared/` - 共享类型和常量
- `scripts/` - 构建和工具脚本
- `tests/` - 单元测试和 E2E 测试
- `docs/` - 项目文档
- `.openprd/` - OpenPrd 工作区状态

## 文件组织规则

- 新增文件时，应同步确认所在文件夹说明书是否需要更新
- 跨模块移动文件时，应更新本文件中的目录结构和职责说明

## 维护规则

- 每次新增、删除、移动目录或核心文件后，必须检查并更新本文件
- 本文档只记录项目结构事实，不承载具体功能需求细节
