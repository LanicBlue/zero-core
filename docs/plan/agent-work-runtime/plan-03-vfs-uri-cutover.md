# Plan 03：VFS、`.zero-core` 隐藏与 URI 切换

## 目标

建立共享 VFS provider，将 `[skills]/` 硬切为 `skill://`，实现 invocation 级
`flow://project` / `flow://current`，并让普通文件工具从 Project 根看不到物理
`.zero-core`，同时内部 worktree 正常工作。

## 依赖

Acceptance 00–02 通过。

## 实施范围

### 1. VFS provider

共享接口至少提供：

- scheme 识别与 parse；
- resolve operation（read/write/edit/list/search）；
- capability/access 校验；
- normalize/realpath/symlink containment；
- physical→virtual 结果回映射；
- provider-specific mount/context。

URI 必须在调用 `node:path` 前识别。错误不能泄露其他 mount/Project 物理路径。

### 2. `skill://` 原子切换

一次阶段内同步修改 Read/Write/Edit/Glob/Grep/Shell、prompt、scanner、变量替换、
tool output、bundled Skill 和测试。删除 `[skills]/` parser；旧前缀必须返回明确非法虚拟
路径，不能落成 workspace 相对目录。

为已安装内置 `skill-creator` 增加带版本 marker、备份和 rollback 的精确 token
migration。外部 Skill 只报告，不自动重写。

### 3. `flow://`

- `flow://project` 来自 Project Session baseline mount；
- `flow://current` 来自 invocation / WorkRun snapshot；
- access 支持 read/create/read-write；
- mount collision 在 dispatch 前失败；
- document revision/expected revision、atomic replace 和 per-operation inner Git commit；
- composition-triggered Work 将 manifest 固定的 source document revisions 映射为
  read mount；Provider 从指定内层 Git commit/blob 读取，不用当前 working tree
  冒充旧 revision；child/target 文档映射为独立 create/read-write mount；
- Work 结束后下一 invocation 不继承 current mount。

Flow Write/Edit 在 per-project lock 内立即 commit，不能把多个 Agent 的修改留在共享 dirty
tree 等 turn 结束。commit 成功才向工具返回成功；commit 失败恢复原文件或留下可识别
pending transaction。

### 4. 物理 `.zero-core` 隐藏

覆盖：

- Read/Write/Edit；
- Glob/Grep，包括 native fallback 与 `rg --hidden`；
- Project file REST/IPC/router；
- 文件树、context scanner、附件/path picker 等会递归 workspace 的入口。

规则：

- 从 Project root 遍历时忽略直接子 `.zero-core`；
- 显式访问物理控制目录返回 unavailable，Write 不静默成功；
- workspaceRoot 已是 `.zero-core/worktrees/<id>` 时正常访问其内部；
- 从 worktree 向父级控制目录逃逸仍拒绝。

本阶段把 Plan 01 的最小 guard 接线收敛进共享 resolver/provider，删除临时 adapter；迁移
前后错误语义和覆盖面必须一致，不能叠加两套规则。

### 5. Script 输入

Shell 不把 `flow://` 冒充 OS path。Work runner 为 Skill 脚本生成受控 manifest/stdin/参数；
manifest 只包含本 invocation 已授权的 resolved input/output，不暴露其他 mount。

## 测试

为五个文件工具建立 scheme×operation×access 矩阵，覆盖 Windows drive/UNC、`..`、
symlink/junction、encoded path、Glob/Grep output、native fallback、physical bypass、
worktree exemption、并发 Write/Edit、Git commit rollback、migration rollback 和旧前缀
拒绝。

## 完成定义

[Acceptance 03](acceptance-03-vfs-uri-cutover.md) 全部通过并生成 `result-03.md`。
