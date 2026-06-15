# kb 目录说明书

## 核心功能

知识库与记忆浏览页面（KnowledgeBasePage）：Libraries Tab 提供 RAG 知识库的创建/删除/文件导入；Memory Tab 提供记忆节点（Memory Node）的浏览、按 subject 分组展开、关键词搜索与删除。

## 输入

- `../../store/kb-store`（knowledgeBases / loading / create / remove / addFiles / removeFile）
- `window.api.memoryNode*`（subjects / list / subjectNodes / search / delete）

## 输出

- 渲染的知识库与记忆管理页面 DOM

## 定位

渲染进程功能模块，被 AppLayout 路由到 kb 页面时加载。

## 依赖

- react
- `../../store/kb-store`
- `../../../shared/types`（KnowledgeBase / KbFileInfo）
- `window.api`（记忆节点接口）

## 维护规则

- 知识库或记忆节点字段变化时同步本页展示与表单。
- 新增嵌入提供商/模型选项时需要扩展创建表单。
