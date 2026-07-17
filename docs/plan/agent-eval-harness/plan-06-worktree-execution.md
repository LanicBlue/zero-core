# Plan 06：Project 内部 Worktree 执行

## 目标

让 WorkDefinition 的 project/worktree/agent workspace policy 真正驱动
TurnInvocationContext；linked worktree 固定放在 Project `.zero-core/worktrees`，创建
失败绝不回退主目录。

## 依赖

Acceptance 01–05 通过。

## 实施范围

### 1. ProjectWorktreeManager

提供：

- create/find/validate；
- branch/base revision 持久化；
- merge/rebase policy 所需原语；
- retain/cleanup/prune；
- orphan reconcile。

路径：

```text
<projectRoot>/.zero-core/worktrees/<worktree-id>
```

worktree id 由 WorkRun 生成的稳定 opaque id，不能只用 Requirement/Flow 短 id 推算。

### 2. Workspace policy

- `project`：workspaceRoot = projectRoot；
- `worktree`：创建/恢复 linked worktree 后注入路径；
- `agent`：使用 Agent defaultWorkspace，不初始化 Project worktree。

Project root 永远保持注册根；Worktree 只改变 invocation.workspaceRoot。

### 3. WorkRun 接入

WorkRun claim 后先准备 workspace，成功才 dispatch Agent。创建失败：

- WorkRun failed/retry；
- FlowInstance 不自动改变；
- 不发送 Agent prompt；
- 不返回主 checkout。

WorkRun 结束后按 snapshot policy `retain/cleanup/merge-then-cleanup`。合并必须是显式 Work
配置/用户动作，不能因为 Agent turn 成功就自动猜测。

### 4. 既有 worktree

旧 `~/.zero-core/projects/...` 和 `<workspace>.worktrees/...` locator 在在途旧任务结束前
保持可读；新 WorkRun 不创建旧路径。不得在升级启动时移动活跃 worktree。

### 5. Git 边界

- outer Git command 始终以 projectRoot 为 repository identity；
- inner Git 忽略 worktrees；
- source command/cwd 使用 workspaceRoot；
- 验证 worktree `.git` file 指向目标 outer repo；
- 删除前确认绝对路径在精确 worktrees root 内并使用 Git worktree remove。

## 测试

覆盖主/linked root、branch collision、dirty、merge conflict、Git 缺失、non-Git Project、
创建中断、重启恢复、cleanup failure、orphan 和 main fallback 防回归。

## 完成定义

[Acceptance 06](acceptance-06-worktree-execution.md) 全部通过并生成 `result-06.md`。
