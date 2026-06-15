# src/core/

## 核心功能
zero-core 的核心可复用层：与具体进程无关的配置、提示词、上下文、工具与钩子
基础设施。被 server、main、runtime、cli 等所有上层共享，是项目的“领域内核”。

## 输入
- 用户/工作区配置（ZeroCoreConfig）
- Agent 上下文：会话、设备、项目上下文、知识库检索结果
- LLM Provider 抽象与 model 注册表
- 工具调用 / Hook 事件

## 输出
- 系统提示词（system-prompt / default-prompt / persona）
- 配置加载与校验（config.ts、constants.ts）
- 上下文管理、压缩与裁剪（context-manager / compaction）
- 工具/钩子注册表（tool-registry、hook-registry、custom-tools、tool-policy）
- 共享日志与 KV 接口（logger / file-log-sink / kv-store-interface）
- 测试夹具（test-seed.ts）

## 定位
src/core/，zero-core 源码的中间层；不直接依赖 Electron、Express、ws 等
进程级框架，仅暴露纯逻辑与类型。上层（server/runtime/main/cli）按需引用。

## 依赖
- 外部：zod 等校验库（按需）
- 内部：仅依赖同级文件与 ../shared，不反向依赖 server/runtime/main

## 维护规则
- 任何进程级（Electron/Express/fs 副作用）逻辑禁止放入本目录，应上移到 server/main/runtime
- 新增钩子类型必须同时更新 hook-types.ts 与 hook-registry.ts
- 配置 schema 变更需同步 DEFAULT_CONFIG、constants 与文档
- 测试种子（test-seed）改动需与 server 的 migration/Store 列保持一致
