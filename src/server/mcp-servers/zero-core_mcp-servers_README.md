# mcp-servers

## 核心功能
MCP 服务器管理入口，提供内置 MCP 服务器实例的统一注册和导出。

## 输入
runtime/mcp-tools 下的工具模块

## 输出
内置 MCP 服务器配置（web_fetch、memory、sequential-thinking、assistant）

## 定位
src/server/mcp-servers/ — 服务层 MCP 服务器注册，被 mcp-manager 加载

## 依赖
../mcp-manager.ts（MCP 生命周期管理）；../mcp-store.ts（配置持久化）

## 维护规则
- 新增内置 MCP 服务器需在此文件中注册
- 服务器配置变更需检查 mcp-manager.ts 的加载逻辑
