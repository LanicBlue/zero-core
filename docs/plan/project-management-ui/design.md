# Design：Project Management UI

本设计服从跨 effort 的
[Agent Project Automation 架构合同](../agent-project-automation.md)，消费已经合并的
[`wiki-system-redesign`](../wiki-system-redesign/README.md)、
[`project-flow-system`](../project-flow-system/README.md) 与
[`agent-work-runtime`](../agent-work-runtime/README.md) 公开 API。

## 1. 代码基线与改造原则

设计时核对的当前源码事实：

- `src/renderer/components/requirements/ProjectPage.tsx` 是 975 行单体组件；
- 页面左栏是 220px 固定 Project 列表，右栏为 Dashboard、Project View、Worker、Kanban；
- 页面、Project list 和 tab body 依赖内联 style，当前没有统一 breakpoint 或布局 token；
- Project selection 只是组件本地 state，删除操作位于全局 tab strip；
- Dashboard/Project View 重复显示 Wiki、Requirement、Session 等摘要；
- Project Work 的配置、触发器、Agent 分配和多个 modal 也直接内嵌在该文件；
- `wiki-system-redesign` Plan 07 会在 Project 页面交付 Wiki 索引卡片。

应用主窗口默认 `1400 × 900`、最小 `900 × 600`；Icon Sidebar 占 48px。因此 Project 页
实际可用宽约为 1352px/852px，而不是完整窗口宽。布局验收必须使用这两个真实边界，并增加
`1024 × 768` 标准窗口。

实施必须从 Wiki Final 合并后的真实页面开始，不能按上述旧行号机械重写。改造采用
strangler 方式：先建立 Project 页面壳层和模块边界，再逐个迁入 Flow/Work/Legacy。
任何阶段都不能出现第二个 Project selector、第二套 Wiki 管理状态或持久化的 UI 真相源。

## 2. 页面信息架构

Project 是一级工作上下文，页面采用稳定的「Project selector + Project workspace」：

```text
Project Management
├── Project selector
└── Selected Project
    ├── Header：identity / workspace / repository / control health / primary actions
    ├── Overview：attention / health / recent activity / resource summary
    ├── Flows：Instances / Definitions / Relations / Timeline
    ├── Work：Definitions / Runs / Queue
    ├── Wiki：已合并的 Project Wiki management + Open Wiki
    └── Settings：registration / workspace / control status / danger zone
```

旧 Requirement/Kanban 只在仍有 legacy 数据或迁移权限时显示为 `Legacy Requirements`，
不与新 Flow state 混成同一个 Board。Importer 从该入口或 Flows 入口显式启动。

Project selection 与当前 section 必须进入可恢复的 navigation state（route/deep link 或
等价 PageStore 合同），刷新、返回、重连和打开实体链接后不应无条件跳回第一个 Project。
窄窗口下 Project selector 可折叠或变成 drawer，但 selected Project identity 始终可见。

## 2.1 全局布局与容量合同

### Shell 线框

```text
┌ Project context bar：selector toggle / identity / health / primary actions ┐
├ Project rail ───────┬ Selected Project workspace ───────────────────────────┤
│ search/create       │ Header：name / workspace / repository / health       │
│ project rows        ├ Overview | Flows | Work | Wiki | Settings             │
│                     ├ optional module toolbar / breadcrumbs                 │
│                     │ module content                                        │
│                     │                                                       │
└─────────────────────┴───────────────────────────────────────────────────────┘
```

`Project context bar` 与一级 navigation sticky；selected Project name 在 selector drawer
关闭后仍可见。Project rail 只负责切换 Project，不重复模块导航。

### Breakpoint

断点以 Project page 可用宽计算：

| 可用宽 | Project selector | Workspace |
|---|---|---|
| `≥1180px` | 248px persistent rail，可手动收成 56px | shell/content 正常模式 |
| `900–1179px` | 默认 56px compact rail；点击打开 280px overlay drawer | 不被 drawer 永久挤窄 |
| `<900px` | 仅 context bar selector button；drawer 最大 320px | 单列/双栏降级，禁止页面横向滚动 |

`900 × 600` 主窗口对应约 852px 可用宽，必须走 `<900px` 合同。Definition Studio 与关系图
可请求 shell `focus mode`，把 persistent rail 收成 56px；不能隐藏 Project identity 或创建
第二个 selector。

### 尺寸与滚动所有权

- context bar 56px；一级 navigation 40px；可选 module toolbar 48px；
- workspace content padding：宽屏 20px，标准 16px，compact 12px；
- Project rail、module content、detail drawer 各自最多一个纵向滚动；
- 普通页面只允许 module content 作为主滚动；card/list 内不随意增加嵌套滚动；
- Board 允许语义明确的横向列滚动；Graph canvas 使用 pan/zoom；其他页面不得产生横向页面
  scrollbar；
- header/navigation 不因 module 内容增长离开视口；deep link 打开 drawer 后关闭应恢复原
  scroll/focus；
- 长表格使用 server pagination 或 virtualization，sticky toolbar/header 不能覆盖首行。

### 信息密度与文本

- 基础字号不小于 12px；不能靠压到 10px 容纳操作；
- Provider/Project/Definition/Flow/Work 名称按 60 字符和中英文混排验收；
- workspace path/repository URL 按 200 字符验收，单行 ellipsis，完整值可复制/读取；
- 主操作和状态永不因窄屏消失；低频操作进入有 label 的 overflow menu；
- 状态不只依赖颜色；badge 同时有文字/icon/accessible name；
- 空、loading、局部 error、access denied、stale revision 占用稳定区域，不能让页面大幅跳动。

### Drawer、dialog 与完整页面

- detail/inspection 使用右侧 drawer：宽屏 480px，标准 420px，compact 占可用宽；
- destructive confirmation 使用不超过 480px dialog；长 diff、graph、import preview 不塞进
  modal，使用完整 route/workspace；
- drawer 可独立滚动，关闭后焦点回触发项；URL/deep link 可恢复当前 entity/drawer；
- unsaved draft 阻止无提示离开，但不能用浏览器原生 confirm 替代可测试的产品交互。

## 3. Project 页面壳层与模块合同

壳层拥有：

- Project 列表、选择、create/register 入口和空状态；
- Project header、一级 section navigation、面包屑/deep link；
- 页面级 loading/error/reconnect/access-denied 边界；
- Overview 编排、响应式布局、焦点和键盘导航；
- Project Settings 与 Project-level destructive action 的集中危险区；领域级操作仍留在
  对应模块；
- 模块可用性、未安装前置、只读和 legacy 标识。

领域模块拥有自己的 query、mutation、授权错误和详情视图。壳层通过类型化 registry 或
等价静态组合合同装配模块，不能执行任意项目代码，也不能成为插件运行时：

```text
ProjectManagementModule
  id / label / order
  availability(ProjectCapabilities)
  routes
  overviewContributions?
  render(ProjectUiContext)
```

`ProjectUiContext` 只提供稳定 projectId、navigation、refresh signal 和 server 注入的
capability/read model；不提供可伪造 actor/admin。各模块不得直接读取其他模块 store 的
私有 state。

## 4. Overview 是展示投影

Overview 优先回答「现在需要注意什么」，而不是把所有详情缩成一个大容器视图：

- control repository / workspace / repository binding 健康；
- Wiki sync/revision/error；
- Flow blockers、terminal/abandoned 和最近 transition；
- queued/running/waiting/failed WorkRun（Agent Work Runtime Final 后启用）；
- 当前可用的 Session 摘要；Session Lifecycle 合并后再呈现 running/waiting/compacting；
- token/cost 与最近活动。

Overview read model 可以由 renderer query composition 或服务端只读 projection 提供，但
必须保留每个 contribution 的 source、freshness、loading/error。它不持久化综合状态，
不跨领域执行 mutation，也不把多个不同时间点的摘要伪装成原子业务快照。点击卡片进入
对应模块的可复现筛选视图。上游能力尚未合并时，contribution 必须缺席或明确显示
`unavailable: prerequisite not met`，不能用 mock、空数组或旧 schema 冒充真实零值。

Overview 使用 12-column grid，不做“每个领域一张无限增长卡片墙”：attention/activity 是
有上限的摘要列表，health/resource/Wiki/Session contribution 使用稳定占位高度，更多内容
通过 deep link 进入领域页面。详细列宽、容量和三档视口见 Plan 01。

## 5. Wiki 与其他上游的所有权

`wiki-system-redesign` 继续拥有 Wiki admin/data API、repository binding、sync/reindex
job、状态语义、权限和 Project Wiki 卡片的领域行为。本 effort 在合并后：

- 复用或提取其真实组件到 Wiki section 和 Overview contribution；
- 保留 Validate、Full reindex、Open Wiki、job retry 和持久进度行为；
- 不复制 API、不建立旧 Wiki fallback、不通过页面关闭取消 server job；
- 不修改 Wiki 的 authority、revision 或 canonical path 规则。

Project Flow System 拥有 Flow semantic API；Agent Work Runtime 拥有 WorkDefinition/
WorkRun runtime API；Session Lifecycle 拥有 Session 状态。Project Management UI 只拥有
这些领域的呈现和用户交互。

## 6. Definition Studio

Flows section 提供 Definition Catalog：每个 definitionId 显示 active version、历史版本、
实例数和关系 policy。一个 Project 可同时激活多个 Definition，并显式选择可选 default。
引用它的 Work trigger 在 Plan 04 读取真实 WorkDefinition API 后加入；此前显示未知/前置
未满足，不能显示为零引用。

编辑采用持久 draft：

```text
draft.save → validate → publish immutable version → activate selected binding
```

draft 不是 runtime truth；保存到 `.zero-core/flow/drafts/`，运行时忽略。发布必须经过与
Project config 相同的服务端 validator，UI 不能复制另一套校验器。

Studio 包含 state/transition 图、属性面板、documents/milestones/gates/composition policy
表单、版本 diff 和 transition simulator。编辑器不得把 default delivery 状态写成 renderer
union。

Studio 使用 shell focus mode 的 `Catalog + canvas + Inspector`，diff 使用完整 route，
simulator 使用 drawer；不能把 graph、全部表单、source 和 diff 同时平铺。详细尺寸见
Plan 02。

## 7. FlowView、关系与进度

semantic FlowDefinition 与展示配置分离：

```text
FlowView
  viewId / flowDefinitionId / revision
  state labels / colors / groups / preferred order
  graph layout hints
  progressProjection?
```

FlowView 不进入 FlowInstance semantic digest，也不改变 allowed transition、gate 或 event。
激活新 view 可立即改善全部相关实例的展示；缺失/过期 view 时使用稳定通用布局。

UI 提供可切换图层：

- Board：按 definition + state 分组；
- Dependency Graph：只显示阻塞边、milestone、传递 blocker 与 downstream impact；
- Lineage Graph：只显示 split/merge source/target；
- Related Graph：只显示非阻塞上下文关系；
- Timeline：显示 transition、返工、废案、relation 和 document revision；Plan 04 再接入
  真实 WorkRun。

默认不把三种关系画进同一无差别图。跨 Project target 使用可展开 portal node；未授权目标
只显示不可解析外部引用，不泄露内容。

Flow 可返工和循环，因此核心不提供通用百分比。默认进度由 current state、allowed next
transitions、milestones、blockers、WorkRuns、composition summary、last activity 与
terminal outcome 派生。只有 FlowView 显式定义 ordered stages 或 milestone weights 时
才显示百分比，并标注为 presentation projection；它不能写回 FlowInstance 或参与 gate。

Board、三类 Graph 与 Timeline 共用 view switch/filter/deep link。Board 只拥有语义横向
滚动，Graph 只拥有 pan/zoom；详情统一进入 shell drawer。大图必须局部查询/展开，不能为了
“全量可见”把 1,000 节点缩成不可读缩略图。详细容量见 Plan 03。

## 8. Work 与 WorkRun

Work section 区分两个层次：

- Definitions：通过 Project 管理能力编辑 WorkDefinition、trigger、Agent/Session 策略；
- Runs/Queue：通过 Work runtime API 查看、筛选和操作 WorkRun。

UI 不把旧 `project-work` schema 当作长期兼容合同。Agent Work Runtime Final 后先读取其
真实 result 和 schema，再迁移现有 Worker tab。配置 mutation 与 queue mutation 分别遵守
Project/Work 能力和 expected revision，不因 UI 合并而放宽权限。

Definitions、Runs、Queue 使用稳定二级导航；list/table 负责扫描，480px drawer 负责执行
关联和 mutation。表格在 compact 窗口折叠次要列，而不是产生页面横向滚动。详细布局见
Plan 04。

## 9. Importer 与 Legacy

旧 Requirement 只通过用户显式 preview/execute 导入。import 复制正文并记录 provenance，
不删除、改状态或双写旧数据。Legacy Requirements 页面清楚显示它不是新 Flow 数据源；
何时只读或删除旧 UI/API 仍由用户后续决定。

Importer 是可恢复的完整 route/stepper，不是临时 modal。Select/Map、Preview、Execute、
Verify 各自有稳定布局与 sticky action，长 diff/冲突进入 drawer。详细布局见 Plan 05。

## 10. 不变量

- renderer 不保存 Project/Flow/Work/Wiki 业务真相或固定 Flow state union；
- Project shell 不重写领域 validator、权限、revision 或 job lifecycle；
- Overview failure 不能使其他可用模块不可访问；
- destructive actions 不放在高频导航条，必须显示影响并明确确认；
- 页面重构期间不引入 Wiki、Requirement、Flow 或 Work 双写；
- 每个模块可以独立加载、失败、重试和深链接。
- selected Project identity、当前 section 和主操作在三档视口始终可达；
- 除 Board 横向 viewport 与 Graph pan/zoom 外，不允许页面横向滚动；
- Project rail、module content、drawer 和语义 canvas 的 scroll owner 不互相接管；
- 新模块复用 shell layout token 和 drawer/dialog，不回到每页一套 inline geometry。
