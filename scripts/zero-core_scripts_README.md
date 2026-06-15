# scripts/

## 核心功能
仓库级的开发与运维脚本：开发环境热重载、构建辅助、检查工具与本地集成测试。
不进入运行时 bundle，仅服务于开发/CI 流程。

## 输入
- 命令行参数（如 itest-step-storage.cjs 可选 db-path）
- 项目源码与 dist 构建产物
- 仓库内配置（package.json、electron-vite / electron-builder 配置）

## 输出
- 开发服务器 / 热重载进程（dev.js）
- code-graph 文档与 handler 模块检查报告（build-codegraph.ts、
  check-handler-modules.ts）
- 工具输出验证（test-tool-output.ts）
- step 存储集成测试结果（itest-step-storage.cjs）
- 调试用 turns dump（check-turns.cjs）

## 定位
scripts/，仓库根下与 src 平级；通常由 package.json scripts 或开发者手动
`node scripts/xxx.{js,ts,cjs}` 调用。TS 脚本依赖 ts-node 或 dist，CJS 脚本
直接由系统 node 运行。

## 依赖
- 外部：electron-vite / electron-builder（dev.js）、better-sqlite3
  （check-turns.cjs、itest-step-storage.cjs）
- 内部：dist/server/* 与 src 配置（部分脚本要求先构建）

## 维护规则
- 一次性调试脚本（如 check-turns.cjs）应明确标注用途，避免被误接入 CI
- 集成测试脚本运行前需确认 dist 已构建
- 新增脚本注意运行时形态（CJS / ESM / TS）与项目其他入口保持一致
- 不在此目录实现产品功能，仅做开发辅助
