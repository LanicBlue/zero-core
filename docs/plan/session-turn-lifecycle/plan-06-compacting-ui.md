# Plan 06：Compacting 与统一 UI/API

## 目标

把 compression 变成显式 Session 状态，并让 UI、HTTP initial snapshot 与 WS 增量共同消费
统一 lifecycle DTO。

## 工作

1. compression coordinator 发布
   `preparing → running(memory once || compression pass 1..N) → commit/blocked`，并为两个
   branch 发布独立状态和 compression pass progress。
2. preparing/running cooperative cancel；commit 最小临界段 settle 后处理 Stop。
3. compacting 期间普通 invocation 入 inbox，task event 入 event inbox。
4. commit 后严格按 Stop → handoff/queue → 原 Turn completion 顺序归并。
5. UI 展示 running、waiting reason、needs_input、compacting phase、cancelling、queue paused/count、
   background counts，以及 Provider burst/lifetime attempt、provider_retry/provider_quota/
   provider_suspended/provider_config、nextRetryAt 和 resetAt。
6. Provider preview reset 与 compaction generation 分别 fencing，任一旧增量都不能覆盖新 revision。
7. 重连先应用新 revision snapshot，再接收增量。
8. 把首页 Dashboard 的单 Provider selector 升级为 Provider Control Center：所有 Provider
   同时可见、按故障严重度排序，保留选中项 usage/queue 详情。
9. 每个 Provider 行展示 aggregate/key-level runtime、受影响 Session/Task、sanitized error、
   nextProbeAt/resetAt；状态来自 ProviderRuntimeSnapshot，不从 metrics 猜测。
10. 首页提供“重试 Provider”：只在 manualRetry.allowed 时启用；多 key 默认选一个最旧
    eligible key，展示 probing/succeeded/rejected，config_required 跳转 Provider Settings。
11. Session/Task 详情只显示等待原因和“在首页查看”，不再提供第二个重试入口。
12. 增加组件测试、WS reconnect、retry 防连点和 compact/Stop/input/task/provider 五方 race。
13. 本阶段只建立 Session supervisor、Provider scheduler、safe-point、branch DTO 和 UI
    contract；Snapshot、水位、MemoryRunner、CompressionPipeline、WikiPatch/SummaryCandidate
    与双数据库提交算法由后续
    [`memory-compaction-runtime`](../memory-compaction-runtime/README.md)实现，不能在本阶段
    复制一套临时算法。

## 首页布局方案

当前主窗口默认 `1400 × 900`、最小 `900 × 600`；Icon Sidebar 占 48px，Dashboard 自身左右
padding 共 48px。默认窗口可用内容宽约 1296px，不能按整屏 1400px 设计。

### 1. 信息层级

首页固定顺序调整为：

```text
┌ Dashboard header ────────────────────────────────────────────────────────────┐
├ KPI：Session / Running / Waiting / Today Tokens / Errors ──────────────────┤
├ Provider Control Center ────────────────────────────────────────────────────┤
│ ● Provider       State       Load       Impact       Recovery       Action  │
│ ● Anthropic      quota       0/4 · 8q   6S · 3T      reset 18:30    [disabled]│
│ ● OpenAI         healthy     2/6 · 0q   —            —              [›]      │
│ ◐ Compatible     suspended   0/2 · 4q   4S · 1T      probe available [重试]   │
├ Agents 35% ───────────────────────┬ 今日任务 65% ────────────────────────────┤
│ …                                │ …                                        │
└──────────────────────────────────┴──────────────────────────────────────────┘
                                                     ┌ Provider detail drawer ┐
                                                     │ Recovery / keys         │
                                                     │ Waiters / usage         │
                                                     └─────────────────────────┘
```

Provider Control Center 从现有页面底部移到 KPI 之后。collapsed rows 用于全局扫描和恢复操作；
usage chart、完整 queue、availability key 与长错误进入右侧 drawer，避免基础页面无限增高。

### 2. 默认宽屏（内容宽 ≥ 1180px）

Provider 行高 52px，列预算：

| 列 | 预算 | 内容规则 |
|---|---:|---|
| 状态 | 24px | dot + accessible label |
| Provider | min 180px，弹性 1.5fr | name 单行；type/route 次行 |
| State | 120px | aggregate badge |
| Load | 120px | `inFlight/max · waiters` |
| Impact | 150px | affected Sessions/Tasks |
| Recovery | min 180px，弹性 1fr | sanitized error 或 reset/probe time |
| Action | 120px | retry/settings/detail；永不隐藏 |

列间 gap 总预算不超过 72px。默认约 1296px 内容宽下，最小列宽之和不超过 1080px，保留
至少 216px 给 Provider/Recovery 弹性列。名称和错误只能 ellipsis，不能挤压 Action。

### 3. 标准/最小窗口

| 窗口 | 布局 |
|---|---|
| `1024–1399px` | 内容宽约 920px；Provider+State 合并，Impact 收入 Recovery，行高 60px；保留 Load、Recovery、Action |
| `900–1023px` | 内容宽约 796px；四列 `Provider/State · Load · Recovery · Action`，行高 64px；完整影响范围进 drawer |
| Web `<900px` fallback | 单列 Provider cards；Action 固定卡片右下，不允许水平滚动 |

页面使用一个纵向主滚动，不给 Provider collapsed list 设置内部滚动。当前 4 个 system
Provider 加 1 个 custom Provider 的容量目标约占 260px；10 个 Provider 约占 520px 并自然
把 Agents/今日任务推到下方。最小窗口允许页面滚动，不能通过缩小到 10px 字体或隐藏 retry
操作来强行首屏容纳。

### 4. 垂直容量

在 `1400 × 900`：

- header + KPI + gaps 预算不超过 160px；
- Provider section header 40px，5 行 260px，section padding/gap 不超过 40px；
- 页面 padding 共 48px；
- 首屏前半合计不超过 508px，至少留下约 300px 给 Agents/今日任务。

在 `900 × 600` 不要求 Agents/今日任务同时完整首屏；要求 header、KPI、Provider section header
和至少 3 个 Provider 行可见，剩余内容通过页面主滚动到达。

### 5. Provider detail drawer

- `≥1200px` 宽 520px；`900–1199px` 宽 480px；更窄 fallback 占可用内容宽。
- drawer 内顺序：状态/恢复操作 → availability keys → affected waiters → usage/history。
- drawer 自身可滚动，基础页面保持位置；关闭后焦点回到原 Provider 行。
- availability key 只显示 public label/model scope；account、credential、header 不渲染。
- queue 默认显示前 20 项并提供分页/virtualization，不能把任意长度 waiter 全量挂到 DOM。

### 6. 操作状态

- healthy/busy：不显示 retry，保留详情 chevron；
- retrying/half-open：按钮显示“探测中…”并禁用；
- known quota resetAt：显示本地绝对时间 + 相对倒计时，reset 前禁用；
- unknown quota/suspended 且 minProbeAt 已到：显示“重试 Provider”；
- minProbeAt 未到：显示可重试倒计时并禁用；
- config_required：主操作“打开设置”；
- command 发出后立即按 expected revision 锁定该行；以 runtime event/command result 解除，
  不能乐观地把 Provider 标成 healthy。

重试是单击直接执行的低摩擦操作，不增加确认弹窗；按钮防连点且必须显示正在 probe 的 key。

### 7. 内容与视觉验收矩阵

实施时至少为以下组合保存截图或组件快照：

- 视口：`1400 × 900`、`1024 × 768`、`900 × 600`；
- Provider 数：0、1、4（当前 system 数）、5（含 custom）、10；
- 名称：普通、40 字符长名称、中英文混排；
- 状态：healthy、busy、retrying、quota known/unknown、suspended、config_required、disabled；
- 数值：0/99 waiters、0/99 affected tasks、长 reset 时间和本地化错误；
- drawer：0、1、20、100 waiter；1 个和多个 availability key。

所有组合必须无横向页面滚动、Action 不被截断、状态不只靠颜色、倒计时不跳宽、长文本可通过
tooltip/drawer/accessible name 完整读取。

## 完成

[Acceptance 06](acceptance-06-compacting-ui.md) 通过并创建 `result-06.md`。
