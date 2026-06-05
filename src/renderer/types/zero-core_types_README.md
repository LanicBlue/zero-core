# types

## 核心功能
渲染进程专用 TypeScript 类型声明，补充全局类型定义。

## 输入
../preload 暴露的 API 签名

## 输出
global.d.ts 全局类型声明（window.api 类型扩展、模块声明等）

## 定位
src/renderer/types/ — 渲染进程类型层，确保 TypeScript 类型安全

## 依赖
../preload（类型需与 preload 暴露的 API 一致）；TypeScript 编译器

## 维护规则
- preload API 变更需同步更新此文件中的类型声明
- 新增全局类型需在此文件中添加
