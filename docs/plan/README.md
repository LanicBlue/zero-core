# docs/plan — 待实施或实施中的计划

本目录保存已经细化为实施步骤与验收条件、但尚不能作为当前事实的 effort。

当前计划：

- [`wiki-system-redesign/`](wiki-system-redesign/README.md)：独立 re-review 已通过，正在
  实施；目录中的目标状态只有完成 acceptance 后才是当前事实。
- [`agent-eval-harness/`](agent-eval-harness/README.md)：Flow dependency /
  composition / Work / Context / VFS 与内置 Eval Skill 的执行计划；当前实施安排在
  `wiki-system-redesign` 最终验收通过并合并后开始，该顺序尚不属于 zero-core 控制。
- [`local-backend-security-boundary/`](local-backend-security-boundary/README.md)：
  loopback、HTTP/WS 认证、IPC sender、backend generation 与 self-update 安全边界计划；
  已经用户确认进入 Ready，实施等待 Wiki 合并后 reconciliation。

## 执行约定

- 每个阶段同时提供 plan 与可判定 acceptance。
- 开始前记录 typecheck/unit baseline，按依赖顺序执行。
- 不通过验收时回到当前阶段修改，不把失败留给下一阶段。
- 合并需要用户同意；合并后整个 effort 移入 [`../archive/`](../archive/README.md)。
- 任何文档移动后运行 `npm run check:links`，并额外检查目录、源码和 anchor 链接。

完整生命周期见 [`../issues/README.md`](../issues/README.md)。当前实现见 [`../arch/README.md`](../arch/README.md)。
