# Plan 04：Desktop Credential Atomic Cutover

## 目标

一次性把 production backend、Electron main HTTP/WS、自动重启和 self-update 切到新
security protocol。阶段结束时不存在旧无认证业务 route、固定 port closure、
`runtime.port` 或 secret fallback。

## 依赖

Acceptance 01–03 通过。

## 实施范围

### 1. backend child

- `backend.ts` 启动先读取 bootstrap，再构造 DB/server。
- `startServer` 必须收到 `{host,rootToken,generation}`。
- ready stdout 只有 protocol/generation/port/pid。
- shutdown 与 bootstrap 共用受限 control reader，不重复创建 stdin readline。
- bootstrap 失败按设计非零退出，不能继续无认证启动。

### 2. server

原子接线：

```text
/api/live
→ local auth middleware
→ express.json
→ all API/ready/health routers
```

- 全部现有与 Wiki 新增 routes 自动位于 middleware 后。
- `/api/ready`、`/api/health` 正确 token 可用；缺失/错误 401。
- WS 改 noServer upgrade gateway。
- server close 同时关闭/终止 WS clients，不留下监听资源。
- 选定并记录实际 maxPayload；若关闭 per-message deflate，补回归证据。

### 3. Electron backend supervisor

- 每次 spawn 生成新 token/generation。
- token 经 stdin bootstrap；不进 child argv/env。
- ready 的 generation 不匹配则 kill/reject。
- `BackendConnectionManager` 成为 port/token/status 唯一 main 真相源。
- `_handle` 与 public connection 更新在同一 generation 检查下。
- child exit 立即 invalid 当前 connection，再按既有 backoff 重启。

### 4. HTTP IPC proxy

- `registerProxyHandlers` 不再接受/capture port。
- 每次调用先通过 Plan 02 sender guard，再读取 current connection snapshot。
- fetch 使用 `127.0.0.1` endpoint 和 Authorization header。
- body/header/error/log sanitizer 不泄露 token。
- unavailable/stale generation 返回稳定 backend-unavailable，不向旧 port 重试。
- `app:ready` 也走 authenticated ready。

### 5. WebSocket event bridge

- 从 current connection snapshot 创建 client，并以 header 发 token。
- generation change 关闭旧 socket/timer，连接新 endpoint。
- 旧 socket 的 late open/message/close 不得改变新 generation 状态或向 Renderer发事件。
- 新 generation open 后只发一次 `ws:reconnected` / resync。
- shutdown/window destroy 清理 reconnect timer。

### 6. runtime status

Electron main：

1. current connection ready；
2. 用 current token 调 `/api/health`；
3. 成功后原子写 `runtime.status.json healthy:true`；
4. generation unavailable/stopping 时写 degraded 或删除；
5. 不序列化 root token/header/digest。

同阶段删除 `runtime.port` 的生产写入与读取，不保留双读 fallback。

### 7. self-update

同步修改：

- `self-update.cjs` wait-for-quit 从 status 取 port，只调用 `/api/live`；
- helper relaunch 记录 relaunch time，等待更新后的 generation/startedAt +
  `healthy:true` status；
- helper 不调用 authenticated `/api/health`，也不读取 token；
- staging smoke parent 生成测试 token，写 bootstrap stdin，带 Authorization 调 health；
- update log/result/swap/status 均通过 secret grep。

若 runtime status 写失败，桌面继续运行但 update health 显示 degraded；不得把 token 写盘
作为 fallback。

### 8. 测试

必须包含实际 production composition 的 integration/E2E：

- initial desktop start；
- authorized IPC/API/WS；
- curl/fetch 无 token、错误 token、query token；
- 50 MB parser 前拒绝；
- backend crash → old unavailable → new generation/port/token → UI resync；
- stale old socket/message/ready/exit；
- status write failure/stale file；
- staging smoke 与 helper success/rollback；
- dev/packaged test fixture bootstrap。

## 完成定义

[Acceptance 04](acceptance-04-credential-cutover.md) 由非主要实现 Agent 验证，通过并创建
`result-04.md`。
