# layout

## 核心功能
应用布局框架组件，定义整体页面结构，包括侧边栏导航、聊天面板、文档查看器和文件树等可调整大小的面板布局。

## 输入
page-store 导航状态、chat-store 聊天数据

## 输出
应用整体布局 UI（侧边栏、聊天面板、文档查看器、文件树）

## 定位
src/renderer/components/layout/ — 渲染进程布局框架层，定义全局页面结构

## 依赖
../../store/page-store.ts；../../store/chat-store.ts；react

## 维护规则
- 布局结构变更需在 AppLayout.tsx 中调整
- 新增面板需在 ResizableLayout.tsx 中注册
- 侧边栏图标变更需在 IconSidebar.tsx 中更新
