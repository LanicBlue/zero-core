# sub-9:内容量 UI

## 范围
chat UI 展示 session 内容量确认:最近 max(100 step, 5 turn)的内容,数据源 `steps` 表。

## 依赖
sub-1(steps 表)。

## 改动点
- `src/renderer/components/layout/ChatPanel.tsx`(及相关):新增/扩展内容量展示,显示最近 max(100 step, 5 turn)的内容(取多的:100 step 和 5 turn 谁覆盖更多取谁)。
- 数据源:`steps` 表(经 IPC/sessionsGetInit 或新 endpoint)。
- 放哪(design 待定:扩展现有 context-usage 条 vs 独立面板)—— 实现时定,倾向独立展开面板(default 安静)。
- sessions.token_usage 也可顺带展示(上下文体积)。

## 关键不变量
- 数据源是 `steps`(原始不可变),不是 messages(LLM 视图)—— 用户看真实历史。

## 参考
design.md 待决策 #5。
