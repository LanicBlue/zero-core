# runtime

## 核心功能
Agent 运行时核心层，管理 Agent 的完整生命周期——会话创建、Provider 调用、消息循环、工具调度、子 Agent 委派、检查点、并发控制和回话录制。是 zero-core 的执行引擎。

## 输入
用户消息、Agent 配置、Provider 配置、工具注册表

## 输出
流式事件（StreamEvent）、工具执行结果、子 Agent 委派结果、会话指标

## 定位
src/runtime/ — Agent 运行时核心层，连接 core 基础设施与 tools/mcp-tools 执行层

## 依赖
../core（配置、系统提示词、工具策略、Hook）；./tools（工具执行）；./mcp-tools（MCP 内置工具）；外部依赖：AI SDK（@ai-sdk/*）、各种 LLM Provider SDK

## 维护规则
- Agent 循环逻辑变更需充分测试流式响应和工具调用场景
- 新增 Provider 需在 provider-factory.ts 中注册
- 会话状态结构变更需检查 checkpoint-manager.ts 的序列化逻辑
- 并发控制策略变更需评估对 Provider 限流的影响
