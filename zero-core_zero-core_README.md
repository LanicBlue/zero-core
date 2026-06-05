# zero-core (项目根目录)

## 核心功能
zero-core 是基于 Electron 的可配置 Agent 运行时平台，提供 CLI、桌面应用和 HTTP API 三种运行模式，支持多 Provider、MCP 工具集成、知识库和子 Agent 委派。

## 输入
用户配置（package.json、tsconfig）、Agent 指令（CLAUDE.md）、环境变量

## 输出
可运行的 Electron 桌面应用、CLI 工具、HTTP API 服务

## 定位
项目根目录，整合所有子模块的顶层入口

## 依赖
Electron、Vite、TypeScript、Playwright 等构建与运行时依赖；src/ 目录下的所有子模块

## 维护规则
- 新增顶层脚本需在 package.json scripts 中注册
- 构建配置变更需同步检查 electron.vite.config.ts 和 tsconfig
- 版本号变更在 package.json version 字段统一管理
