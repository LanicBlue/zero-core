# Plan:Task 视图简化(3 sub)

> 来源:用户直接提出(不走 issue/design,需求已明确)。19:40 后随 tool-rename 之后按序执行。
> 每个 sub 独立验收(tsc + vitest 绿才进下一个)。

诊断依据(代码事实):
- 中间栏 = TaskTreePanel(任务列表);右栏 = TaskDetailView(任务详情,被 DocViewerPanel 嵌入)。
- TaskTreePanel.tsx:101 列表项显示 `t.task`(任务文本);`RuntimeTaskInfo` 已带 `turns/tokens/currentTool`(shared/types.ts:289-291),无需额外取数。
- TaskDetailView.tsx 上=metadata、下=对话(重复主聊天)、中间可拖 splitter(line 36/63-85/109-119)。
- MiddlePanel.tsx:85 splitter 只在"原始顺序相邻且都 open"段间;wiki 折叠 → workspace/tasks间断链。

---

## sub-1:中间栏 task 列表显示 metadata(非内容)

**文件**:`src/renderer/components/layout/TaskTreePanel.tsx` + `src/renderer/styles/global.css`

**改动**:
- line 101 `<span className="task-card-task">{t.task...}</span>` → 改为 metadata 行:`turns`、`tokens`、`currentTool`(status icon line 99 + type line 100 保留)。
- 任务文本不再占行,仅靠 `title={t.task}`(line 90 已有)tooltip + 右栏显示。
- CSS `.task-card-row` 调整为容纳新字段(status icon + type + turns + tokens + tool),紧凑。

**验收**:
- [ ] 列表项显示 status / type / turns / tokens / currentTool,不显示 task 文本。
- [ ] tooltip 仍含完整 task 文本。
- [ ] `npm run build:lib` + `vitest` 绿。

---

## sub-2:右栏 TaskDetailView 留对话,删顶部 metadata pane + 去两栏

> 分工:metadata 摘要在中间栏列表(sub-1);右栏专心显示委派 session 的对话(与主聊天是不同 session,不算重复)。

**文件**:`src/renderer/components/layout/TaskDetailView.tsx` + `global.css`

**改动**:
- 删顶部 metadata pane(`<div className="task-detail-pane">` 的 `<dl className="task-detail-grid">`,line 91-108)+ splitter(line 109)。
- **保留** conversation pane(line 110-119),占满整个 view(去 `flex: ${2-detailWeight}`,改单栏填满)。
- 删 `detailWeight` state(line 36)+ `startDrag`(line 63-85)(无两栏了)。
- `messages` fetch(line 50-52)+ `MessageRow`/`ChatMessage` import **保留**(对话要用)。
- `record` fetch(line 46-48)保留(avatarLetter 用 `targetAgentId`);若确认无其它字段消费可简化,默认保留。
- CSS:`.task-detail-view` 去上下分栏;`.task-detail-conversation` 填满。

**验收**:
- [ ] 右栏只剩对话 pane,无顶部 metadata、无 splitter。
- [ ] 对话(MessageRow)正常渲染,占满右栏。
- [ ] `npm run build:lib` + `vitest` 绿。

---

## sub-3:wiki 折叠时 tasks 仍可调

**文件**:`src/renderer/components/layout/MiddlePanel.tsx`

**改动**:
- line 85 splitter 逻辑:从"原始顺序相邻且都 open"改为"**连续 open 段**之间"(跳过中间折叠段)。
- 实现:遍历 SECTIONS,维护"上一个 open 段";当前段 open 且存在上一个 open 段时,在两者间插 splitter(无论中间是否有折叠段)。折叠 wiki 时 workspace↔tasks 间出现 splitter。
- `startDrag(a,b)` 已支持任意两段 id,无需改;只需正确配对 open 段。

**验收**:
- [ ] wiki 折叠 + workspace/tasks 展开 → 两者间有 splitter,可拖动调高。
- [ ] wiki 展开时原有 workspace/wiki、wiki/tasks splitter 不变。
- [ ] 折叠中间段不影响其余 open 段间的可调性。
- [ ] `npm run build:lib` + `vitest` 绿。

---

## 执行顺序

tool-rename(sub-B → sub-D)完成并提交后,回到 master,建 branch `task-view-simplification`,按 sub-1 → sub-2 → sub-3 顺序实施+验收,各 commit,不合并 master(待用户同意)。合并后归档。

## 风险
- sub-2 保留 MessageRow/messages fetch;确认 `record` fetch 删 metadata 后仍被消费(avatarLetter 用 targetAgentId),否则连 record fetch 一起简化。
- sub-3 拖拽权重:跳过折叠段时 `totalOpen`/权重计算仍按 open 段集合,行为应与现状(全 open 时)一致。
