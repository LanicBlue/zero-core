# Acceptance 01：Project 控制目录与内层 Git

对应 [Plan 01](plan-01-project-control-git.md)。

## A. 路径与所有权

- [ ] 控制目录只由注册 Project 根计算。
- [ ] fresh 初始化生成合法 manifest、稳定目录和内层 `.git`。
- [ ] 空目录可初始化；未知非空、其他 Project manifest、tracked 冲突被拒绝。
- [ ] symlink/junction 不能把控制面导向 Project 根外。
- [ ] 删除 Project 注册不递归删除控制目录。

## B. Git 行为

- [ ] 外层 exclude 使用 Git 解析路径，规则精确且幂等，不改 `.gitignore`。
- [ ] 内层 commit 不改用户 Git config，空变化不提交。
- [ ] worktrees/runs/cache/tmp 不进入内层 history。
- [ ] 自动化实验确认外层 `clean -fdx` 保留、`clean -ffdx` 可删除的边界。
- [ ] 非 Git Project 仍可初始化内层 Git；缺 Git binary 时返回稳定 unavailable。

## C. 启动与多项目

- [ ] 新注册失败不留下半注册/半控制目录。
- [ ] 既有一个 Project conflict 不阻止其他 Project 和应用启动。
- [ ] conflict/unavailable 在 API/UI 查询状态中可见，且新 Flow/Work 被禁用。
- [ ] DB status 可从 manifest/内层 Git 重建，不成为第二事实源。

## D. 中间阶段安全

- [ ] 控制目录创建后，普通文件工具、文件 API、文件树和 context scanner 立即不可见。
- [ ] 显式物理路径访问稳定拒绝，Write 不静默成功。
- [ ] guard anchored 到 Project control root，不误伤其他同名目录。
- [ ] 临时 adapter 明确标注 Agent Work Runtime Plan 03 删除点，不形成两套长期实现。

## E. 验证

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run check:links
```

## F. 必备证据

`result-01.md` 包含 fresh/conflict/unavailable/linked-worktree 矩阵、两层 Git status/clean
输出、commit/restore 测试、普通工具/API 隐藏和所有物理目录安全检查。

## G. 拒绝条件

- 修改目标项目 `.gitignore` 或 global/local Git identity。
- 未知 `.zero-core` 被覆盖、清空或接管。
- 一个坏 Project 使整个应用无法启动。
- 把内层 Git 描述为 `-ffdx` 或磁盘故障的完整备份。
- 在 Plan 01–04 的可交付 commit 中暴露物理 `.zero-core`。
