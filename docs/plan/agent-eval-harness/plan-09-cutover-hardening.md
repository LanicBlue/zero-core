# Plan 09：切换、恢复、性能与活动文档

## 目标

完成所有新路径的恢复、故障注入、性能和兼容边界，清除临时 adapter 和 Agent-facing 旧
Flow action，并在验收证据充分后更新活动架构文档。旧 Requirement 数据/UI 可保留，
但不得再冒充新 Flow。

## 依赖

Acceptance 01–08 通过。

## 实施范围

### 1. 启动恢复

联合验证：

- control manifest/inner Git dirty/pending transaction；
- DB index rebuild；
- dependency reverse index、milestone satisfaction 和漏发 dependency event；
- composition lineage/idempotency index 和漏发 split/merge event；
- queued/running WorkRun；
- deferred/notBefore/priority/switch reservation 与 terminal Flow cleanup；
- missing/stale worktree；
- invalid definition/work snapshot；
- skill migration interruption；
- archive checkpoint。

恢复必须逐 Project 隔离，不能一个坏 Project 阻塞全局。

### 2. Cutover 清理

- 删除 Agent-facing 固定 Flow action 和其 prompt/schema/tests；
- 复核 Plan 07 已把 management-only `Work create/update/delete/list/fire` 原子切换为
  Project Agent `Work current/list/get/defer/prioritize/switch/cancel/retry`，删除任何
  残留旧 action/fallback；
- 将 Flow/Work definition 管理接入 management-only `Project config.*`，`Project.work.fire`
  只创建 durable WorkRun，不直接调用旧 runner；
- 验证普通 Agent 的 `Flow` 只有 FlowInstance runtime action，管理 Agent 的 `Project`
  才能 publish/activate definition；
- 删除旧 ProjectWorkRunner/HookManager 的新系统调用路径和 Work→ManagementService
  singleton；旧 Requirement 自有路径只在明确 legacy 边界内存续；
- 旧 Requirement service/UI 明确 legacy 命名，不与新 Flow 双写；
- 删除本 effort 中临时 adapter、fallback、feature flag 双实现；
- grep `[skills]/`、旧 worktree 新建路径、busy skip、新 Flow 调用 Requirement 的残留；
- 不删除旧 Requirement 数据或用户文档。

### 3. 性能与规模

至少测：

- 多 Project control ensure；
- 100/1,000 FlowInstance list/filter/history；
- WorkRun queue claim/reconnect；
- dependency/composition graph query 与 rebuild；
- 内层 Git commit 与 index rebuild；
- Glob/Grep 在 Project 根不会递归 worktrees；
- archive 增量扫描不会每次全量重复分析。

阈值在 Plan 00 baseline 后写入 result/acceptance 补充，不以关闭测试规避慢路径。

### 4. 安全与故障注入

覆盖 Windows path、junction、repo lock、磁盘写失败、Git process failure、进程 crash、
重复 event、并发反向 dependency edge、target Project unavailable、renderer/LLM forged
actor/project/workRun、switch 双 revision conflict、terminal cleanup race、split/merge
revision conflict/部分提交、malformed YAML/archive 和 script child process。

### 5. 文档

只有实现证据通过后才更新：

- docs/arch / basic 当前事实；
- Tool/Skill/Flow dependency/composition 用户说明；
- Project 控制目录与清理警告；
- Requirement legacy/importer 边界；
- 开发/测试命令。

本 plan/design 仍保留为历史目标与证据；最终归档由用户同意后执行。

## 完成定义

[Acceptance 09](acceptance-09-cutover-hardening.md) 通过并生成 `result-09.md`，随后执行
[Final Acceptance](acceptance-final.md)。
