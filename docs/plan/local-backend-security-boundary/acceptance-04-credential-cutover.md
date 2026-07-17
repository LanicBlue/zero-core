# Acceptance 04：Desktop Credential Atomic Cutover

对应 [Plan 04](plan-04-credential-cutover.md)。

## A. bootstrap 与 server

- [ ] backend 在合法 bootstrap 前不打开 DB、不 listen。
- [ ] bind 精确 127.0.0.1，ready generation 与请求一致。
- [ ] `/api/live` 外的完整 production route 均在 auth + parser 正确顺序下。
- [ ] WS 只在合法 authenticated upgrade 后 connection。
- [ ] close 无遗留 socket/listener/timer。

## B. secret non-leak

- [ ] argv、env、runtime files、stdout/stderr、log、error、telemetry、Renderer/preload、
  IPC 参数和 URL 均无 root token/header/digest。
- [ ] 每代 token 不同，旧 token 对新 backend 返回 401。
- [ ] token 不通过 query/body/cookie/subprotocol。

## C. HTTP/WS main client

- [ ] 每次 IPC 调用读取 current immutable connection，不捕获首次 port/token。
- [ ] HTTP、ready 与 WS 使用同一 generation snapshot。
- [ ] stale socket/event/timer 不污染新 generation。
- [ ] restart 后 UI 自动恢复并只执行一次 resync。
- [ ] unavailable 时快速失败，不轮询旧 endpoint。

## D. runtime/update

- [ ] `runtime.status.json` 原子、无 secret，可识别 stale generation。
- [ ] active 生产代码/脚本不再读写 `runtime.port`。
- [ ] helper 只用 live/status；不能调用业务 health。
- [ ] staging parent 走正式 bootstrap/auth 并验证 health。
- [ ] status failure 明确 degraded，无 secret fallback。

## E. 负向矩阵

- [ ] missing/wrong/malformed token 对 HTTP 401 且零业务副作用。
- [ ] unauthorized large/invalid JSON 在 parser 前拒绝。
- [ ] wrong path/method/origin/token WS 不产生 connection。
- [ ] bootstrap invalid/timeout/EOF/duplicate 非零退出且不 listen。
- [ ] forged IPC sender 即使知道普通请求参数也无法触发 backend fetch。

## F. 全量验证

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run test:e2e
npm run check:links
```

- [ ] 全部成功，无 skipped/only。
- [ ] `result-04.md` 含 token rotation/restart trace、HTTP/WS 矩阵、status/updater、
  secret grep 和验收 Agent 结论。

## G. 拒绝条件

- 为兼容留下无认证业务 route 或 old port retry。
- root token 进入任何文件/Renderer/URL。
- backend restart 后需用户手工重启应用才能恢复。
- updater 通过读取 root token 或放开 `/api/health` 工作。
