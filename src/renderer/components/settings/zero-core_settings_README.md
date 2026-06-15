# settings 目录说明书

## 核心功能

应用设置 UI 集合：SettingsPage 分页容器；ProviderCard / ProviderEditor 管理 LLM Provider 与模型；MemorySettings 配置会话压缩与记忆；WorkspaceSettings 工作区；ProxySettings 代理；ThemeSettings 主题；DeviceContextSettings 设备上下文；GuidelinesSettings 指南/约束。

## 输入

- `../../store/provider-store`、`../../store/theme-store` 等 store
- `window.api` 的各类 config 读写接口（provider / memory / proxy / theme / workspace 等）

## 输出

- 渲染的设置面板 DOM（分页 + 各配置表单）

## 定位

渲染进程功能模块，被 AppLayout 路由到 settings 页面时加载。

## 依赖

- react
- `../../store/provider-store`、`../../store/theme-store`
- `window.api`（各配置 IPC）
- `../common`（通用组件）

## 维护规则

- 新增设置项时优先在对应 *Settings 子组件实现，并在 SettingsPage 注册分页。
- 配置 IPC 接口签名变化时同步对应表单提交逻辑。
- 主题相关变量集中在 styles/themes，本目录只读取/切换。
