# utils

## 核心功能
渲染进程工具函数，提供代码高亮初始化等通用能力。

## 输入
Shiki 库配置（语言列表、主题）

## 输出
初始化后的 Shiki 高亮器实例（供 common/CodeBlock.tsx 等组件使用）

## 定位
src/renderer/utils/ — 渲染进程工具函数层

## 依赖
shiki（代码高亮库）；供 common/CodeBlock.tsx 等组件使用

## 维护规则
- 新增高亮语言需在 shiki-init.ts 中注册
- Shiki 版本升级后需重新测试高亮效果
