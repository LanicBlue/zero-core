# preload

## 核心功能
Electron 预加载脚本，作为主进程与渲染进程之间的安全桥梁，通过 contextBridge 暴露类型安全的 IPC API 给渲染进程。

## 输入
../shared/ipc-api.ts（IPC 通道名称和参数类型）

## 输出
window.api 对象，供渲染进程调用的类型安全 IPC 方法

## 定位
src/preload/ — Electron 安全沙箱桥接层，连接 main 和 renderer

## 依赖
electron（contextBridge、ipcRenderer）；../shared/ipc-api.ts；../shared/preload-types.ts

## 维护规则
- 新增 IPC 通道需在此文件中添加对应的暴露方法
- 暴露的方法签名必须与 preload-types.ts 中的类型定义一致
- 不得在此文件中编写业务逻辑，仅做桥接
