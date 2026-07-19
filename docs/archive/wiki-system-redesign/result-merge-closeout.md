# Wiki System Redesign：合并收尾

> 日期：2026-07-19
> 合并基线：`a58102d`
> 目标分支：本地 `master`
> 结论：合并收尾 PASS；Wiki 后续人工计划门禁已解除。

## 1. 合并

`master` 已以 fast-forward 纳入 `worktree-wiki-redesign` 的最终验收基线 `a58102d`。
原实施目录整体从 `docs/plan/wiki-system-redesign/` 移入
`docs/archive/wiki-system-redesign/`；原 `result-final.md` 保留验收当时“尚未合并”的历史
叙事，本文件记录之后发生的合并与收尾，不改写原始证据。

## 2. 合并后修正

本次没有实施下一个 effort 的产品功能，只修正合并后基线：

- 9 个已知非 Wiki E2E 失败改为验证当前公开契约：模型 capability 由不可变 seed model
  表达，Memory UI 按自动压缩策略断言，模型元数据使用共享分隔符，Project modal 使用
  scoped selector 和真实临时 workspace；
- Wiki 单元测试的 benchmark / caller inventory 路径随 effort 归档而更新；删除对已退役
  `WikiAnchorsSection` 的旧稳定引用断言，保留 cutover guard；source self-check 兼容 CRLF；
- 移除 unit test 中最后一个机器专属的绝对工作区路径；
- 当前架构、基础文档、源码注释和后续 plan 的链接/时态统一到已合并事实。

## 3. 验证

验证使用项目要求的 Node `v24.14.0` 临时运行时；没有修改机器全局 Node 安装。

- `npm run build`：PASS（含三套 TypeScript typecheck 与 Electron/Vite build）；
- `npm run build:lib`：PASS；
- `npm run test:unit`：175 files、3098 tests PASS；
- 合并后修正的 5 个 Wiki/unit suite：125 tests PASS；最终绝对路径修正 suite：14 tests PASS；
- `npm run test:e2e`：101 passed、1 env-gated skipped，退出码 0，15.5m；
- `npm run check:links`：全部相对链接有效；
- `git diff --check`：PASS。

## 4. 未顺带实施的工作

`SessionDB.initSchema()` 无条件删除 `messages` 表的问题在合并后仍存在。本次只完成重核，
并把原 issue 作为被替代记录归档到
[`session-summary-restart-integrity`](../session-summary-restart-integrity/issue.md)；实际修复和
reopen 验收归属 `memory-compaction-runtime` Plan 00 / 05。

当前可以从 Plan 00 开始的 effort 是 Backend I/O Scheduling、Session / Turn Lifecycle、
Local Backend Security Boundary 和 Project Flow System。Memory Compaction Runtime 仍等待
Session Lifecycle Final；Project Management UI 仍等待 Project Flow Final。