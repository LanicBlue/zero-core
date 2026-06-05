# chat

## 核心功能
聊天交互相关 UI 组件，处理用户与 Agent 的对话展示，包括用户确认请求和任务列表的渲染。

## 输入
chat-store 中的消息列表和交互状态

## 输出
聊天消息气泡、用户确认卡片、任务列表的 React UI 组件

## 定位
src/renderer/components/chat/ — 渲染进程聊天 UI 层

## 依赖
../../store/chat-store.ts；react

## 维护规则
- 新增消息类型需在此目录添加对应渲染组件
- AskUserCard 的交互方式变更需同步检查 runtime/tools/ask-user.ts
