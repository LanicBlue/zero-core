# Acceptance 01：Loopback Bind 与 Surface Reduction

对应 [Plan 01](plan-01-loopback-surface.md)。

## A. bind

- [ ] 生产 server 只绑定字面量 `127.0.0.1`。
- [ ] host 省略、hostname、`::`、`0.0.0.0` 和任意外部地址不能进入生产 start path。
- [ ] bind 失败不降级，日志反映实际 address 且不泄露 secret。

## B. liveness

- [ ] GET/HEAD `/api/live` 返回空 204。
- [ ] liveness 不访问 DB/Store/Agent，不返回版本、路径、计数、pid 或 uptime。
- [ ] 其他 unauth surface 没有在本阶段扩大。

## C. standalone removal

- [ ] `src/serve.ts`、`serveStatic` 和 static server branch 已删除。
- [ ] package scripts/bin/build/docs 无悬空入口。
- [ ] 无参数 `startServer()` 不能启动 privileged server。

## D. 回归

- [ ] desktop backend、IPC HTTP、WS 和 UI E2E 仍可用。
- [ ] typecheck、build:lib、unit、build、E2E、check:links 通过。
- [ ] `result-01.md` 包含 bind address、live probe 和 grep 证据。

## E. 拒绝条件

- 日志写 localhost，但实际仍绑定 unspecified。
- 以 OS firewall 或随机端口代替显式 host。
- 为保留 `serve.ts` 增加无设计的环境 token/static cookie。
