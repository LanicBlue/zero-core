# Research: local-backend-security-boundary

> 核对日期：2026-07-17。
> 代码事实以当前 checkout 为准；外部资料只使用规范或官方项目文档。

## 1. 当前调用链

```text
Electron main
  └─ spawnBackend()
       └─ node/electron dist/backend.js --port=0
            └─ startServer({ port, serveStatic: false })
                 ├─ Express /api/*
                 └─ WebSocketServer({ server, path: "/ws" })

Renderer
  └─ preload WindowApi
       └─ ipcMain.handle
            └─ fetch/ws http://localhost:<captured-port>
```

### 1.1 bind

- [`server/index.ts`](../../../src/server/index.ts) 最终调用 `server.listen(port)`。
- `StartServerOptions` 只有 `port` 与 `serveStatic`，没有 host/security。
- Node 官方 [`net.Server.listen`](https://nodejs.org/api/net.html#serverlisten) 说明：
  host 省略时监听 unspecified IPv6 `::`，IPv6 不可用时监听 `0.0.0.0`；多数系统上
  `::` 还可能同时接受 IPv4。
- 因此代码日志里的 `http://localhost` 只是显示文本，不是 bind 约束。

### 1.2 HTTP 与 body parser

- `express.json({ limit: "50mb" })` 在所有 router 之前安装。
- 没有 Authorization/cookie/token middleware，也没有统一 CORS/origin policy。
- Node 对 Authorization 等 header 有特殊重复处理规则；严格单一 header 校验需要读取
  `rawHeaders` 或等价原始视图，不能假定普通 headers object 保留重复项。见
  [Node HTTP message headers](https://nodejs.org/api/http.html#messageheaders)。
- 未认证调用会先进入 50 MB body parser；安全切换后 auth 必须早于大 body 解析。
- `/api/health` 会执行 SQLite integrity check 和 TEMP write probe，并返回 provider/agent
  数量、workspace 是否存在、版本与 uptime，不适合作为公开 liveness。

### 1.3 WebSocket

- 当前使用 `new WebSocketServer({ server, path: "/ws" })`，握手只检查 path。
- `ws` 官方文档建议在 HTTP server 的 `upgrade` 事件执行 client authentication，而不是
  依赖已不推荐的 `verifyClient`：
  [Client authentication](https://github.com/websockets/ws#client-authentication)、
  [`WebSocketServer` 文档](https://github.com/websockets/ws/blob/master/doc/ws.md)。
- 当前 client `new WebSocket("ws://localhost:<port>/ws")` 不带 header。
- `ws` client options 可透传 Node `http.request()` options，因此 Electron main 的
  Node client 可以使用 `Authorization` header，不需要把 token 放进 URL。

### 1.4 Electron IPC

- proxied handler 和 `window:*`、`dialog:*`、`webfetch:login` handler 都使用全局
  `ipcMain.handle`，没有校验 event。
- Electron 官方
  [Security checklist](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)
  要求默认验证 IPC sender，尤其是返回用户数据或执行 privileged action 的 handler。
- `IpcMainInvokeEvent.senderFrame` 可定位发送 frame；`WebContents.mainFrame` 提供可信主
  frame 引用：
  [`IpcMainInvokeEvent`](https://www.electronjs.org/docs/latest/api/structures/ipc-main-invoke-event/)、
  [`webFrameMain`](https://www.electronjs.org/docs/latest/api/web-frame-main/)。
- 当前主窗口已经设置 `contextIsolation:true`、`nodeIntegration:false`，但这不能替代
  privileged IPC 的 sender check。

### 1.5 secret 与比较

- Node 官方 [`crypto.randomBytes`](https://nodejs.org/api/crypto.html#cryptorandombytessize-callback)
  可生成 CSPRNG secret。
- [`crypto.timingSafeEqual`](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b)
  对相同长度 buffer 做 constant-time 比较；外层解析仍需避免把 token写入错误与日志。
- RFC 6750 定义 `Authorization: Bearer <token>` header，并明确同一请求不要同时使用多种
  token 传输方式：
  [RFC 6750 §2](https://www.rfc-editor.org/rfc/rfc6750.html#section-2)。
- 本设计借用 header 形态，不引入 OAuth server；token 是单次桌面进程的本机 bearer
  capability。

## 2. 启动、重启和更新事实

### 2.1 desktop bootstrap

- `spawnBackend()` 用随机端口启动 child。
- child stdout 发 `{type:"ready", port, pid}`。
- stdin 已用于 `{type:"shutdown"}`，但没有启动 bootstrap 消息。
- token 若进入 argv、环境变量、stdout 或 `runtime.port`，会扩大泄露面；现有 parent-child
  stdin pipe 是可复用的内存传输通道。

### 2.2 自动重启

- child 退出后 `backend-spawn.ts` 递归调用新的 `spawnBackend()`。
- main 初次启动时只调用一次 `registerProxyHandlers(port)` 和
  `connectEventBridge(win, port)`。
- proxy/WS closure 不读取更新后的 `_handle`，所以当前自动重启已经存在 stale endpoint
  风险。安全设计需要显式 connection generation，而不是只给旧函数再加一个 token 参数。

### 2.3 runtime 与 self-update

- main 把纯数字端口写入 `<ZERO_CORE_DIR>/runtime.port`。
- updater/helper 用它轮询未认证 `/api/ready` 与 `/api/health`。
- staging smoke 直接 spawn packaged backend 并调用 health。
- 最终协议可以保留一个**无 secret** runtime status 文件：由 Electron main 在使用 root
  token 验证 authenticated health 后原子发布 `pid/port/generation/startedAt/healthy`。
- 只有最小 `GET /api/live → 204` 需要免认证，供进程生命周期探测；业务 health 继续受
  auth 保护。

## 3. standalone 入口

- [`src/serve.ts`](../../../src/serve.ts) 调用无参数 `startServer()`，默认端口 3210，
  `serveStatic:true`。
- package scripts 没有 `serve` / `start`，package bin 指向 CLI；活动文档也明确它不是
  当前公开产品入口。
- 给静态浏览器安全传 root token 会引入 cookie/bootstrap/CSRF/TLS 等另一套协议。首版
  应删除/禁用该隐式 privileged server，而不是用环境变量草率恢复。
- 未来若需要远程或浏览器 standalone，应作为独立 effort 设计用户认证、TLS、origin、
  session 与 capability，不复用本设计的 desktop root token。

## 4. 测试缺口

- router unit tests 多数直接 mount 单个 Router，适合继续验证领域逻辑，但不能证明完整
  `startServer` 有 auth。
- 没有 bind address、HTTP unauthorized、auth-before-body-parser、WS upgrade auth、
  IPC forged frame、token rotation 或 secret non-leak 测试。
- `n2-runtime-push-ui.test.ts` 覆盖 WS reconnect signal，但用固定 port 且无 connection
  generation。
- self-update smoke/health 测试假设 endpoint 无认证。

## 5. 研究结论

1. 显式 `127.0.0.1` 和 bearer auth 是两层独立防线，不能二选一。
2. root token 只存在于 Electron main、backend 内存和 parent-child pipe。
3. HTTP auth 必须位于 body parser/router 之前；WS 在 upgrade 前认证。
4. Renderer 永远拿不到 root token；main 还需独立验证 IPC sender。
5. restart 必须产生新 connection generation + 新 token，并原子切换 HTTP/WS client。
6. updater 使用无 secret status/liveness；staging parent 自己持有测试 token。
7. standalone/public server 不是 desktop auth 的小变体，首版 fail closed。
