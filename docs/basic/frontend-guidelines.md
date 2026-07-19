# 前端开发规范

## 当前结构

渲染层位于 `src/renderer/`，使用 React 19 和 Zustand。`App.tsx` 挂载 `AppLayout`，页面由 `page-store.ts` 的 `activePage` 切换，不使用 URL router。

当前导航页面：Dashboard、Chat、Agents、Cron、Tools、MCP、Skills、Requirements/Project、Wiki、Settings。

| 路径 | 职责 |
| --- | --- |
| `components/layout/` | 应用壳、侧栏、聊天/文件/Wiki/任务面板与可调布局 |
| `components/chat/` | 消息行、内容 block、AskUser、Todo、输入队列 |
| `components/<domain>/` | Agents、Tools、MCP、Skills、Requirements、Wiki 等领域 UI |
| `store/` | Zustand store、实时数据同步与事件归属辅助模块 |
| `styles/` | 全局样式和主题 |
| `types/` | renderer 本地类型；跨进程类型应优先放 `src/shared/` |

旧文档中的 `workspace/`、`agent-tool-store.ts` 和固定“10 个 store”不再是当前结构。

## 前后端边界

- renderer 只能通过 preload 暴露的 `window.api` 与主进程/后端通信。
- 禁止在 renderer 直接 import server、runtime、Node 文件系统或数据库实现。
- 新 API 先定义/更新共享契约，再接 preload、main proxy、server router 和对应测试。
- 对后端返回的非 2xx 错误按 rejected Promise 处理，不假设所有 invoke 都 resolve。

## 状态与副作用

- 跨组件、跨页面或需要从实时事件更新的状态使用 Zustand。
- 仅在单个组件内部使用的展示状态保留在 React state，不为每个字段创建全局 store。
- 网络/IPC 调用放在 store action、领域 service helper 或明确的布局协调层中。
- `store/` 中并非每个文件都是 Zustand store；`data-sync.ts`、`event-attribution.ts` 等是同步辅助模块。

## 实时事件

当前订阅分为两类：

1. `AppLayout` 处理主会话生命周期与核心 Agent 流式事件。
2. 领域 store/页面按需处理 `data:changed`、任务、Wiki、Dashboard 指标等事件。

因此不要继续沿用“所有事件只能在 AppLayout 订阅”的旧规则。新增订阅时必须：

- 在 effect 或初始化函数中保存 unsubscribe。
- 清理时解除监听，避免热重载或页面切换后重复消费。
- 使用 `sessionId`、`toolCallId`、实体 id 等稳定键做归属，不用工具名或当前页面猜测。
- 对可重复/乱序推送使用幂等更新或重新拉取策略。

## 聊天与工具调用

- `text_delta` 追加到对应 session 的 assistant 消息。
- `tool_start` / `tool_end` 必须用 `toolCallId` 配对；同名工具可能并行调用。
- 任务、输入队列和 delegated session 事件还要结合 session/parent 关系做归属。
- 大工具结果可能已经被外置为文件，UI 应展示摘要和引用，而不是假设结果总在内存字符串中。

## 组件规则

- 页面级目录按领域命名；跨领域复用组件放 `components/common/`。
- 大型表单按职责拆 Section，但不维持固定 Section 数量。
- 组件不复制共享 DTO；跨层契约放 `src/shared/`，renderer 特有 view model 放 `src/renderer/types/`。
- 删除、取消、归档等破坏性操作必须有明确确认和失败反馈；是否使用原生 dialog 取决于能力是否必须留在 main，不是一律使用 Electron dialog。
- 新页面需要同步更新 `page-store.ts`、`IconSidebar.tsx` 和 `AppLayout.tsx`。

## 验证

- 纯 store/归属逻辑优先增加 Vitest。
- IPC/preload 契约变化运行对应 unit tests 与 `npm run typecheck`。
- 涉及窗口、真实导航、拖拽或完整流式渲染时运行 Playwright E2E。
