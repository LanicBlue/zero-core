# Plan 00：Eval 上游设施对齐

## 目标

以已合并 Flow/Work/VFS/archive 接口为事实源，冻结 Skill 的调用、路径、finding 和归档
输入合同。

## 依赖

`project-flow-system` 与 `agent-work-runtime` Final PASS 并合并。

## 实施范围

- 记录 builtin Skill seed/copy/package 真实接口；
- 核对 `skill://`、Flow create、Work invocation 与 archive v1 JSON；
- 记录目标 commit、环境、baseline 和实现所有者文件；
- 不因缺少 UI 创建 Eval 专用核心 API。

## 完成定义

[Acceptance 00](acceptance-00-upstream-reconciliation.md) 通过并生成 `result-00.md`。
