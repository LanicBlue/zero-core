# Acceptance 01：Project 页面壳层与 Overview

对应 [Plan 01](plan-01-project-shell-overview.md)。

## A. 信息架构与导航

- [ ] Project selector 与 Selected Project workspace 层级清楚。
- [ ] Overview、Flows、Work、Wiki、Settings 使用稳定一级导航。
- [ ] projectId + section 可恢复；刷新、返回和 deep link 不无条件选择第一个 Project。
- [ ] 无 Project、无选择、Project 被删除和无权访问都有可判定状态。
- [ ] Legacy Requirements 只在适用时显示，并与新 Flow 明确区分。

## B. Header、Settings 与安全操作

- [ ] header 显示 Project identity、workspace/repository 与关键 health，不重复详情页面。
- [ ] Project 删除、Wiki 解绑、Wiki 归档和清理是不同操作，不使用模糊的单一 Delete。
- [ ] Project 删除位于 Settings danger zone；Wiki 操作留在 Wiki 模块，各自显示真实影响
      并要求明确确认。
- [ ] renderer 不能在 payload 中自报 actor/admin/Project scope。

## C. Overview

- [ ] control、Wiki、Flow、当前 Session 和 resource contribution 可独立加载和失败。
- [ ] 每项摘要有 freshness/source/error，局部失败不遮蔽其他模块。
- [ ] attention card 可跳转到对应模块和可复现筛选。
- [ ] Overview 不持久化跨领域综合状态，不提供跨领域隐式 mutation。
- [ ] WorkRun/完整 Session lifecycle 前置未满足时不使用 mock、空数组或旧 schema 冒充。

## D. 模块与 Wiki 所有权

- [ ] Project shell、header、module host 与领域模块已从单体边界拆分。
- [ ] 模块使用稳定 projectId/navigation/capability 合同，不读取其他模块私有 store。
- [ ] Wiki section 复用 Wiki Final 的真实 card/API/job 状态，无第二套 Wiki store/API。
- [ ] 页面关闭或切 section 不取消 server reindex job，重新进入可恢复进度。
- [ ] 尚未迁移的 Worker/Legacy 行为保持可访问且无双写。

## E. 布局与证据

- [ ] `1400 × 900` 下 248px rail、72px header、40px nav 和 Overview 12-column grid
  符合 Plan 01 线框，无页面横向滚动。
- [ ] `1024 × 768` 使用 56px compact rail + 280px overlay drawer；`900 × 600` 使用
  context selector + 最大 320px drawer。
- [ ] Overview 在宽屏为 attention/health、activity/resource、Wiki/Session 组合，compact
  为单列；局部状态不会引起大幅 layout shift。
- [ ] Project rail 0/1/20/100 项可搜索和滚动，100 项不阻塞页面；切换 Project 不重置
  section/drawer 无关状态。
- [ ] 60 字符 Project 名与 200 字符 path 不挤掉 health/action，完整值可读取和复制。
- [ ] Settings 内容宽不超过 760px，Danger Zone 最后；destructive action 不出现在 header。
- [ ] 页面只有 module content 主滚动、Project rail 滚动和明确的 drawer 滚动，无任意
  card 内嵌滚动。
- [ ] 一级导航、selector 和 danger confirmation 可键盘完成，焦点可见。
- [ ] `result-01.md` 包含新旧布局映射及 `1400 × 900`、`1024 × 768`、`900 × 600`
  的 Overview/Wiki/Settings/Legacy 截图或视觉回归证据。
