# Plan 04：Work 与 WorkRun 管理

## 目标

在 Project Work section 中管理 WorkDefinition，显示相关 WorkRun，并为持有对应能力的
Agent/用户提供与 runtime 合同一致的队列操作。

## 依赖

Acceptance 00–03 通过，且 `agent-work-runtime` Final PASS 并合并。本阶段开始前先读取
其全部 result，把实际 WorkDefinition/WorkRun API、schema、授权和旧 Worker 差异补入
`result-04.md`。

## 实施范围

- Work Definition Catalog：版本、active binding、trigger、Agent/Session/workspace policy；
- validate/publish/activate 使用 Project management API，不复制 Work validator；
- 从旧 Worker tab 迁移仍成立的配置，不把旧 `project-work` schema 固定为兼容层；
- queued/deferred/running/waiting/terminal 列表和 Project/Agent/Flow 过滤；
- session/turn/worktree/trigger event/snapshot 关联；
- 激活 Definition Catalog 的 Work trigger 反向引用；
- 激活 Overview attention/activity 与 Flow timeline 的真实 WorkRun contribution；
- defer reason/notBefore、priority/order、retry/cancel；
- safe switch preview，明确当前/目标 revision 和 handoff；
- 无 Work 能力时只读降级，不隐藏实际执行状态；
- reconnect 后从持久 API 恢复。

## 布局方案

Work section 使用 `Definitions | Runs | Queue` 二级导航，共用 filter/deep-link state。

### Definitions

```text
┌ Definitions / search / status / + New ──────────────────────────────────────┐
├ Catalog table/list (full width) ──────────────────── detail drawer 480px ───┤
│ name · active version · triggers · agent/session policy · references · …   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- row 52px；主列 name min 220px，version 120、trigger 180、policy 180、references 120、
  actions 120；
- 20/100 WorkDefinition 可搜索并使用 pagination/virtualization；
- create/edit 使用完整 drawer，不把 trigger、Agent/Session/workspace policy 塞入行内 modal；
- validate/publish/activate 状态固定在 drawer footer/header，stale revision 不只显示 toast。

### Runs 与 Queue

```text
┌ Runs | Queue / filters / search / saved view / refresh ─────────────────────┐
├ virtualized table ───────────────────────────────────── detail drawer 480px ┤
│ status · run · work · flow · agent/session · timing/order · revision · action│
└──────────────────────────────────────────────────────────────────────────────┘
```

- toolbar 48px；row 44px；header sticky；
- wide 列预算：status 112、run 160、work min 180、Flow min 180、Agent/Session 160、
  timing/order 144、revision 96、Action 132；
- Runs 默认按 last activity；Queue 按 runtime authoritative order，不由 renderer 本地重排；
- 1,000 WorkRun 使用 server pagination 或 virtualization；实时 event 只更新可见/索引项，
  不导致整表跳回顶部；
- detail drawer 宽屏 480px、标准 420px；顺序：status/reason → origin/Flow →
  invocation/session/turn/worktree → attempts/events → allowed actions；
- retry/defer/prioritize/cancel 以 expected revision 发命令，pending 状态锁定同一行但不
  乐观伪造 terminal state；
- priority/order 不能只靠拖拽，提供键盘可用的 move/set priority 操作。

### Mutation preview

- safe switch 使用 560px impact dialog：current/target revision、active invocation、
  handoff boundary、受影响 Flow/Session；确认后等待 runtime event；
- cancel 显示是否只取消 WorkRun、当前 Turn 或显式 background task，不用模糊 Delete；
- retry 若会创建新 attempt 保持原 WorkRun identity，在 drawer timeline 显示；
- defer/notBefore 使用 420px drawer/popover，显示 timezone 和最终绝对时间。

### Standard/compact

- `1024 × 768`：隐藏 references/revision 次要列到 drawer，保留 status/name/order/Action；
- `900 × 600`：表格转 compact rows，第一行 status + work/run + Action，第二行
  Flow/Agent/timing；不产生页面横向滚动；
- drawer compact 占可用宽；filter toolbar 分两行，状态筛选与 search 永远可见；
- Overview/Flow timeline deep link 打开相同 tab/filter/selected run，关闭 drawer 后恢复行焦点。

### 容量与视觉证据

覆盖 0/20/100 WorkDefinition，0/100/1,000 WorkRun，100 queued、20 running、20 waiting，
60 字符名称、长 defer reason、stale revision、只读能力和 partial reconnect。三档视口分别
保存 Definitions、Runs、Queue、drawer、switch/cancel preview 截图或视觉回归。

## 完成定义

[Acceptance 04](acceptance-04-work-and-workrun-ui.md) 通过并生成 `result-04.md`。
