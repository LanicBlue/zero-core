# Plan 02：Project FlowDefinition 与原子 Flow Engine

## 目标

建立独立于旧 Requirement 的 Project FlowDefinition、FlowInstance、milestone
dependency graph、split/merge composition graph、transition event 和通用 Flow tool。
配置和正文由 `.zero-core` 内层 Git版本化；Core DB 只保存可重建查询索引。

## 依赖

Acceptance 01 通过。

## 实施范围

### 1. 配置格式与 schema

引入受锁版本的 YAML parser，并用 Zod 校验。限制文件大小、alias/复杂度和未知字段策略，
错误必须带 definition/version/path，不执行配置中的代码。

物理布局：

```text
.zero-core/flow/
├── active.json
├── definitions/<definition-id>/<version>.yaml
├── instances/<instance-id>/state.json
├── instances/<instance-id>/dependencies.json
├── instances/<instance-id>/documents/
├── instances/<instance-id>/artifacts/
├── compositions/<operation-id>.json
└── events/<event-id>.json
```

definition version 文件不可原地修改；active binding 可切换。

### 2. 默认 Project Flow

提供可安装模板表达 Found/Discuss/Ready/Plan/Build/Verify/Closed/Abandoned，并包含
Ready→Discuss、Build→Plan、Verify→Build 返工回边，以及从全部活动状态进入 terminal
Abandoned 的 reason-required transition；状态名、正向/反向和废案语义都不进入核心
union。Project 启用 Flow 时复制成项目自有 version 1；已有 Project 是否启用是显式动作。

### 3. FlowService

实现：

- list/get/create FlowDefinition version；
- set/get active definition；
- create/list/get FlowInstance；
- list allowed transitions；
- transition with `expectedRevision`；
- list event/history。

FlowDefinition 支持：

- named milestone；
- `transition-reached`（latched）；
- `state-in`（live）；
- 有向 transition graph，允许回边/循环和同一 state pair 的不同 transition id；
- state 字符串简写或 `{id, terminal:true}`，transition `from` 支持单值/非空列表；
- terminal state 禁止作为任何 transition 的 `from`，首版无 reopen；
- transition 的有限 declarative input contract（required、基础类型、长度/数量）；
- transition 的 `gates.dependencies: all-satisfied`。
- 命名 `compositionPolicies`，包含 operation、actor、source/target definition 和
  milestone、数量限制、既有 target 策略与可选 dependency template。

transition 顺序严格为：锁定 → 校验 → tmp/atomic replace → inner Git commit → 更新 DB
index/outbox → emit `flow.transitioned`。commit 失败必须回滚文件或留下可恢复 pending
transaction，不得发 event。inner commit 是提交点；其后的 index/publish 失败返回
`committed_pending_delivery`，由 reconcile 补偿，不能回滚已提交事实。

正向、反向和重复返工 transition 使用完全相同的提交路径。反向 transition 追加新 event，
不能删除、改写旧 event 或自动撤销 latched milestone。transition input 必须在拿锁和写
tmp 前按 definition contract 验证。

进入 terminal state 时，同一 event/outbox 投递 terminal metadata、terminal revision 和
可选 currentWorkRunId。本阶段以 fake consumer 固定“先处理历史 run、再匹配 terminal
event 新 Work”的顺序合同；实际 WorkRun cancel/request-cancel 在 Plan 03 接入。
terminal instance 无出边、不物理删除；新的 active definition 不能追溯恢复固定旧
definition version 的实例。未满足 live milestone 的 dependent 显示 terminal-blocked，
但不被级联废案。

### 4. 事件与索引

事件使用稳定 eventId，包含 design 规定字段。DB 建立 definition/instance/event 查询
索引和 delivery/outbox 投影，但启动/后台 reconcile 能从已提交 event 文件重建、补发。
事件消费者重复接收同一 eventId 时必须幂等。

### 5. DependencyGraphService

实现：

- add/remove/list dependency；
- dependent→prerequisite 与 prerequisite→dependent 查询；
- milestone satisfaction/unknown 计算；
- self/direct/indirect cycle 检测；
- gated transition 检查；
- prerequisite transition 后重算并发出
  `flow.dependencies.changed/satisfied/regressed`；
- target unavailable 与 Project unregister 后的 missing/unknown 状态。
- FlowInstance definition migration 对 inbound milestone 的校验/remap；terminal instance
  首版拒绝 migration，不能借此实现 reopen。

dependency 权威边写在 dependent instance 的 `dependencies.json`；Core DB 反向图索引可
重建。mutation 锁顺序固定为 global dependency graph → dependent Project。新增边前目标
instance 与所有可达 graph revisions 必须可 reconcile；无法证明无环时返回
`DEPENDENCY_GRAPH_UNAVAILABLE`。并发 A→B/B→A 测试必须只有一边提交。

dependency 满足不自动 transition；它只解除配置 transition gate 并发标准 event。
live `state-in` milestone 回退时发 regressed，但不自动回滚已经越过 gate 的 dependent；
只阻止后续 gated transition。

### 6. CompositionService

实现：

- 按命名 policy split 一个 source 为多个 child；
- merge 多个 source 到一个新 target，或 policy 允许的既有 target；
- split 固定 source definition policy；merge 固定显式 policy definition
  id/version/digest 和 policy snapshot digest，不跟随 active switch；
- `lineage` 正向/反向查询与 self/direct/indirect cycle 检测；
- 必填 idempotency key 和所有 source/既有 target expected revision；
- 固定 source document revision/inner commit 为只读输入；
- 固定每个新 child/target 的 definition id/version/digest，不受 active switch 影响；
- 可按 split policy 在同一事务创建 parent→child dependency；
- 发出 `flow.instance.split` / `flow.instance.merged` 幂等事件。

首版只接受同 Project 实例。整个 operation 在 per-project lock 内准备所有 instance、
composition manifest、可选 dependency edge 和 event，并以一个内层 Git commit 提交。
若 policy 会创建 dependency edge，锁顺序固定为 global dependency graph →
per-project，与普通 dependency mutation 一致。
失败不得留下部分 child、target、edge 或 manifest。source/parent 保留且 currentState
不变，参与实例只推进 revision 并追加 composition 事实；核心不自动拼接文档、关闭
source、流转 target 或 dispatch Work。DB lineage 索引必须能从不可变 manifest 重建。

### 7. 通用 Flow tool

把 Agent-facing `Flow` 切换到
`list/get/create/transition/history/dependencies.add/remove/list/status/split/merge/lineage`
通用 action。
该工具只管理 FlowInstance runtime，不包含 FlowDefinition publish/activate/mutation；
definition validator/repository 在本阶段提供 service，Plan 07 通过 management-only
`Project.config.*` 暴露。
身份和 active Project 从 CallerCtx 注入；显式跨 Project操作仅允许已注册目标和 Agent
policy 授权，不信任 LLM 伪造 actor。

旧 Requirement service/UI 暂时保留，但固定 `ready/startBuild/verify` 等 action 不再由
新 Flow tool 暴露，也不与新 Flow 双写。

## 测试

覆盖 schema、不可变版本、active switch、instance pin、milestone latched/live、同/跨
Project dependency、dependency self/cycle、并发反向边、missing/unknown、gated
transition、inbound dependency definition migration、split/merge policy、composition
cycle、idempotency、revision conflict、既有/新 target、固定文档输入、同 commit 可选
dependency、跨 Project composition 拒绝、合法/非法 transition、actor、Git commit
故障、commit 后 index/publish 崩溃、事件补发、索引重建、跨 Project 隔离和旧
Requirement 无变化。默认模板另覆盖 Discuss→Ready→Discuss、Plan→Build→Plan、
Build→Verify→Build 多轮往返、任意活动状态→Abandoned、返工/废案 reason 校验、旧
revision conflict，以及每次正反/terminal transition 都产生独立 event。

## 完成定义

[Acceptance 02](acceptance-02-flow-engine.md) 全部通过并生成 `result-02.md`。
