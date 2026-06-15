# src/

## 核心功能
zero-core 源代码根目录，承载整套可定制 Agent 运行时：Electron 桌面外壳、
Node.js 后端服务、Agent 运行时与渲染层 UI。

## 输入
- 命令行 / Electron app 启动事件
- 用户配置（providers、agents、tools、MCP、知识库等）
- 用户工作区目录与文件

## 输出
- 可运行的 Electron 桌面应用（dev/build 产物）
- 可独立启动的 HTTP/WebSocket 后端（dist/backend.js）
- 通过包入口对外暴露的 zero-core 公共 API（index.ts）

## 定位
仓库源码顶层；编译为 dist/，最终打包成 Electron 桌面应用或独立 server。
下含子模块：
- `backend.ts`：后端子进程入口
- `index.ts` / `cli.ts` / `serve.ts`：包入口与 CLI/serve 入口
- `core/`：核心配置、提示词、工具/钩子注册
- `main/`：Electron 主进程（窗口、子进程、IPC）
- `preload/`：Electron 预加载脚本（contextBridge）
- `renderer/`：渲染层（UI 与状态）
- `server/`：后端服务（Express、Store、AgentService 等）
- `shared/`：主进程/渲染进程共享的类型与契约
- `runtime/`：Agent 循环、工具与终端适配

## 依赖
- 运行时：Electron、Node.js、Express、ws、better-sqlite3
- 包入口对外暴露的 API 子模块（core/runtime/server 等）

## 维护规则
- 新增顶层子目录前先评估应归入 core / server / runtime 哪一层
- 入口文件（index/cli/serve/backend）改动需同步 electron-vite 与 electron-builder 配置
- 跨层共享类型一律放 `shared/`，禁止 main / renderer / server 互相反向依赖
