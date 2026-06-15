# dashboard 目录说明书

## 核心功能

应用首页/Dashboard 页面（DashboardPage），提供入口概览与快捷导航。

## 输入

- `window.api` 暴露的概览数据接口
- 导航状态（`store/page-store`）

## 输出

- 渲染的首页 DOM（卡片/入口/概览）

## 定位

渲染进程组件，被 AppLayout 作为默认或入口页加载。

## 依赖

- react
- `../../store/page-store`
- `window.api`（概览数据，如有）
- `../common`（通用组件）

## 维护规则

- 首页入口或概览指标变化时同步本页。
- 新增首页模块拆分为子组件，避免 DashboardPage 单文件膨胀。
