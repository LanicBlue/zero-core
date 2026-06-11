# 技术栈选型

> 只列**实际出现在 package.json / 代码中**的依赖。版本号省略，关注选型理由。

---

## 一、运行时基础

| 依赖 | 选型 | 理由（基于代码观察） |
|------|------|----------------------|
| **Electron 41.6** | 主进程载体 | 跨平台桌面、需要 BrowserWindow / webview / session 隔离等原生能力 |
| **Node.js ≥ 20.6** | 后端运行时 | 满足 `import.meta.url`、`AbortSignal.timeout` 等语法；`process.version` 在 assistant-tools 中直接被读出 |
| **TypeScript 5.7** | 全栈类型 | `tsconfig.json` 用 project references；`tsconfig.cli.json` 单独编译 lib 子集 |

**关键约束**：
- `electron-builder.yml#npmRebuild: true` —— better-sqlite3 必须在打包前用 Electron ABI 重新编译
- 启动时 Electron 在 `before-quit` 主动 `shutdownBackend()`，需要 Node.js 端做优雅退出

---

## 二、Agent 核心

| 依赖 | 用途 | 关键使用点 |
|------|------|-----------|
| **Vercel AI SDK (`ai` 6.0)** | `streamText` / `stepCountIs` / `generateText` / `tool` | `runtime/agent-loop.ts` 的执行核心；`compression-engine.ts` 摘要；`tool-execution-router.ts` AI 分析 |
| **@ai-sdk/anthropic / openai / google** | 三个官方 provider | `runtime/provider-factory.ts` 工厂 |
| **@modelcontextprotocol/sdk** | MCP 客户端 | `server/mcp-manager.ts` 创建 `Client` + `StdioClientTransport` / `SSEClientTransport` |

**provider-factory 抽象**：
```
type+apiKey+baseUrl  →  cache key  →  cached factory
                                          ↓
                            provider.chat(modelId)  →  LanguageModelV2
                                          ↓
                          wrapLanguageModel(middleware)  // 并发限流
```

---

## 三、LLM 输出工具

| 依赖 | 用途 | 关键使用点 |
|------|------|-----------|
| **zod 4.x** | 工具输入 schema / 运行时配置 | `tool-factory.ts` 用 Zod 描述 inputSchema；运行时再 `_def.shape` 反向内省给 UI 生成表单 |
| **uuid 14** | ID 生成 | `AgentRecord` / `SessionRecord` / `MemoryNode` |

---

## 四、持久化

| 依赖 | 用途 | 关键使用点 |
|------|------|-----------|
| **better-sqlite3 12.10** | 同步式 SQLite 客户端 | **唯一允许在主进程和后端进程共享的存储介质**。同步 API 让 hook 处理器能在不引入异步地狱的情况下写库 |
| **uuid 14** | 通用 UUID v4 | `MemoryNode.id`、`AgentStore.create`、KVStore 内部用 |

**选型理由**：
- 不用 Prisma / Drizzle —— 想要简单、无需迁移工具（团队用自写 `db-migration.ts` 拼接 SQL）、同步 IO 友好
- 不用 Postgres / MySQL —— 桌面应用不引入外部依赖；后续要云端化再说

---

## 五、知识 / 记忆 / RAG

| 依赖 | 用途 | 关键使用点 |
|------|------|-----------|
| **FTS5（SQLite 内建）** | `memory_nodes_fts` 虚拟表 | `memory-node-store.ts` 全文搜 + unicode61 tokenize |
| **Float32Array** | 存向量 | `KbDB.insertChunksBatch` 序列化到 BLOB 列；`kb-search.ts` 余弦相似度 |
| **pdf-parse 2.4** | PDF 文本提取 | `kb-ingest.ts` 和 `file-read-helpers.ts` 都用，且有 `pdf-parse`/`PDFParse` 双 API 兼容 |
| **turndown 7.2** | HTML → Markdown | `fetch-tools.ts` 抓取网页后转 LLM 友好格式 |
| **jsdom 29.1** | 服务端 DOM 解析 | 同上，strip 标签、提取链接/图片元数据 |
| **shiki 4.0** | 代码高亮（renderer） | `renderer/utils/shiki-init.ts` 懒加载；markdown 渲染使用 |

---

## 六、Web / HTTP / 实时

| 依赖 | 用途 | 关键使用点 |
|------|------|-----------|
| **express 5.0** | HTTP API | `server/index.ts` 唯一进程入口 |
| **ws 8.18** | WebSocket | `/ws` 端点推送 streamEvent |
| **undici 8.3** | 全局代理 dispatcher | `runtime/proxy-manager.ts` 注入到 `setGlobalDispatcher` |
| **node 原生 `fetch`** | HTTP 客户端 | 大量使用（KB 搜索、模型 metadata 拉取、GitHub template sync） |

**为什么不用 axios**：
- 全平台 `fetch` 已经成熟
- 在 undici dispatcher 注入后，fetch 自动走代理，无需在每个调用点传配置

---

## 七、UI / 渲染

| 依赖 | 用途 | 关键使用点 |
|------|------|-----------|
| **React 19.2** | UI 框架 | 整个 renderer/ |
| **react-dom 19.2** | DOM 渲染 | main.tsx |
| **zustand 5.0** | 状态管理 | 9 个 store：chat / agent / agent-tool / mcp / kb / provider / template / theme / page / interaction |
| **react-markdown 10.1** | Markdown 渲染 | `components/common/MarkdownRenderer.tsx` |
| **remark-gfm 4.0** | GFM 扩展 | 同上（表格、删除线） |
| **rehype-raw 7.0** | 原始 HTML 支持 | 同上（webfetch 抓回来的 HTML 块） |
| **mermaid 11.15** | 流程图渲染 | `docs/basic/` 中提到应支持，UI 集成见 chat 块 |

---

## 八、文件系统 / 进程

| 依赖 | 用途 | 关键使用点 |
|------|------|-----------|
| **node:fs / node:child_process** | 文件、子进程 | Shell 工具的 execFile、文件读写、Glob/Outline 提取 |
| **path / os / fs/promises** | 标准库 | 散布各处 |
| **node 加密模块** | URL hash | `fetch-tools.ts#urlHash`（cache key） |

---

## 九、构建 / 工具

| 依赖 | 用途 | 关键使用点 |
|------|------|-----------|
| **electron-vite 5.0** | 桌面构建 | main / preload / renderer 三段式 |
| **vite 6.4** | renderer 独立 dev server | 端口 5173，proxy `/api` `/ws` → 3210 |
| **@vitejs/plugin-react 4.7** | React Fast Refresh | renderer/ |
| **vitest 4.1** | 单元测试 | `tests/` 暂为空（见 `07-evolution/04-testing-strategy.md`） |
| **@playwright/test 1.60** | E2E | `playwright.config.ts`；mock fixture 由 `ZERO_CORE_TEST_FIXTURE` 注入 |
| **tsx 4.22** | tsx 脚本执行 | `scripts/check-handler-modules.ts`、`scripts/build-codegraph.ts` |
| **electron-builder 26.8** | 打包 | NSIS / Portable / DMG / AppImage |

---

## 十、TypeBox（特殊）

`core/config.ts` 引入 `typebox` 但实际**只用了 `Static` 工具类型 + 简单的 `Type.Object` 描述**。但观察到的 schema 字段数量级小（~30 个），完全可以用 zod 替代。

→ 详见 `07-evolution/02-known-issues.md#1-typebox-的存留价值`

---

## 选型哲学（从代码倒推）

观察到的几个**一致性原则**：

1. **依赖即用** —— 没有 babel 链、没有 polyfill 链；用 zod 不用 yup，用 fetch 不用 axios
2. **node 原生优先** —— `node:fs/promises`、`node:child_process`、`crypto`、`path` 全程使用
3. **不引入 ORM** —— 团队选择手写 `SqliteStore<T>` 泛型，因为 schema 简单、列名可控
4. **同步 SQLite** —— `better-sqlite3` 是少数仍然能完美支持 Node.js ABI + Electron ABI 的同步 SQLite 库

---
