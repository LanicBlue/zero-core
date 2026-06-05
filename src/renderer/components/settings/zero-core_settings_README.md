# settings

## 核心功能
应用设置页面组件，涵盖 Provider 管理、设备上下文、自定义准则、工作区、主题、搜索、代理等全量配置项的 UI。

## 输入
provider-store、theme-store 等配置状态

## 输出
全量设置 UI 页面（Provider 编辑、主题切换、工作区配置等）

## 定位
src/renderer/components/settings/ — 渲染进程设置 UI 层

## 依赖
../../store/provider-store.ts；../../store/theme-store.ts；react

## 维护规则
- 新增设置项需创建对应 Section 组件并在 SettingsPage.tsx 中注册
- Provider 配置字段变更需同步更新 ProviderEditor.tsx 和 core/config.ts
