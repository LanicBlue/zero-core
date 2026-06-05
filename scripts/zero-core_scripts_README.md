# scripts

## 核心功能
存放项目构建、开发、测试相关的辅助脚本，用于开发环境启动、模块检查和代码图生成。

## 输入
项目配置（package.json、electron.vite.config.ts）、源代码目录

## 输出
开发服务器（dev.js）、模块检查报告、code-graph.html

## 定位
scripts/ — 项目级辅助工具目录，不被应用运行时引用

## 依赖
electron-vite（dev.js）；项目内部 src/ 模块（check-handler-modules、build-codegraph）

## 维护规则
- 脚本变更需确保在 npm run 对应命令下正常执行
- 新增脚本需在 package.json scripts 中添加入口
- build-codegraph 变更后需重新生成 code-graph.html
