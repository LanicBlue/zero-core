# runtime/mcp-tools/

MCP 风格的扩展工具集合：以 `buildTool` 注册、可被 agent 调用的能力，覆盖记忆、思考、助手委派、网页抓取等场景。

## 核心功能

- `memory-node-tools.ts`：记忆 wiki 工具 `MemoryRecall`（search/recent/subject 只读检索）与 `MemoryNote`（create/update/delete/link 写入），替代旧知识图谱工具。
- `memory-tools.ts`：兼容旧版记忆相关工具入口。
- `sequential-thinking-tools.ts`：分步思考工具，支持 agent 显式拆解推理。
- `assistant-tools.ts`：子助手 / 委派相关工具。
- `fetch-tools.ts`：WebFetch 类抓取，按需调用浏览器渲染。
- `browser-render.ts`：用 Electron 隐藏 BrowserWindow（persist:webfetch 分区）渲染 SPA 并抓取最终 HTML。
- `cookie-jar.ts`：webfetch 的 cookie 持久化（`~/.zero-core/webfetch/cookies.json`），按 domain 存取。

## 输入

- 工具入参（zod schema 校验）：查询词、subject、URL、cookie 列表、思考步骤等。
- 执行上下文 `ctx`：`db`（取 MemoryNodeStore）、`sessionId`、当前会话状态。

## 输出

- 人类可读字符串结果（命中列表、写入确认、抓取 HTML 等）。
- 副作用：记忆节点写入 / 删除 / 链接、cookie 文件读写、BrowserWindow 创建与销毁。

## 定位

`src/runtime/mcp-tools/` 是 runtime 暴露给 agent 的高阶能力层，介于 `runtime/tools/tool-factory`（注册机制）与底层 store / Electron 之间。与 `runtime/tools/` 的区别：本目录偏"集成型"工具（记忆系统、浏览器、思考框架），`tools/` 偏文件/搜索/执行等基础能力。

## 依赖

- `zod`、`runtime/tools/tool-factory`（buildTool 注册）。
- `server/memory-node-store`（记忆节点存储）。
- `electron`（browser-render 的 BrowserWindow、session）、`persist:webfetch` 分区。
- `node:fs` / `node:path` / `node:os`（cookie-jar）。

## 维护规则

- 记忆节点类型集合（event/decision/discovery/status_change/preference）若扩展，需同步 compression-engine L2 prompt、memory-recall 渲染、docs。
- `browser-render` 分区名或 cookie 注入策略变更必须与 `cookie-jar` 及 webfetch UI 同步。
- 新增工具统一用 `buildTool` 注册并补 meta（category / isReadOnly / isDestructive / isConcurrencySafe），不要手写裸 schema。
- cookie 文件格式变更需考虑老用户数据迁移，避免静默丢弃登录态。
