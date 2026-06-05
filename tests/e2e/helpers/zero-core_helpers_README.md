# helpers

## 核心功能
E2E 测试辅助工具，封装 Electron 应用启动、窗口等待、IPC 调用等通用测试基础设施，减少测试代码重复。

## 输入
fixture JSON 文件路径、Electron 应用配置

## 输出
TestApp 对象（launchApp、waitForAppReady、selectTestAgent、sendChatMessage 等辅助函数）

## 定位
tests/e2e/helpers/ — E2E 测试辅助层，被所有 spec 文件引用

## 依赖
@playwright/test；electron；被所有 E2E 测试使用

## 维护规则
- 新增测试辅助方法需在此文件中添加
- 应用启动参数变更需同步更新 test-app.ts
- Mock Provider 配置变更需确保所有 spec 文件正常工作
