# types 目录说明书

## 核心功能

渲染进程本地的 TypeScript 类型声明与全局环境补充：`global.d.ts` 声明渲染进程专用的全局类型（如 `window.api` 形状、模块声明等）。

## 输入

- 无

## 输出

- 供渲染进程 TS 编译与 IDE 提示使用的类型声明

## 定位

渲染进程类型补充层；跨进程共享类型应放在 `src/shared/types`，本目录仅放渲染进程专属的全局声明。

## 依赖

- TypeScript（`tsconfig` 中包含本目录）
- 间接依赖 `src/preload`（`window.api` 来源）与 `src/shared`

## 维护规则

- 仅放渲染进程专用的全局/模块声明，业务领域类型放 `src/shared/types`。
- preload 暴露的接口形状变化时同步 `window.api` 的声明。
- 新增第三方无类型模块的声明集中放此目录。
