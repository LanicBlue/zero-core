# utils 目录说明书

## 核心功能

渲染进程通用工具方法。当前包含 `shiki-init.ts`：懒加载并配置 Shiki 语法高亮，供 Markdown/代码块渲染复用。

## 输入

- 第三方库（shiki）及其语言/主题资源

## 输出

- 初始化后的高亮器实例与 `initShiki` 等工具函数

## 定位

渲染进程工具层，被 `main.tsx` 与 `components/common/CodeBlock` 等消费。

## 依赖

- shiki
- 被 `src/renderer/main.tsx`、`src/renderer/components/common/*` 引用

## 维护规则

- 仅放无业务耦合的纯工具函数。
- 高亮语言/主题新增需要同步 shiki-init 的加载清单，避免运行时缺失。
- 涉及异步初始化的工具须处理失败兜底。
