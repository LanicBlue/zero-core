# src/main/ipc/

## 核心功能
Electron 主进程的 IPC 层：把渲染层的 ipcRenderer.invoke 调用，按领域拆分为
多个 handler 文件，并集中注册到 ipcMain。提供类型安全注册工具与共享上下文。

## 输入
- IpcContext（聚合各 Store 与 service：sessionDb、agentStore、requirementStore、
  leadService、analystService、cronManager、gitIntegration、notificationService 等）
- 渲染层经 preload 传入的通道参数
- 模块就绪状态（module-readiness）

## 输出
- 注册到 ipcMain 的若干 handle 回调
- IpcContext 实例（core.ts 装配）
- 类型化注册函数 typedHandle / registerCrud（typed-ipc.ts）

## 定位
src/main/ipc/，被 ipc.ts（总注册入口）调用；除 dialog、webfetch:login 等
少数必须本地处理的通道外，大部分领域通道也经 ipc-proxy 代理到后端。
按领域分文件：config / agent / agent-tool / provider / session / message /
file / chat / template / github-template / mcp / kb / log / tool /
tool-execution / project / requirement / wiki。

## 依赖
- 外部：electron（ipcMain、BrowserWindow）
- 内部：../../shared（ipc-api 契约、types 数据模型）、../../server 各 Store 与
  service、../../core（tool-registry 等）、../../runtime（工具与 cookie 工具）

## 维护规则
- 新增领域通道必须新建独立 handler 文件，并在 ipc.ts 中注册
- 通过 typedHandle / registerCrud 注册，确保参数与结果类型与 shared/ipc-api 一致
- 新增 Store/service 必须在 types.ts 的 IpcContext 中追加字段，并由 core.ts 注入
- 写路径异常应收敛为 `{error}` 返回，不要让异常冒泡到渲染层
