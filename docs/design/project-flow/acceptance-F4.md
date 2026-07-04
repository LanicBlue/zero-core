# acceptance-F4 — UI 接入 · 测试要求

> 节点 F4 验收。对应 [plan-F4.md](plan-F4.md)。

## 完成判定
用户操作(看板拖卡 / modal / REST)与 agent 工具调用走**同一** Flow action 后端;用户能驱动的迁移即使没暴露给 agent 也可经 UI 完成。

## 单元 / 集成测试
1. **公共后端单源**:Flow execute 与 REST transition/create 调同一个迁移函数(grep/结构断言无分叉)。
2. **REST → 后端**:requirement-router 的 transition 端点 → 公共后端 → 状态迁移 + 副作用 + 发 signal(spy 断言 signal 发出)。
3. **renderer → REST**:ChatPanel/KanbanBoard 的 transitionStatus 调用透传到更新后的 REST(行为测试或结构断言)。
4. **暴露面**:pick/ready/startBuild/verify 在 agent 工具集里默认不可见(CONDITIONAL/policy);但 UI 能调它们的后端。

## e2e / 手动
- 看板拖卡:需求从一列拖到另一列 → 状态迁移 + 副作用(建 doc / worktree)+ 发对应 signal → 订阅 work fire。
- 建 modal:建需求 → Flow.create;选中建议 → Flow.pick(+doc)。
- 手动出 Verify:用户点"通过"→ Flow.verify(通过)→ verified → 合并 work。

## 静态 / 门禁
- 三层 tsc + build:lib + vitest 全绿。
- diff 不越界(REST + renderer 调用点 + 公共后端;不动 ChatPanel 内联渲染)。

## 不在本阶段
- 删旧文件 / 注释 / code-graph(→ F5)。
