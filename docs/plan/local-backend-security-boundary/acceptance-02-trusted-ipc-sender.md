# Acceptance 02：Trusted IPC Sender Boundary

对应 [Plan 02](plan-02-trusted-ipc-sender.md)。

## A. guard

- [ ] 单一 guard 同时验证 current window、sender webContents 和 exact mainFrame。
- [ ] 不只按 URL/host 字符串授权。
- [ ] 错误稳定且不泄露 frame/backend/用户数据。

## B. 覆盖

- [ ] ROUTE_MAP 全部 proxied channel 与 `app:ready` 接入。
- [ ] window、dialog、webfetch login 本地 handler 接入。
- [ ] 新增 IPC handler 的测试/约定要求默认接入 guard。

## C. 失败副作用

- [ ] child frame、其他 window、login window、webview 等 forged sender 不触发 fetch。
- [ ] 不打开 dialog/login window，不改 window，不导入 cookie。
- [ ] window recreate 后旧 frame 拒绝，新 main frame 允许。

## D. 回归

- [ ] 正常 Renderer 所有既有 IPC/E2E 行为不变。
- [ ] token/credential 没有加入 preload/Renderer/IPC 参数。
- [ ] typecheck、build:lib、unit、build、E2E、check:links 通过。

## E. 拒绝条件

- 个别 handler 忘记 guard 或在副作用后才检查。
- 用 `event.sender.getURL().startsWith(...)` 作为唯一授权。
- 为测试方便允许 null event 或全局 bypass。
