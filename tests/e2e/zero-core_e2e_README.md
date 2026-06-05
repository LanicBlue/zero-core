# e2e

## 核心功能
端到端（E2E）测试套件，基于 Playwright + Electron 驱动真实应用进行集成测试，验证聊天、会话切换、多轮对话、错误处理和会话删除等核心用户流程。

## 输入
mock fixture 文件（JSON 格式的 LLM 响应）、ZERO_CORE_TEST_FIXTURE 环境变量

## 输出
Playwright 测试用例（chat、session-switch、multi-turn、error-handling、session-delete）

## 定位
tests/e2e/ — E2E 测试目录，驱动真实 Electron 应用进行集成验证

## 依赖
@playwright/test（测试框架）；electron（Electron 应用驱动）；./helpers/test-app.ts（测试辅助工具）

## 维护规则
- 新增核心用户流程需创建对应的 spec 文件
- 测试需在 mock provider 模式下运行，不依赖真实 LLM API
- 测试文件命名遵循 <功能>.spec.ts 约定
- 测试变更需确保通过 npm run test:e2e 执行
