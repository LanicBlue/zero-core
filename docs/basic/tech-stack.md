# 项目技术栈

## 运行环境

- **语言**：TypeScript
- **运行时**：Node.js 24+
- **平台**：Windows、macOS、Linux（Electron 跨平台）
- **构建工具**：Vite (electron-vite)
- **包管理器**：npm

## 核心依赖

**框架和 UI**：
- `electron` - Electron 框架
- `react` - React UI 框架
- `react-dom` - React DOM
- `zustand` - 状态管理

**AI 集成**：
- `@ai-sdk/anthropic` - Anthropic AI SDK
- `@ai-sdk/openai` - OpenAI AI SDK
- `@ai-sdk/google` - Google AI SDK
- `@modelcontextprotocol/sdk` - MCP SDK
- `ai` - Vercel AI SDK

**数据存储**：
- `better-sqlite3` - SQLite 数据库

**工具和实用**：
- `jsdom` - DOM 模拟
- `pdf-parse` - PDF 解析
- `turndown` - HTML 转 Markdown
- `shiki` - 语法高亮
- `uuid` - UUID 生成
- `zod` - 数据验证

**测试**：
- `vitest` - 单元测试
- `playwright` - E2E 测试

## 工具链

**构建**：
- `npm run build` - 构建应用
- `npm run build:lib` - 构建 TypeScript
- `npm run build:win` - 构建 Windows 安装包
- `npm run build:mac` - 构建 macOS 安装包

**开发**：
- `npm run dev` - 启动开发模式
- `npm run preview` - 预览构建

**测试**：
- `npm run test:unit` - 运行单元测试
- `npm run test:e2e` - 运行 E2E 测试

**质量检查**：
- `npm run check:handlers` - 检查处理器模块
- `npm run build:codegraph` - 构建代码图

## 维护规则

- 每次新增、移除或升级核心依赖、运行时和工具链后，必须检查并更新本文件
