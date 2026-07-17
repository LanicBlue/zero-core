# 项目文件结构

> 当前目录基线，按 2026-07-16 的源代码树核对。本文避免维护会快速漂移的文件数量。

## 仓库顶层

```text
zero-core/
├── src/                    # 产品源代码
├── tests/unit/             # Vitest 单元测试
├── tests/e2e/              # Playwright Electron E2E
├── scripts/                # 构建、开发、自更新和文档检查脚本
├── docs/basic/             # 当前行为基线
├── docs/arch/              # 深度架构分析，修改前仍需回看代码
├── docs/design/            # 进行中的设计
├── docs/plan/              # 尚未完成的实施计划
├── docs/archive/           # 历史记录，不是当前事实
├── electron.vite.config.ts # Electron 三入口构建
├── electron-builder.yml    # 平台打包
└── package.json            # 命令与依赖的权威来源
```

## `src/` 顶层职责

| 路径 | 当前职责 |
| --- | --- |
| `src/core/` | 配置、提示词、工具注册表、Hook 注册表、模型元数据、日志和通用核心能力 |
| `src/main/` | Electron 生命周期、窗口、本地 IPC、后端子进程生命周期和 IPC→HTTP/WS 桥 |
| `src/preload/` | 通过 `contextBridge` 暴露受控的 `window.api` |
| `src/renderer/` | React 页面、组件、Zustand store 和样式 |
| `src/runtime/` | AgentLoop、Session、流式事件、并发、检查点、子代理和运行时 Hook |
| `src/server/` | Express/WS、AgentService、Store、迁移、恢复、工作流和后台服务 |
| `src/shared/` | 跨进程类型、preload/IPC 契约和共享工具函数 |
| `src/tools/` | 当前内置工具、工具工厂、MCP 平台工具、Skill 路径适配和 Outline |
| `src/backend.ts` | Electron 拉起的后端子进程入口 |
| `src/serve.ts` | 独立 HTTP/WS 服务入口 |
| `src/cli.ts` | 终端 CLI 入口 |
| `src/index.ts` | 库导出入口 |

旧文档中的 `src/runtime/tools/` 与 `src/runtime/mcp-tools/` 已不存在。新增内置工具应放在 `src/tools/`，MCP 平台工具放在 `src/tools/mcp/`。

## 关键子目录

### `src/main/`

- `index.ts`：应用就绪、窗口创建、少量必须留在主进程的本地能力。
- `backend-spawn.ts`：开发模式使用系统 Node，打包模式使用 Electron fork；负责就绪握手、重启和关闭。
- `ipc-proxy.ts`：把 preload invoke 翻译为本地后端 HTTP 请求，并把 WebSocket 事件转回 renderer。
- `test-setup.ts`：E2E fixture 接线。

### `src/runtime/`

- `agent-loop.ts`：模型 step 与工具调用循环。
- `session.ts`、`turn-recorder.ts`、`checkpoint-manager.ts`：消息、turn、流式记录和恢复状态。
- `subagent-delegator.ts`、`task-registry.ts`、`workbench.ts`：委派任务、后台任务与运行时工作台。
- `hooks/`：按 main/delegated loop 注册的功能 Hook。当前压缩使用 `compression-trigger-hooks.ts`，旧 `compression-hooks.ts` 和 `extraction-hooks.ts` 已删除。

### `src/tools/`

`src/tools/index.ts` 的 `ALL_TOOLS` 是当前内置工具注册表。2026-07-16 实际导出：

```text
Shell, Read, Write, Edit, Grep, Glob, Subagent, Task, Wait,
WebSearch, AskUser, TodoWrite, WebFetch, SequentialThinking,
Orchestrate, Project, Work, AgentRegistry, Cron, Wiki, Flow, Platform
```

工具由 `tool-factory.ts` 统一包装 Hook、限速、审计和结果外置/截断。旧的 MemoryRead/MemoryWrite、TaskStart/TaskGet 等多工具入口和 Agent-as-Tool 均不是当前注册项。

### `src/server/`

- `index.ts`：构造 Store/Service、挂载 REST/WS、执行启动清理和恢复。
- `agent-service.ts`：主会话编排和运行时实例生命周期。
- `session-db.ts`、`*-store.ts`：SQLite 与领域持久化。
- `*-router.ts`：REST 接入面。
- `db-migration.ts`：兼容迁移和 schema 补齐。
- `compression-core.ts`、`archive-service.ts`、`recovery.ts`：压缩、归档和异常恢复。
- `wiki-node-store.ts`、`wiki-operations.ts`：Wiki 数据与磁盘镜像。

### `src/renderer/`

- `components/` 按功能域组织：dashboard、chat、agents、tools、mcp、skills、requirements、wiki、cron、settings 等。
- `store/` 既包含 Zustand store，也包含 `data-sync.ts`、`event-attribution.ts` 等同步辅助模块；不要用文件数量推断 store 数量。
- `App.tsx` 只挂载 `AppLayout`，页面切换由 `page-store.ts` 的内存状态控制，不使用 URL router。

## 新代码放置规则

- 新内置工具：`src/tools/<name>.ts`，并在 `src/tools/index.ts` 注册。
- 新运行时 Hook：`src/runtime/hooks/`，通过 `registerHooksForLoop()` 接线。
- 新持久化实体：优先使用 `src/server/<entity>-store.ts`，同步迁移、router 与服务构造。
- 新 REST 接口：`src/server/<entity>-router.ts`，在 `src/server/index.ts` 挂载；桌面端需要时再更新 `src/main/ipc-proxy.ts` 与 preload 契约。
- 新页面：`src/renderer/components/<domain>/`；共享 UI 放 `components/common/`。
- 跨 main/preload/renderer 的类型：放 `src/shared/`，避免 renderer 直接 import server/runtime。

## 维护规则

- 目录移动、入口改变或注册表改变时更新本文。
- 不把未来计划中的目录写成已经存在。
- 不依赖行号、总文件数或通道数描述稳定架构。
