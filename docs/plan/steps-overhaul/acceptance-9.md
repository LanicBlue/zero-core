# acceptance-9:内容量 UI

## 验收清单
- [ ] UI 展示最近 max(100 step, 5 turn)的内容(取多的)。
- [ ] 数据源 `steps` 表(原始不可变),不是 messages。
- [ ] 默认安静(独立面板/折叠,不挤主条)—— 实现时定具体形态。
- [ ] sessions.token_usage 顺带可展示(上下文体积)。
- [ ] 三层 tsc + vitest。

## 怎么验
构造 >100 step 或 >5 turn 的 session,验证 UI 显示的内容量/范围正确;数据来自 steps。
