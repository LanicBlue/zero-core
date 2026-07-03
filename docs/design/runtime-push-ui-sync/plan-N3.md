# plan-N3 — 文件系统零轮询(非运行时)

> 节点 N3(无依赖)。目标:文件系统面做到 UI 零轮询;按用户决定不上 fs watcher(文件非运行时,不实时)。对应 design §7。

## 范围
- FileTree / LogViewer 移除 `setInterval`,改"打开拉一次 + 手动刷新"。
- Cron 倒计时改无 fetch 的本地时钟 timer(平滑倒计时,§9 允许的例外)。

## 实现步骤
1. **FileTreePanel**:[src/renderer/components/layout/FileTreePanel.tsx](../../../src/renderer/components/layout/FileTreePanel.tsx)
   - 移除 5s `setInterval(fetchTree)`。
   - 打开/切根目录时拉一次(pull-on-display)。
   - 加"刷新"按钮,点击触发单次 `fetchTree`(非轮询)。
   - 若组件在隐藏 tab 仍挂载,加 active-tab 检查:隐藏时不拉。
2. **LogViewer**:[src/renderer/components/common/LogViewer.tsx](../../../src/renderer/components/common/LogViewer.tsx)
   - 移除 5s auto-refresh `setInterval`。
   - 打开文件时拉一次。
   - "刷新"按钮触发单次重读;可选 tail 优化(只读追加字节)非必需。
3. **CronDashboard 倒计时**:[src/renderer/components/cron/CronDashboard.tsx](../../../src/renderer/components/cron/CronDashboard.tsx)
   - 保留 1s 本地时钟 timer(**无 fetch**,纯 `forceTick` 重算"距下次触发"),或收窄到倒计时子组件减重渲染面。
   - 数据来源(cron 记录)走 N1 的 `data:changed`(crons 表);倒计时只是本地时间换算。

## 关键文件
`FileTreePanel.tsx` · `LogViewer.tsx` · `CronDashboard.tsx`

## 不做
- 不引入 fs watcher(chokidar / fs.watch)——用户决定,文件非运行时。
- 不让文件树/日志实时反映外部写入(接受手动刷新)。

## 风险
- 用户预期:需明确"工具写文件后文件树不自动更新,要手动刷新"(可在 UI 加提示)。
- Cron 本地时钟 timer 是"零 setInterval"的合法例外(无 fetch),文档/验收已声明边界。
