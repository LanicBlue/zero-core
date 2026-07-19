# Plan 01：Project 页面壳层与 Overview

## 目标

把现有 Project 页面改造成可扩展的 Project Management workspace，调整页面布局和导航，
建立清楚的模块边界；在不改变 Wiki/Flow/Work/Requirement 领域语义的前提下，先迁移
Project 级通用体验。

## 依赖

Acceptance 00 通过。

## 实施范围

### 1. 页面壳层

- Project selector、create/register 入口、empty/loading/error 状态；
- selected Project header：名称、workspace/repository、control/Wiki health 与主操作；
- Overview、Flows、Work、Wiki、Settings 一级导航；
- projectId + section 的可恢复 navigation/deep-link state；
- 窄窗口折叠 selector、键盘导航和稳定焦点；
- Settings 中的 registration/workspace/control 信息与 Project danger zone；
- 删除/解绑/归档等不同语义分别展示，不把 Delete 放在全局 tab strip。

### 2. Overview

- attention：Flow blocker、failed/stale Wiki；
- health：control repository、repository binding、Wiki revision/sync；
- activity：最近 transition、Wiki operation 和当前 API 可提供的 Session activity；
- resource：Session/token/cost 摘要；
- 每个 contribution 显示 source freshness、loading/error，并可跳入对应筛选视图。

Overview 只组合 read model。单个模块失败不能让 Project 页面或其他模块不可用；刷新动作按
模块执行，不用一个无边界的全局 reload。

### 3. 模块拆分与 Wiki 编排

- 从合并后的 `ProjectPage` 提取 shell、header、navigation 和模块 host；
- 建立类型化静态 module registry 或等价组合合同；
- 把 Wiki Final 的 Project card 复用到 Wiki section/Overview，不改变其 job lifecycle；
- 保留未迁移的 Worker 和 Legacy Requirements 可访问，并清楚标为 legacy；
- 消除 Dashboard/Project View 的重复摘要，不在壳层复制领域 formatter/validator。

本阶段不实现 Definition Studio、Flow graph、新 Work runtime UI 或 importer。WorkRun/
完整 Session lifecycle contribution 只登记稳定 availability slot；前置未满足时缺席或
明确 unavailable，不用 mock、空数组或旧 schema 冒充真实结果。

## 布局方案

### Wide shell（默认 `1400 × 900`）

```text
┌ Context 56px：Projects / selected identity / health / Open / … ────────────┐
├ Rail 248px ───────┬ Header 72px：name + path/repository + health chips ─────┤
│ Search 36px       ├ Nav 40px：Overview | Flows | Work | Wiki | Settings     │
│ + Register        ├ Overview 12-column grid ─────────────────────────────────┤
│ Project row 52px  │ Attention 8 cols         │ Control health 4 cols         │
│ Project row       ├ Activity 8 cols          │ Resource 4 cols               │
│ …                 ├ Wiki/Session contribution 6 + 6 cols                     │
└───────────────────┴──────────────────────────────────────────────────────────┘
```

- context bar 与 navigation sticky；Header 属于 workspace content，不在每个 section 重复；
- rail 宽 248px，Project row 52px：名称一行、workspace/repository 次行、health dot；
- rail search/create 固定，列表独立滚动；20 项直接渲染，100 项必须搜索且可 virtualization；
- header identity 区至少 280px，health chips 可换行一行；主操作保留，次要操作进入 overflow；
- Delete/解绑/归档不出现在 header 或 tab strip，只在 Settings danger zone。

### Overview 容量

- 使用 12-column grid，gap 16px；workspace <900px 时单列；
- Attention 最多直接显示 5 条，按 severity/age 排序，剩余进入带筛选 deep link；
- Activity 最多显示最近 10 条，固定行高 44px，更多内容进入领域 Timeline；
- health/resource 卡片最小宽 240px，数值区不能因 label 长度改变列宽；
- contribution 卡片最小高 136px，loading/error/unavailable 使用同一占位高度；
- Overview 不直接嵌入 Board、graph、完整 Wiki tree 或 Work queue。

### Standard/compact

- `1024 × 768`：rail 默认 56px，overlay drawer 280px；Overview 两列，Header 次要 metadata
  折叠为 detail row；
- `900 × 600`：只有 context selector button，drawer 最大 320px；Overview 单列，nav 保持
  横向可见，不用 hamburger 隐藏一级 section；
- selector drawer 打开不改变当前 section，关闭后焦点回 selector button；
- 40/60 字符名称与 200 字符 path 只能 ellipsis，完整值在 tooltip/copy action 可用。

### Settings、Wiki 与 legacy

- Settings 表单内容宽上限 760px，分 Registration、Workspace/Repository、Control、
  Danger Zone；Danger Zone 永远最后；
- create/register 使用 560px dialog，compact 变 full-width sheet；目录路径支持粘贴和
  browse，不使用当前固定 420px 内联 modal；
- Wiki section 复用上游组件，在 module content 内占满宽度，不再包第二层 Project header；
- Legacy Requirements 是独立 secondary route/banner，不与 Flows 一级内容并排。

## 测试

覆盖至少两个 Project、无 Project、deleted selected Project、deep link、刷新/重连、Wiki
loading/failure/reindex running、局部 API failure、窄窗口和键盘导航。截图或 E2E trace
必须同时包含 Overview、Wiki、Settings 和 Legacy 入口，并至少覆盖 `1400 × 900`、
`1024 × 768`、`900 × 600`，以及 0/1/20/100 Project、长名称/path 和局部失败。

## 完成定义

[Acceptance 01](acceptance-01-project-shell-overview.md) 通过并生成 `result-01.md`。
