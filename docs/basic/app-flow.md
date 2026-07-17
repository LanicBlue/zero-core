# 应用流程

## 桌面启动

```text
Electron app ready
  → spawn/fork dist/backend.js --port=0
  → backend 创建 DB、迁移、Store、Service、路由与 WebSocket
  → backend 执行残留清理与恢复扫描
  → stdout 回报 ready + port
  → main 创建窗口
  → main 注册 IPC→HTTP 代理
  → main 连接 backend WebSocket 事件桥
  → renderer 通过 app:ready / 事件加载数据
```

开发模式后端使用系统 Node；打包模式后端使用 Electron fork。后端未在 30 秒内就绪时，主进程会把启动视为失败。

## 发送消息

```text
用户输入
  → ChatPanel / chat store
  → window.api chat invoke
  → main ipc-proxy
  → backend chat router
  → AgentService 创建或取得运行时实例
  → AgentLoop 执行模型 step
  → WebSocket 实时事件返回 renderer
```

AgentService 在启动 loop 前组装：

- Agent/Provider/模型配置。
- system prompt、设备上下文、Skill、Wiki/项目工作上下文。
- tool policy 与当前启用的内置/MCP 工具。
- main loop 专用 Hook、输入队列、指标与持久化依赖。

## 单个模型 step

```text
StepStart / PreLLMCall hooks
  → AI SDK streamText
  → text/thinking/tool-call 流事件
  → 工具执行与 tool-result
  → StepEnd / 压缩触发判断
  → 继续下一 step 或结束 turn
```

工具由 `src/tools/tool-factory.ts` 统一包装。典型顺序是 PreToolUse → 限速/执行 → PostToolUse 或 PostToolUseFailure → 审计/结果处理。实际 Hook 名和顺序以 `tool-factory.ts` 与 HookRegistry 测试为准。

## 工具与任务

- `Subagent` 创建或继续委派 Agent 工作。
- `Task` 用 action 统一查询、列出、终止、收尾和恢复任务；旧 TaskStart/TaskGet/TaskList 等独立工具已经合并。
- 后台 Shell 和 delegated Agent 都进入运行时 task/workbench 视图。
- 当仍有后台任务时，force-wait Hook 可提示模型等待，而不是过早结束。
- 终态 delegated task 在消费/归档过程中可能被删除其活动记录；文档不应假设终态行永久保留。

## 输入队列

主会话执行期间的新用户输入可以进入 input queue。对应 Hook 在 main loop 的准备阶段注入；delegated loop 不注册主会话输入队列 Hook。Renderer 通过数据变更事件同步队列状态。

## 压缩与归档

- 压缩实现位于 `src/server/compression-core.ts`。
- `compression-trigger-hooks.ts` 在 StepEnd、PreLLMCall 或错误恢复场景决定是否触发。
- 旧的 L1/L2 `compression-engine.ts`、`compression-hooks.ts` 和 `extraction-hooks.ts` 已从当前源码删除。
- 归档由 `archive-service.ts` 处理，并有中断恢复与孤儿 session 清理。

压缩、记忆和归档是不同生命周期，不应在文档中合并成一个 `PostTurnComplete → extraction` 流程。

## 异常恢复

后端启动时会处理多类残留状态：

- delegated task 的 running/finishing 残留。
- 中断的归档操作和孤儿 delegated session。
- 未完成 session/step 的恢复候选。
- 工作流 requirement、cron 等领域状态。
- 无数据库归属的旧工作目录或 session 数据。

`recovery.ts` 的扫描结果由 AgentService 和领域 Service 决定如何恢复；不是每条残留记录都能自动继续，部分状态会转成需要人工处理的失败/中断状态。

## Renderer 事件归属

核心 Agent 事件包括 `text_delta`、`thinking_delta`、`tool_start`、`tool_end`、交互请求和 `agent_end`。事件必须按 session、agent 和 toolCallId 归属。

除 Agent 事件外，后端还会推送 `data:changed` 和 app ready 等事件。AppLayout、Zustand store 和领域页面分别消费它们；不存在“所有事件只允许在一个组件监听”的当前约束。`session:lifecycle`、`tools:changed` 等通道目前能找到订阅端但没有生产端，不能当作已接通能力。

## 状态边界

- Session/step/tool execution 是运行时与审计状态。
- delegated task 与 workbench 是任务控制状态。
- Project/Requirement/Work/Flow 是工作流领域状态。
- Wiki 是当前知识/记忆主线之一；旧 MemoryRead/MemoryWrite 工具不再注册。
- `docs/plan/` 中的未来 Wiki schema 不等于当前 `wiki-node-store.ts` 行为。
