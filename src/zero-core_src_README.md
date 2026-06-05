# src

## 核心功能
项目源代码根目录，包含 zero-core 的全部业务逻辑，分为 core、main、preload、renderer、runtime、server 和 shared 七个一级模块。

## 输入
外部依赖（electron、express、ws 等）、用户配置

## 输出
库公共 API（index.ts）、CLI 入口（cli.ts）、HTTP 服务入口（serve.ts）

## 定位
src/ — 项目源代码根，所有业务逻辑的父目录

## 依赖
所有子目录（core、main、preload、renderer、runtime、server、shared）；外部依赖：electron、express、ws 等

## 维护规则
- 新增公共 API 需在 index.ts 中导出
- 新增子模块需保持与现有分层架构一致
- 入口文件变更需同步检查 package.json exports 和 bin 配置
