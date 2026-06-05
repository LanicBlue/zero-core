# mcp-tools

## 核心功能
MCP 内置工具集，提供不依赖外部 MCP 服务器的内置工具实现，包括顺序思考、记忆管理、网页抓取和助手辅助工具。

## 输入
工具调用参数（URL、记忆内容、推理步骤等）

## 输出
工具执行结果（网页内容、记忆读写确认、推理链、助手响应）

## 定位
src/runtime/mcp-tools/ — 运行时内置 MCP 工具层，被 tool-factory 注册

## 依赖
../tools/tool-factory.ts（工具注册）；../core（配置、工具策略）；外部依赖：fetch、HTML 解析库

## 维护规则
- 新增内置 MCP 工具需在此目录创建并注册到 tool-factory
- 工具参数变更需同步更新 schema 定义
- fetch 工具的安全策略需与 core/tool-policy.ts 保持一致
