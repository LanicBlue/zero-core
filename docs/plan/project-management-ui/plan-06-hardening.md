# Plan 06：Project Management UI 加固

## 目标

完成权限、重连、大数据、可访问性、错误恢复和 legacy 隔离的 UI/E2E 验证。

## 依赖

Acceptance 00–05 通过，且 `agent-work-runtime` Final 已合并。

## 实施范围

- renderer forged actor/Project、stale revision、API unavailable 与 partial reconnect；
- 大 Definition graph、1,000 instance、跨 Project portal 和 timeline 性能；
- 多 Project/deep link、模块局部失败、Wiki job 恢复和 navigation state；
- 键盘操作、焦点、颜色非唯一编码和窄窗口；
- draft/FlowView/import 中断恢复；
- 删除固定状态列、客户端领域校验和临时 adapter；
- 删除旧单体 Project page、重复 Dashboard/Project View 和已迁移 Worker wiring；
- 验收后更新用户文档与活动架构说明。

## 布局与视觉加固

### 统一 token 与滚动

- 把 rail/header/nav/toolbar/drawer/row/padding/breakpoint 提取为 Project UI layout tokens，
  不在新模块继续复制当前大段 inline geometry；
- 审计每个 route 的 scroll owner：Project rail、module content、drawer、Board/Graph 语义
  viewport 之外不得出现未记录嵌套滚动；
- 200% zoom 和系统字体放大时主操作、selected identity、状态与错误仍可达；
- light/dark theme 下 badge、graph edge、focus ring 和 disabled/retry 状态均满足非颜色唯一编码。

### 固定视口矩阵

每个关键 route 至少验证：

| 主窗口 | 预期 |
|---|---|
| `1400 × 900` | persistent/compact rail 按计划，完整 wide columns |
| `1024 × 768` | compact rail/drawer、次要列折叠 |
| `900 × 600` | selector drawer、compact rows/tabs，无页面横向滚动 |

关键 route 包含 Overview、Wiki、Settings、Definitions editor/diff、Board、三种 Graph、
Timeline、Work Definitions/Runs/Queue、Importer Select/Preview/Execute/Verify。

### 数据压力矩阵

- Project：0/1/20/100；
- Definition：1/3/20，state 30，transition 100，version 50；
- FlowInstance：0/50/1,000，relation 3,000，timeline event 10,000；
- WorkDefinition：0/20/100，WorkRun：0/100/1,000；
- Import：0/1/100/1,000；
- 名称 60 字符、path/URL 200 字符、本地化长错误、loading/error/denied/stale/offline。

fixture 必须可重复，不能依赖人工临时造数据。result 记录 virtualization/pagination 阈值、
最大 DOM row/node、交互延迟和内存观察；达不到阈值时先修布局/查询，不能靠缩减验收数据。

### 视觉证据

- 为三档视口保存截图或稳定 visual regression snapshot；
- 至少为 wide dark、minimum dark 和 wide light 保存关键主路径；
- drawer/dialog 打开态、empty/loading/partial error/access denied、长内容和键盘 focus
  必须有代表性证据；
- 截图需记录 commit、fixture、viewport、theme 和 route，不接受无法重现的手工截图。

## 完成定义

[Acceptance 06](acceptance-06-hardening.md) 通过并生成 `result-06.md`，随后执行
[Final Acceptance](acceptance-final.md)。
