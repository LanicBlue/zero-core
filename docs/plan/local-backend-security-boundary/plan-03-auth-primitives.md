# Plan 03：Local Auth、Bootstrap 与 Connection 原语

## 目标

在不切换生产调用链的前提下，实现并独立验证 token、bootstrap、HTTP auth、WS upgrade
和 BackendConnection generation 原语，为 Plan 04 一次性切换做准备。

## 依赖

Acceptance 01–02 通过。

## 实施范围

### 1. token primitive

- `randomBytes(32)` + base64url；
- 严格 Bearer header parser；
- SHA-256 digest + `timingSafeEqual`；
- token/generation 类型不混用；
- sanitizer 删除 Authorization 和 token-like diagnostic field。

测试：

- token 解码后精确 32 bytes，重复样本唯一；
- missing/wrong scheme/whitespace/duplicate/malformed/empty 拒绝；
- query/body/cookie 不被 parser 接受；
- 长短输入不抛未处理异常；
- error/log snapshot 无 secret。

禁止在测试中使用生产固定 token 常量；fixture token 每 test 生成或显式标为纯 unit
non-production value。

### 2. bootstrap protocol

实现可独立测试的 line protocol reader/state machine：

```text
awaiting-bootstrap → accepted → running → shutting-down
                  → rejected
```

- 首条必须 `bootstrap protocol:1`；
- 限制 line bytes 和 deadline；
- token/generation/schema 校验；
- duplicate、unknown first message、EOF、timeout 拒绝；
- accepted 后才把 security config 交给 server factory；
- ready serializer 只输出 protocol/generation/port/pid。

用 fake stream 测 chunk boundary、多行同 chunk、partial line、oversize 和 secret
non-echo。

### 3. HTTP auth middleware

独立 Express fixture 验证：

- `/api/live` 精确 bypass；
- 其他 path/method 缺 token/错 token 401；
- 正确 token 到达 downstream；
- auth 安装在 JSON parser 前，未认证 50 MB/invalid JSON 不进入 parser；
- `Cache-Control:no-store`；
- downstream error 不带 Authorization。

production `startServer` 本阶段不启用 middleware，避免形成 main 未发送 credential 的半
切换。

### 4. WS upgrade gateway

使用 `WebSocketServer({noServer:true})` fixture：

- exact `/ws`、GET、无 Origin、正确 auth 才 `handleUpgrade`；
- missing/wrong token、wrong path/method、unexpected Origin 在 connection 前拒绝；
- 显式 maxPayload fixture；oversize 行为可判定；
- 不使用 `verifyClient`；
- client header 不在 URL/subprotocol。

### 5. BackendConnectionManager

实现纯 main-side state primitive：

```text
empty → starting(generation) → ready(connection)
                           ↘ failed
ready(old) → starting(new) → ready(new)
```

- immutable snapshot；
- generation compare-and-set，旧 ready/exit 事件不能覆盖新状态；
- subscriber 在 connection changed 时收到一次通知；
- secret 不进入 public/status projection；
- request 在 unavailable 时快速失败。

本阶段用 fake supervisor/client 测，不接生产 IPC proxy。

### 6. runtime status primitive

- schema/validator；
- temp + atomic replace；
- public projection 排除 token/authorization；
- stale generation/startedAt 判定；
- write/rename/delete 故障矩阵。

## 完成定义

[Acceptance 03](acceptance-03-auth-primitives.md) 通过并创建 `result-03.md`。
