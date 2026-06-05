# agents

## 核心功能
Agent 管理页面组件，提供 Agent 的创建、编辑、模板浏览与导入、工具与权限配置等完整 UI。

## 输入
agent-store、template-store、agent-tool-store 中的状态数据

## 输出
Agent CRUD 操作的 IPC 调用、React UI 组件

## 定位
src/renderer/components/agents/ — 渲染进程 Agent 管理 UI 层

## 依赖
../../store/agent-store.ts；../../store/template-store.ts；../../store/agent-tool-store.ts；react

## 维护规则
- 新增 Agent 配置字段需同步更新 agent-editor-types.ts 和对应 Section 组件
- 模板导入流程变更需检查 GithubImportModal.tsx
- 编辑器分区变更需在 AgentEditor.tsx 中调整布局
