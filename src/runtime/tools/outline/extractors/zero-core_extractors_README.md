# extractors

## 核心功能
多语言代码大纲提取器集合，为 30 种编程语言和标记语言提供结构化大纲提取能力，将源代码解析为层级化的符号定义（类、函数、变量等）。

## 输入
源代码文本（按语言选择对应提取器）

## 输出
OutlineNode 层级结构（类、函数、变量等符号定义）

## 定位
src/runtime/tools/outline/extractors/ — 大纲提取子模块，被 outline/index.ts 注册

## 依赖
../types.ts（大纲节点类型定义）；../renderer.ts（渲染输出）

## 维护规则
- 新增语言提取器需在此目录创建并注册到 outline/index.ts
- 提取器实现通常基于正则匹配，复杂语言可引入 AST 解析
- 提取结果需符合 OutlineNode 类型定义
