# tools

## 核心功能
Agent 工具实现层，提供文件读写编辑、Bash 执行、代码搜索、Web 搜索、任务管理、用户交互、子 Agent 调用、MCP 工具桥接等所有 Agent 可调用的工具。

## 输入
工具调用参数（文件路径、命令、搜索查询等）、工具执行上下文

## 输出
工具执行结果（文件内容、命令输出、搜索结果、MCP 响应）

## 定位
src/runtime/tools/ — Agent 运行时工具执行层，被 agent-loop 调度

## 依赖
../core（工具策略、配置、日志）；../agent-loop.ts（工具执行上下文）；./outline（大纲提取子模块）；外部依赖：@anthropic-ai/sdk、ripgrep 等

## 维护规则
- 新增工具需在 index.ts 中注册并在 tool-factory.ts 中创建实例
- 工具 schema 变更需确保向后兼容
- 安全相关工具（bash、file-write）需与 core/tool-policy.ts 策略同步
