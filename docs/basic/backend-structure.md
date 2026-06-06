# 后端架构设计

## 服务边界

| 模块 | 文件 | 职责 |
|------|------|------|
| 主进程入口 | `src/main/index.ts` | Electron 生命周期、窗口管理 |
| Agent 服务 | `src/server/agent-service.ts` | Agent 会话创建、消息调度、事件转发 |
| Agent 循环 | `src/runtime/agent-loop.ts` | 核心执行引擎，管理消息流、工具调用、重试、状态转换 |
| 会话管理 | `src/runtime/session.ts` | 消息历史、token 计数、上下文裁剪 |
| 子任务委派 | `src/runtime/subagent-delegator.ts` | 前台/后台子任务、任务注册表 |
| 检查点 | `src/runtime/checkpoint-manager.ts` | 对话检查点持久化和中断恢复 |
| 限速器 | `src/runtime/tool-rate-limiter.ts` | per-tool FIFO 队列 + 时间间隔门控 |
| 工具工厂 | `src/runtime/tools/tool-factory.ts` | 工具注册、元数据、execute 包装（hook + 限速 + 截断） |
| 工具注册中心 | `src/core/tool-registry.ts` | 工具元数据、配置 schema、运行时描述 |
| MCP 管理 | `src/server/mcp-manager.ts` | MCP 服务器生命周期和工具调用 |
| Hook 系统 | `src/core/hook-registry.ts` | 单例注册表，27 个生命周期事件 |
| 模板管理 | `src/server/template-store.ts` | 12 个内置模板 + 用户模板，自动合并更新 |

## 工具执行管线

```
tool-call 事件
  → PreToolUse hook（可阻断）
  → ToolRateLimiter.acquire()（FIFO 排队）
  → 实际 execute()
  → ToolRateLimiter.release()
  → PostToolUse / PostToolUseFailure hook
  → 结果截断（truncateResult）
```

## 工具策略层级

1. `toolPolicy.tools` map（UI 开关状态，精确控制每个工具）
2. `toolPolicy.autoApprove`（template 默认值，兜底）
3. `DEFAULT_ENABLED`（Bash, Read, Write, Edit, Grep, Glob）

运行时优先级：`tools` map > `autoApprove` > `DEFAULT_ENABLED`。`tools` map 通过 `agent-service.ts` 传入 `SessionConfig.toolPolicy`。

## IPC 接入面

通过 `typed-ipc.ts` 的 `registerCrud` 统一注册 CRUD 通道，支持 `afterDelete` 回调。

**通道列表**：agents、agent-tools、providers、templates、chat、sessions、tools、tool-config、webfetch、config、mcp、kb、messages、log、dialog、files、github-templates

## 数据存储

| 存储类 | 数据 |
|--------|------|
| `SessionDB` | 会话、消息、turn_state、tool_executions、KV store |
| `AgentStore` | Agent 配置（模型、prompt、toolPolicy） |
| `AgentToolStore` | Agent-as-Tool 映射，含级联删除和孤儿清理 |
| `ProviderStore` | AI Provider 配置和模型列表 |
| `TemplateStore` | 12 内置 + 用户模板，自动合并 |
| `McpStore` | MCP 服务器配置 |
| `KbStore` | 知识库元数据 |
| `SqliteStore` | 基础 CRUD store（所有 store 的父类） |

## 维护规则

- 每次服务边界、IPC 契约、数据流或存储变化后，必须检查并更新本文件
