# Acceptance 03：VFS、`.zero-core` 隐藏与 URI 切换

对应 [Plan 03](plan-03-vfs-uri-cutover.md)。

## A. `skill://`

- [ ] 所有公开路径、prompt、工具输出和 bundled Skill 只使用 `skill://`。
- [ ] Read/Write/Edit/Glob/Grep/Shell 行为一致。
- [ ] `[skills]/` 明确拒绝，不按 workspace 路径处理。
- [ ] 内置 skill-creator migration 有 marker、备份、幂等和 rollback。
- [ ] 外部 Skill 残留旧前缀只报告，不被覆盖。

## B. `flow://`

- [ ] project/current mount 来自当前 invocation。
- [ ] read/create/read-write 在五个文件工具中执行一致。
- [ ] mount collision、revision conflict、missing read/create 语义可判定。
- [ ] composition source input 固定到 manifest revision 且只读，child/target 输出使用
  独立 mount；Provider 从指定内层 Git blob 读取，active 文档变化不偷换运行中输入。
- [ ] 每次逻辑 Write/Edit 在返回成功前生成内层 commit；两个 Agent 不共享跨 turn dirty
  tree，commit 失败恢复或可恢复。
- [ ] physical path 不出现在 Agent tool result/error。
- [ ] Work结束后的下一 invocation 无旧 current mount。

## C. `.zero-core` 隐藏

- [ ] Project root 文件树、Glob、Grep、context 和文件 API 不显示控制目录。
- [ ] 显式 Read/Write/Edit 物理控制目录失败，Write 不假成功。
- [ ] native grep fallback 与外部 rg 行为一致。
- [ ] 内部 worktree 作为 workspace 时源码访问正常。
- [ ] worktree 的 `..`、absolute、symlink/junction 不能访问父控制面。

## D. Script 边界

- [ ] `flow://` 不直接传给 OS 命令当文件路径。
- [ ] script manifest 只含当前授权输入/输出，生命周期结束后清理。
- [ ] 文档不宣称 VFS 是恶意 Shell 沙盒。

## E. 验证与证据

运行 typecheck、build:lib、unit、相关 E2E、check:links。`result-03.md` 包含完整工具矩阵、
Windows path cases、并发/commit rollback、旧前缀 grep、物理绕过与 worktree exemption
证据。

## F. 拒绝条件

- 只改 Read，其他工具保留不同 scheme 逻辑。
- 物理 `.zero-core` 被“隐藏”但明确绝对路径仍由普通工具访问。
- 为兼容保留 `[skills]/` alias。
