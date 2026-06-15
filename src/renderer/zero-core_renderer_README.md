# renderer 目录说明书

## 核心功能

Electron 渲染进程层，承载整个应用的 React UI、Zustand 状态层、全局样式、类型声明与工具方法，通过 `window.api`（preload 注入）与主进程交互。

## 输入

- `index.html` 加载的 `main.tsx`：渲染进程入口
- `window.api`：preload 暴露的 IPC 接口集合
- `src/shared/types`：与主进程共享的类型定义

## 输出

- 挂载到 `#root` 的 React 应用（AppLayout 主框架及其下属页面）
- 由 store 维护、各页面共享的全局状态

## 定位

仓库的渲染进程根目录，介于 preload（IPC 桥）与业务 UI 组件之间。`main.tsx` 初始化 React、主题与 Shiki 高亮后渲染 `App.tsx`；`App.tsx` 挂载 `components/layout/AppLayout`。

## 依赖

- 子目录：`components/`、`store/`、`styles/`、`types/`、`utils/`
- 外部：react、react-dom、zustand、shiki
- 跨进程：`src/shared`、`src/preload`

## 维护规则

- 新增全局初始化逻辑（主题、高亮、错误上报）应集中在 `main.tsx`。
- 新增顶级页面须在 `components/layout` 的路由/侧栏中注册。
- 与主进程交互必须走 `window.api`，不直接 require 主进程模块。
