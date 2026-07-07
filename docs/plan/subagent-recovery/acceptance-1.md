# acceptance-1:workbench 通道

对应 `sub-1.md`。

## 用例

1. **todos mid-turn 新鲜**:agent 在 step 2 调 TodoWrite 改列表 → step 3 的 LLM 输入里 workbench 显**最新**列表(不再等下个 turn)。原 stale bug 已修。
2. **每 step 注入**:每个 step 的 `stepMessages` 末尾追加一条 workbench user 消息(非持久,不入 `messages`)。
3. **不累积**:workbench 只在 `stepMessages`(per-step 副本),`messages`(持久对话)不含 workbench → 多 step 不堆叠。
4. **format-safe**:workbench 作为独立 user 消息追加(不 prepend 到 tool result),不破坏消息结构。
5. **空跳过**:无 todos 时 `renderWorkbench` 返 null → 不注入空块。
6. **context 块不含 todos**:todos 不再出现在 `<context>` 块,只在 workbench。

## 验证手段

- 单测(`tests/unit/workbench.test.ts`):renderWorkbench 空→null;有 todos→`<workbench>` 块含列表;mid-turn 覆盖反映最新。
- 手测:跑一个多 step turn,日志确认每 step stepMessages 末尾一条 workbench,`messages` 不含。
