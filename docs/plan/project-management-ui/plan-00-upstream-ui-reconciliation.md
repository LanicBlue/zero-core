# Plan 00：上游 UI/API 对齐

## 目标

从已合并 Wiki 页面和 Flow API 的真实代码出发，冻结 Project 页面模块所有权、导航状态、
数据源和迁移顺序，避免 renderer 建立第二套状态或校验器。Work API 等 Agent Work
Runtime Final 后在 Plan 04 单独 reconciliation。

## 依赖

- `wiki-system-redesign` Final PASS、用户同意并已合并；
- `project-flow-system` Final PASS 并合并。

## 实施范围

- 读取 Wiki Final result 与合并后的 `ProjectPage`、Wiki management/card、store 和 route；
- 记录 definitions/bindings/instances/relations/history API schema；
- 确认 Project CRUD、management identity、Project scope、reconnect/refetch 和稳定错误；
- 建立当前页面每块 UI 到 Overview/Flows/Work/Wiki/Settings/Legacy 的迁移表；
- 在 `1400 × 900`、`1024 × 768`、`900 × 600` 记录合并后页面截图、实际可用宽高、rail/
  header/tab/content 尺寸、scroll owner、inline style/CSS 与 overflow；
- 核对全局 Icon Sidebar、title bar、PageStore、drawer/dialog、theme 和现有响应式 token，
  修订 design 2.1 的断点与容量预算；
- 确认 Wiki card 组件与 API 的复用边界，不新建兼容 adapter；
- 定义 navigation state、`ProjectManagementModule`、Overview contribution 和错误边界合同；
- 列出旧 Requirement/Worker UI/API 边界及可复用的非业务组件；
- 记录重叠改动文件和分阶段 strangler 顺序；
- 写 `result-00.md`，冻结 Project renderer 基线、Flow data layer、三档视口 screenshot 和
  可重复大数据 E2E fixture。

如果 Wiki Final 的真实实现已经采用不同页面结构或组件边界，本阶段必须按实现结果修订后续
文件并重新验收，不能按本设计记录的旧 975 行基线机械迁移。

## 完成定义

[Acceptance 00](acceptance-00-upstream-ui-reconciliation.md) 通过。
