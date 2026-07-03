# acceptance-N2 — UI 推送驱动 + 消闪烁 + 重连 · 测试要求

> 节点 N2 验收。对应 [plan-N2.md](plan-N2.md)。

## 完成判定
UI 数据路径**零 `setInterval` 拉取**(本地时钟例外);所有面读真源、被推送喂养;运行时/配置变更 ≤1 tick 可见;无闪烁;WS 断重连后自动恢复。

## 单元/组件测试(vitest + testing-library)
1. **task/queue store ping→pull**:
   - 模拟 `runtime:tasks:changed`(sid 在 watched)→ `pull(sid)` 被调。
   - sid 不在 watched → 不调。
   - store 内**无 setInterval**(grep/结构断言)。
2. **单消费者面**:
   - McpSettingsPage/DashboardPage/ExecutionDetailPanel/KanbanBoard:挂载拉一次;收到对应 ping/data:changed → 更新本地 state;无 setInterval。
3. **`React.memo` 行**:task 卡片/kanban 卡片 props 不变 → 不重渲染(渲染计数断言)。
4. **WikiAnchorsSection 稳引用**:`form.wikiAnchors` 为 undefined 时 `list` 引用稳定(模块级 EMPTY),effect 不在无关重渲染时重跑。
5. **重连信号**:ipc-proxy close→reconnect 后发 `ws:reconnected`;首次 open 不发。renderer 收到 → 可见 collection pull。

## e2e / 手动
- **task 树**:委派子代理 → turns/tokens/status 跳变**无布局抖动**(不闪);切走 chat 面板 → 无 runtime:tasks 拉取(看 network)。
- **Injection preview**:wiki 配置不动 → 不闪;改 anchor → 300ms 平滑刷新(token 行不消失)。
- **Kanban/ExecutionDetail**:无周期轮询;后端写 plan/step → 1 tick 内更新。
- **会话列表**:后台建会话(cron/委派)→ 侧栏立刻出现。
- **重连**:手动断 backend WS(如 kill -STOP/重启 backend)→ 重连后可见面自动重拉,状态恢复一致。
- **agents/projects/crons/requirements**:增删改 → 列表增量更新(不再靠轮询)。

## 覆盖度(对应不变量)
- 不变量 2:稳态下各面无周期性重绘(Profiler/目测)。
- 不变量 3:运行态变更(task/mcp/metrics/queue/confirm)≤1 tick 反映到可见 UI。

## 静态检查
- `grep -r "setInterval" src/renderer` 数据路径为 0(CronDashboard 本地时钟 timer 例外,且无 fetch)。

## 回归
- chat 流式(text_delta/tool_*/usage)不受影响(走 agent:event,未动)。
- 现有 e2e(work-jump 等)全绿。

## 风险关注
- pull/push 竞态:切换 session 偶发"显示旧值"→ 护栏测试。
- 重连误触发:首次连接不应触发全量重拉(只 close→reconnect 触发)。
