# Acceptance 00：Wiki 合并后基线与接口对齐

对应 [Plan 00](plan-00-post-wiki-reconciliation.md)。

## A. 前置证据

- [ ] Wiki effort 的 final result 明确 PASS。
- [ ] 当前 commit 包含经用户同意的 Wiki merge commit。
- [ ] 没有从并行旧 worktree 偷带未合并补丁。

## B. Baseline

- [ ] 记录 Node/npm/Git/OS、commit 和 `git status`。
- [ ] `npm run typecheck`、`build:lib`、`test:unit`、`build`、`test:e2e`、
  `check:links` 均有实际结果。
- [ ] 所有既有失败有可复查证据；没有把本阶段新失败标成 baseline。

## C. 映射与冲突

- [ ] `result-00.md` 完整列出数据库、Runtime、CallerCtx、文件保护、Prompt、Project
  API/UI、Git 与 Skill 的真实所有者。
- [ ] Project/Flow/Work 当前 action、授权门控、ManagementService/CallerCtx 后端和旧
  ProjectWorkRunner 路径均有映射。
- [ ] 逐项说明 Wiki 原语是复用、扩展还是不可复用，并给出代码证据。
- [ ] 后续计划没有引用已经不存在的关键接口而未说明替代位置。
- [ ] 没有改变 Flow/Work/Context/VFS 的设计不变量。

## D. 拒绝条件

- Wiki 尚未最终验收或合并便开始本 effort。
- 用临时 adapter 同时支持 Wiki 合并前后两套 Runtime。
- 本阶段包含功能实现或数据库 schema 变更。

## E. 必备证据

`result-00.md` 必须包含 baseline 命令、映射表、冲突清单、后续文件定位修订和是否允许进入
Plan 01 的明确结论。
