# acceptance-N3 — 文件系统零轮询 · 测试要求

> 节点 N3 验收。对应 [plan-N3.md](plan-N3.md)。

## 完成判定
文件树/日志无周期数据拉取(打开拉一次 + 手动刷新);Cron 倒计时平滑且无 fetch。

## 组件/手动测试
1. **FileTree**:
   - 打开面板 → 拉一次;之后**不周期刷新**(network 无周期请求)。
   - 手动点"刷新" → 触发单次拉。
   - 后台写文件(工具写)→ 文件树**不自动更新**(接受);手动刷新后出现。
   - 隐藏 tab 时不拉(active-tab 检查)。
2. **LogViewer**:
   - 打开文件 → 拉一次;无 auto-refresh 周期请求。
   - 手动刷新 → 单次重读。
3. **Cron 倒计时**:
   - 倒计时每秒平滑跳动(本地时钟,无 IPC fetch)。
   - cron 记录变更(经 N1 data:changed)→ 下次触发时间更新。

## 静态检查
- `grep setInterval src/renderer/components/layout/FileTreePanel.tsx` → 0。
- `grep setInterval .../LogViewer.tsx` → 0。
- CronDashboard 的 setInterval 存在但**无 fetch**(纯 forceTick;数据走 data:changed)。

## 回归
- 文件树/日志打开、刷新功能正常(只是不再自动)。
- Cron 面板倒计时与下次触发显示正确。

## 非目标(明确不验证)
- 文件系统实时性(用户已决定放弃)。
