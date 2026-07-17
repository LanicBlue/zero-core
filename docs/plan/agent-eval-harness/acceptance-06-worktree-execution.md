# Acceptance 06：Project 内部 Worktree 执行

对应 [Plan 06](plan-06-worktree-execution.md)。

## A. 路径与身份

- [ ] 新 linked worktree 只位于 `.zero-core/worktrees/<opaque-id>`。
- [ ] Project root 始终是注册根，workspaceRoot 才随 policy 变化。
- [ ] worktree `.git` 指向正确 outer repo，inner Git 不跟踪它。

## B. 失败语义

- [ ] non-Git、Git missing、branch collision、create failure 不 dispatch Agent。
- [ ] 所有 create failure 均无 main/project workspace fallback。
- [ ] retry 使用同一 WorkRun snapshot，避免产生无主 worktree。
- [ ] cleanup/merge conflict 可恢复且不删除 Flow 文档。

## C. 生命周期

- [ ] retain/cleanup/merge policy 来自 Work snapshot。
- [ ] Work success 不自动猜测 merge。
- [ ] restart 能关联已有 worktree；orphan 有可审计 reconcile。
- [ ] 旧 locator 不被启动迁移，新 run 不再创建旧路径。

## D. 安全删除

- [ ] 删除前验证绝对根、repo identity 和 worktree registration。
- [ ] 不使用跨 shell 拼接的递归删除。
- [ ] 相邻目录、其他 Project worktree 和 `.zero-core/.git` 不受影响。

## E. 验证与证据

运行 typecheck、build:lib、unit、Git integration tests、check:links。`result-06.md` 包含三种
workspace policy、failure matrix、merge conflict、restart/orphan 和 no-fallback 证据。

## F. 拒绝条件

- worktree 失败后让 Agent 在 Project root 继续。
- 把 worktreeRoot 注册成新 Project 或递归创建 `.zero-core`。
- 直接递归删除未验证的计算路径。
