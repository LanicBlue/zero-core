# dashboard

## 核心功能
仪表盘页面组件，展示会话指标、使用统计和侧边栏导航。

## 输入
chat-store 中的会话指标数据、page-store 中的导航状态

## 输出
仪表盘 UI 页面（指标卡片、Token 使用量概览）

## 定位
src/renderer/components/dashboard/ — 渲染进程仪表盘 UI 层

## 依赖
../../store/chat-store.ts；../../store/page-store.ts；react

## 维护规则
- 新增指标卡片需在此页面中添加布局
- 数据来源变更需检查对应的 store
