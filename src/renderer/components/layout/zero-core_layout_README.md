# layout 目录说明书

## 核心功能

应用主框架与可调整布局：AppLayout 顶层编排、ResizableLayout 可拖拽分栏、IconSidebar 图标侧栏导航、ChatPanel 主聊天面板、FileTreePanel 文件树、DocViewerPanel 文档查看，以及 TitleBar 自定义窗口标题栏。

## 输入

- `store/page-store`（当前激活页/选中需求/wiki 项目等导航状态）
- 各页面级 store（chat-store、project-store、requirement-store 等）
- `window.api` 的窗口控制与文件接口

## 输出

- 整体应用外壳 DOM（标题栏 + 侧栏 + 可调整内容区 + 文件树/文档面板）

## 定位

渲染进程布局层，位于 `App.tsx` 与各功能页面之间，是路由分发的中心。

## 依赖

- react
- `../../store/page-store` 等多个 store
- `../common`（通用组件）
- 各功能页面组件（agents / chat / requirements / wiki / kb / mcp / skills / settings / dashboard / tools）

## 维护规则

- 新增顶级页面须在 AppLayout / IconSidebar 注册路由与入口。
- 布局结构（分栏宽度、面板显隐）调整集中在 ResizableLayout。
- 窗口装饰/平台差异通过 TitleBar 处理。
