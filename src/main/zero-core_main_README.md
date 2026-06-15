# src/main/

## 核心功能
Electron 主进程层：窗口创建、后端子进程生命周期、IPC 桥接与本地化处理。
是渲染层（renderer）与后端服务（server）之间的协调者。

## 输入
- Electron app 生命周期事件（ready、window-all-closed、quit 等）
- 后端 stdout `ready` 行（端口与 pid）
- 渲染层经 preload 透传过来的 ipcRenderer.invoke 调用

## 输出
- 主窗口 BrowserWindow
- 后端子进程 BackendHandle（含 port）
- ipcMain.handle 注册的通道（大部分代理到后端 REST/WS，少数本地处理）
- 经 webContents.send 回推的事件流

## 定位
src/main/，Electron 主进程代码；编译进主进程 bundle。
- `index.ts`：主进程入口（thin shell，组装窗口+子进程+IPC）
- `backend-spawn.ts`：后端子进程的启动/监控/关闭
- `ipc-proxy.ts`：IPC → 后端 HTTP/WS 桥接
- `ipc.ts`：本地 IPC handler 总注册入口
- `test-setup.ts`：测试辅助 re-export
- `ipc/`：按领域拆分的 IPC handler 与类型化注册工具

## 依赖
- 外部：electron、ws
- 内部：../core（logger、constants、test-seed）、../shared（类型）、../runtime（cookie 工具）
- 间接：后端 server 实例（通过子进程 REST/WS）

## 维护规则
- 主进程保持 thin：业务逻辑放 server / core，main 只做协调与桥接
- 新增 IPC 通道优先在 `ipc/` 按领域新建 handler 文件并在 ipc.ts 注册
- 真正需要 Electron 能力的通道（dialog、登录窗 cookie）才放 main 本地处理，其余走 ipc-proxy 代理
- 后端子进程协议（stdout ready、stdin shutdown）变更需双向同步
