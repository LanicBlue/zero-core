# unit

## 核心功能
单元测试套件，基于 Vitest 对核心模块进行独立测试，覆盖 Agent 工具函数、默认提示词、Provider 工厂、会话指标和聊天状态管理等关键逻辑。

## 输入
被测模块（src/core、src/runtime、src/renderer/store）

## 输出
Vitest 测试用例（agent-utils、default-prompt、provider-factory、session-metrics、chat-store）

## 定位
tests/unit/ — 单元测试目录，独立验证各模块逻辑

## 依赖
vitest（测试框架）；src/core、src/runtime、src/renderer/store（被测模块）

## 维护规则
- 新增核心模块需创建对应的单元测试文件
- 测试文件命名遵循 <模块名>.test.ts 约定
- 运行命令：npm run test:unit（单次）/ npm run test:unit:watch（监听模式）
- Mock 外部依赖，不发起真实网络请求或文件系统操作
