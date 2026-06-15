# chat 目录说明书

## 核心功能

聊天交互增强组件：渲染 Agent 主动向用户提问的 AskUserCard，以及展示 Agent 任务清单（Todos）的 TodosList。

## 输入

- 聊天消息中的 AskUser / Todos 结构化内容（来自 chat-store 或消息 payload）
- 用户交互回调（选择、确认、勾选）

## 输出

- 嵌入聊天气泡内的提问卡片与任务清单 DOM

## 定位

渲染进程组件，被 `components/layout/ChatPanel` 及消息渲染流程消费，作为富内容渲染插件。

## 依赖

- react
- `../../../shared/types`（消息 / todo 相关类型）
- `../../components/common/MarkdownRenderer`（文本渲染）

## 维护规则

- AskUser / Todos 协议字段变化时同步渲染。
- 新的富消息类型应在此目录新增对应组件并由消息渲染分发。
