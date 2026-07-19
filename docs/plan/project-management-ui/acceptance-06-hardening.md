# Acceptance 06：Project Management UI 加固

对应 [Plan 06](plan-06-hardening.md)。

- [ ] forged scope、stale revision、offline/reconnect 和 partial failure 有 E2E 证据。
- [ ] 大图/Board/timeline 达到 result 预先记录阈值。
- [ ] 关键操作可键盘完成，状态不只靠颜色表达。
- [ ] 多 Project、deep link、窄窗口和各 module loading/error/access-denied 有 E2E 证据。
- [ ] Wiki reindex 等后台 job 跨 section/页面重开保持 server 状态。
- [ ] renderer 无固定业务状态、重复 domain validator 或本地真相源。
- [ ] 不再存在重复 Dashboard/Project View、旧单体 host 或已迁移 Worker wiring。
- [ ] legacy Requirement 与新 Flow UI 无双写或隐式 importer。
- [ ] typecheck、build:lib、unit、build、E2E、check:links 全部成功。

## 布局与视觉门禁

- [ ] rail/header/nav/toolbar/drawer/row/padding/breakpoint 使用共享 layout token，新模块无复制
  当前单体 inline geometry 的 fallback。
- [ ] 每个 route 的主滚动、rail/drawer 滚动、Board 横向 viewport 和 Graph pan/zoom 所有者
  与设计一致，无未记录嵌套/页面横向滚动。
- [ ] Overview、Wiki、Settings、Studio/diff、Board/Graphs/Timeline、Work 三页和 Import 四阶段
  全部通过 `1400 × 900`、`1024 × 768`、`900 × 600`。
- [ ] 固定 fixture 覆盖 100 Project、20 Definition、1,000 Flow、10,000 event、100
  WorkDefinition、1,000 WorkRun、1,000 import item 与长文本/错误。
- [ ] result 记录 pagination/virtualization threshold、最大 DOM row/node、交互延迟和内存观察。
- [ ] wide dark、minimum dark、wide light 及 drawer/dialog/error/focus 有可重现视觉证据，记录
  commit、fixture、viewport、theme、route。
- [ ] 200% zoom/系统字体放大后 selected identity、主操作、错误和 keyboard focus 仍可达。
