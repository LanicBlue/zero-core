# common 目录说明书

## 核心功能

跨页面复用的通用 UI 组件：日志查看器（LogViewer）、确认弹窗（ConfirmModal）、Markdown 渲染器（MarkdownRenderer，含代码高亮 CodeBlock）与全局通知 Toast（NotificationToast）。

## 输入

- 各业务组件传入的 props（文本、Markdown、确认文案、日志条目、通知对象）
- 全局通知来自 `store/notification-store`

## 输出

- 标准化的可复用 DOM 组件

## 定位

渲染进程基础组件层，被几乎所有业务页面与 layout 组件引用，无业务耦合。

## 依赖

- react
- `../../../shared/types`（通知等类型）
- `../../store/notification-store`
- shiki（代码高亮，经 `../../utils/shiki-init`）

## 维护规则

- 组件须保持无业务耦合，仅由 props 驱动。
- 新增全局级 UI（Toast / Modal 类）优先放到本目录。
- Markdown / 代码块渲染策略调整需同步 CodeBlock 与 shiki-init。
