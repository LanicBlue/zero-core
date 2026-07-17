# docs/plan — 待实施或实施中的计划

本目录保存已经细化为实施步骤与验收条件、但尚不能作为当前事实的 effort。

当前计划：[`wiki-system-redesign/`](wiki-system-redesign/README.md)。它的独立 re-review 已通过，但目录中的 `db/core.db`、`db/wiki.db`、新授权模型和新 UI 都仍是目标状态；只有对应代码落地并完成 acceptance 后，才能更新当前架构文档。

## 执行约定

- 每个阶段同时提供 plan 与可判定 acceptance。
- 开始前记录 typecheck/unit baseline，按依赖顺序执行。
- 不通过验收时回到当前阶段修改，不把失败留给下一阶段。
- 合并需要用户同意；合并后整个 effort 移入 [`../archive/`](../archive/README.md)。
- 任何文档移动后运行 `npm run check:links`，并额外检查目录、源码和 anchor 链接。

完整生命周期见 [`../issues/README.md`](../issues/README.md)。当前实现见 [`../arch/README.md`](../arch/README.md)。
