# Issue：Project Flow System

zero-core 当前的 Requirement 流程由固定 TypeScript 状态、action 和 renderer 常量驱动，
无法让不同 Project 自主定义流程，也没有可靠的实例依赖、拆分/合并、原子事件历史和
项目内控制仓库。

本 effort 只解决 Project 级 Flow 控制面与运行面：

- `<project>/.zero-core/` 控制目录与内层 Git；
- 一个 Project 下多个 FlowDefinition 及各自不可变版本；
- FlowInstance、transition、milestone、dependency、related relation 与 split/merge
  lineage；
- management-only Project 配置入口和普通 Project Agent 的 Flow runtime 工具/API。

WorkRun 执行、Turn 上下文、VFS、worktree、管理 UI 和 Eval Skill 分别属于后续 effort。
新 Flow 不复用或双写旧 Requirement 状态机。
