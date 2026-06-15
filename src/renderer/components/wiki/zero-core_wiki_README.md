# wiki 目录说明书

## 核心功能

项目 Wiki 浏览器：WikiPage 左右分栏主页面（项目选择 + 树 + 详情）、WikiTree 递归渲染节点层级树（展开/收起/选中）、WikiDetail 展示选中节点摘要/详情并支持编辑与展开全文。

## 输入

- `../../store/wiki-store`（fetchWikiTree / selectedNodeId / selectNode / expandNode / updateNode / getNodesForProject）
- `../../store/project-store`、`../../store/page-store`
- `../../../shared/types`（ProjectWikiNode / UpdateWikiNodeInput / WikiNodeType）

## 输出

- 渲染的 Wiki 浏览页面、节点树、详情面板 DOM

## 定位

渲染进程功能模块，被 AppLayout 路由到 wiki 页面时加载。

## 依赖

- react
- `../../store/wiki-store`、`../../store/project-store`、`../../store/page-store`
- `../../../shared/types`

## 维护规则

- WikiNode 类型/字段（nodeType、parentId、summary、detail）变化时同步树与详情。
- 新增节点操作（如批量展开、搜索）需要在 WikiPage 编排并下沉到子组件。
