# Plan 00：Project Flow System 的 Wiki 合并后基线

## 目标

在不实现本 effort 功能的前提下，确认 `wiki-system-redesign` 已完成最终验收并合并，
重新核对合并后的数据库、CallerCtx、AgentLoop、文件保护、Project API 和 UI 结构，把
本 effort Plan 01–04 及下游公开接口映射到真实代码。

## 当前实施前置

- `docs/plan/wiki-system-redesign/result-final.md` 存在且结论 PASS。
- 用户已同意将该 effort 合并到本 effort 的目标主分支。
- 当前 checkout 包含该合并 commit，不得从旧 main 或其并行 worktree 开始。

任一条件不满足，执行者按本次计划安排报告 blocked，不能先写兼容层。

这只是当前 effort 的外部工作安排。Plan 00 负责核对事实，不代表 zero-core 已创建
FlowDependency 或正在执行系统门禁，也不会向软件写入任何控制状态。引擎落地后，是否把
未来任务的关系注册成 FlowInstance dependency，仍是用户或 Agent 在软件运行时执行的
显式操作。

## 实施范围

### 1. 建立 baseline

记录：

- 当前 commit 和 `wiki-system-redesign` merge commit；
- Node、npm、Git、OS；
- typecheck/build/unit/E2E/link baseline；
- 当前 dirty files 与已知失败。

### 2. 代码事实映射

生成 `result-00.md` 中的映射表，至少覆盖：

| 设计职责 | 合并后的真实所有者 |
|---|---|
| Core DB 生命周期与 migration | 文件/类/表 |
| Project registry 与 workspace normalization | 文件/类 |
| Agent + Project Session 路由 | 文件/类 |
| AgentLoop run/resume/Wait/queue | 文件/类 |
| CallerCtx / tool construction | 文件/类型 |
| Project/Flow/Work 当前 action、tool grant 与 management/CallerCtx 门控 | 文件/服务 |
| 文件保护、source read/search | 文件/类 |
| Prompt compiler/cache invalidation | 文件/类 |
| Project REST/IPC/UI | 文件/组件 |
| Git integration/worktree | 文件/类 |
| bundled Skill seed/scanner | 文件/脚本 |

### 3. 冲突审计

逐项判断 Wiki 重构是否已提供可复用原语：

- 动态 per-turn context provider；
- 逻辑 URI/VFS；
- 物理数据目录 guard；
- Core DB migration/repository；
- Project UI 数据层；
- Prompt 安全刷新边界。
- 工具权限事实源与 Project/Flow/Work 当前配置面/运行面。

只复用语义一致的实现。名称相似但权限、事实源或生命周期不同的代码不得强行复用。

### 4. 冻结接口映射

若仅文件名、类名或调用点变化，可更新后续 plan 的“建议文件”与测试定位。若需要改变
设计不变量，必须走 README 变更控制并停在本阶段。

## 明确不做

- 不创建 `.zero-core`。
- 不新增 Flow/WorkRun 表。
- 不修改 AgentLoop、工具、UI 或 bundled Skill 行为。
- 不为了让旧测试通过而恢复 Wiki 兼容层。

## 完成定义

仅当 [Acceptance 00](acceptance-00-post-wiki-reconciliation.md) 通过并创建
`result-00.md`，才可进入 Plan 01。
