# 项目技术栈

## 运行环境

- **语言**：TypeScript
- **运行时**：Node.js >= 20.6.0
- **平台**：Windows、macOS、Linux（Electron 跨平台）
- **构建工具**：electron-vite（Vite）
- **包管理器**：npm

## 核心依赖

**框架和 UI**：
- `electron` — 桌面框架
- `react@^19.2.6` — React 19
- `react-dom` — React DOM
- `zustand@^5.0.13` — 状态管理
- `react-markdown` + `remark-gfm` + `rehype-raw` — Markdown 渲染
- `shiki` — 语法高亮

**AI 集成**：
- `ai@^6.0.180` — Vercel AI SDK（streamText, tool）
- `@ai-sdk/anthropic@^3.0.77` — Anthropic
- `@ai-sdk/openai@^3.0.63` — OpenAI
- `@ai-sdk/google@^3.0.73` — Google
- `@modelcontextprotocol/sdk@^1.29.0` — MCP SDK

**数据存储**：
- `better-sqlite3@^12.10.0` — SQLite（需 node-gyp 针对 Electron 版本编译）

**工具和实用**：
- `zod@^4.4.3` — 数据验证
- `typebox` — JSON Schema 验证
- `jsdom` — DOM 模拟（WebFetch HTML 处理）
- `turndown` — HTML 转 Markdown
- `pdf-parse` — PDF 解析
- `uuid@^14.0.0` — ID 生成
- `undici@^8.3.0` — HTTP 客户端

**测试**：
- `vitest` — 单元测试
- `playwright` — E2E 测试

## 构建命令

| 命令 | 用途 |
|------|------|
| `npm run dev` | 开发模式 |
| `npm run build` | 构建（lib + electron-vite） |
| `npm run build:win` | Windows 安装包 |
| `npm run test:unit` | 单元测试 |
| `npm run test:e2e` | E2E 测试 |
| `npm run check:handlers` | 检查处理器模块依赖 |
| `npm run serve` | HTTP/WS 服务器模式 |

## 维护规则

- 每次新增、移除或升级核心依赖后，必须检查并更新本文件
