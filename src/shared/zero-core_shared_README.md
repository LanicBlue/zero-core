# shared

## 核心功能
主进程与渲染进程之间的共享模块，定义 IPC API 接口、共享类型、文件工具函数和 GitHub 模板工具，确保两端使用一致的数据结构。

## 输入
业务需求中的跨进程数据结构定义

## 输出
共享类型定义（types.ts）、IPC 通道定义（ipc-api.ts）、预加载类型（preload-types.ts）、文件工具（file-utils.ts）、模板工具（github-template-utils.ts）

## 定位
src/shared/ — 主进程与渲染进程的共享契约层，被所有其他模块依赖

## 依赖
被所有其他模块（main、preload、renderer、server、runtime）依赖；无内部依赖

## 维护规则
- 类型变更需检查所有引用模块的兼容性
- 新增 IPC 通道需在 ipc-api.ts 中定义
- 新增共享数据结构需在 types.ts 中定义
- 此目录不得引入主进程或渲染进程专属的依赖
