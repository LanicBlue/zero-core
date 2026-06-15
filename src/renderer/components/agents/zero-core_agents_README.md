# agents 目录说明书

## 核心功能

Agent 管理与编辑 UI：列表页（AgentsPage）、模板画廊/导入（TemplateGallery、TemplateCard、TemplateDetailModal、GithubImportModal）、以及 Agent 编辑器（AgentEditor 及 BasicSection / PromptSection / ToolsSection / PermissionsSection / ExposeAsToolSection 等分节）。

## 输入

- `agent-store` / `template-store` / `agent-tool-store`（Zustand）
- `../../../shared/types` 中的 Agent 相关类型
- `window.api` 的 agent / template / tool 接口

## 输出

- Agent 管理页面 DOM、模板选择 UI、Agent 编辑器表单与各配置分节

## 定位

渲染进程功能模块，被 AppLayout 路由到 agents 页面时加载；编辑器作为详情面板嵌入。

## 依赖

- react
- `../../store/agent-store`、`../../store/template-store`、`../../store/agent-tool-store`
- `./agent-editor-types`（编辑器内部类型）
- `../../components/common`（MarkdownRenderer、ConfirmModal 等）

## 维护规则

- Agent 配置字段（角色、工具、权限、提示词）变化时同步对应分节与 `agent-editor-types`。
- 新增编辑器分节遵循 `*Section.tsx` 命名并挂载到 AgentEditor。
- 模板来源（本地/Github）扩展时同步 TemplateGallery 与导入流程。
