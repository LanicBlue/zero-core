# Issue：Project Management UI

当前 Project 页面并不是一个稳定的项目管理工作台，而是从旧 Kanban 页面逐步堆叠形成的
单体组件。源码中的 `ProjectPage.tsx` 同时承担项目选择、新建/删除、Dashboard、旧
Requirement、Cron、Wiki、Session、资源统计和 Project Work；四个平级 tab 也无法表达
这些能力之间的层级。`wiki-system-redesign` 还会在同一页面增加 Project Wiki 管理卡，
若继续由各领域直接修改这个组件，后续 Flow、Work 和外部 Agent 能力会不断争用同一布局。

当前页面还把 Project rail 固定为 220px，tab body 自行滚动，并大量使用内联 geometry；
应用真实窗口从默认 `1400 × 900` 可缩到 `900 × 600`，但页面没有按可用宽度定义 selector、
header、Studio、Graph、Work table 或 Importer 的 breakpoint、scroll owner 和内容容量。
如果只保留“响应式布局/窄窗口可用”这类原则，实施 Agent 仍需现场决定骨架，视觉验收也无法
判定长名称、大图和 1,000 行数据是否真的放得下。

配置化 Flow 如果只提供 YAML/API，用户也仍难以管理多个 Definition、理解回边与 gate，
或快速看出哪些 Flow 被依赖阻塞、由何种 split/merge 产生、当前有哪些 WorkRun 正在执行。
但若把这些体验限定为 Flow 管理，又会遗漏 Project 选择、整体健康、Wiki、Workspace 和
危险操作等 Project 级职责。

本 effort 因此升级为 Project Management UI，提供统一页面壳层和领域模块编排，但不重新
实现 Project、Wiki、Flow、Work 或 Session 语义：

- Project selector、header、Overview、稳定导航、Settings 与响应式布局；
- Overview 中的控制仓库、Wiki、Flow blocker、WorkRun、Session、资源和活动摘要；
- 多 FlowDefinition 的管理中心、图形编辑、版本 diff、模拟与发布；
- 与 semantic definition 分离的 FlowView；
- Board、dependency、lineage、related、timeline 和进度投影；
- WorkDefinition 管理、WorkRun 观察与队列操作界面；
- 显式、无损、幂等的旧 Requirement importer 和清楚的 Legacy 边界。

Wiki 管理 API、索引任务和索引卡片行为仍属于 `wiki-system-redesign`；本 effort 只在其
最终验收并合并后，把已经成立的能力纳入统一 Project 页面，不复制实现或为其建立兼容层。
