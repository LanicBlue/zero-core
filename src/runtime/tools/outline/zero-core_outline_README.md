# outline

## 核心功能
代码大纲提取模块，提供多语言源代码的结构化大纲生成能力，支持 BFS/DFS 展开策略、内容裁剪和渲染输出，用于 Agent 理解大型代码库的结构。

## 输入
源代码文件路径和内容、展开策略配置、token 预算

## 输出
层级化 OutlineNode 树、可读的大纲文本渲染

## 定位
src/runtime/tools/outline/ — Agent 运行时大纲提取子模块

## 依赖
./extractors/（各语言提取器）；../../tool-factory.ts（工具注册）

## 维护规则
- 新增语言支持需在 extractors/ 目录创建提取器并在 index.ts 中注册
- 展开策略变更需测试 BFS/DFS 两种模式的输出
- token 预算裁剪逻辑变更需验证大文件场景下的性能
