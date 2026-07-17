# Design: local-backend-security-boundary

> **状态**：设计已于 2026-07-17 经用户确认；Ready，尚未实施。
> **日期**：2026-07-17。
> **问题**：[issue.md](./issue.md)。
> **研究**：[research.md](./research.md)。

## 0. 结论

zero-core 的桌面后端改为一个明确的本机私有服务：

1. 只绑定 IPv4 loopback `127.0.0.1`。
2. Electron main 每个 backend generation 生成新的 256-bit root token。
3. token 通过 parent-child stdin bootstrap 传给 backend，不进入 argv、env、Renderer、
   磁盘、stdout 或日志。
4. 除最小 `/api/live` 外，所有 HTTP route 在 body parser 前验证
   `Authorization: Bearer <token>`。
5. `/ws` 使用 `noServer` + HTTP `upgrade`，在创建 WebSocket 前验证 path、method、
   Origin policy 和同一 bearer token。
6. Electron main 用动态 BackendConnection generation 访问 HTTP/WS；后端崩溃重启时
   原子切到新 port/token，旧 generation 失效。
7. 所有 Renderer → main privileged IPC 先验证发送者是当前主窗口 main frame。
8. self-update 通过无 secret runtime status 和最小 liveness 工作；业务 health 保持
   authenticated。
9. 无公开入口的 standalone `serve.ts` 退出首版支持范围；未来远程/server 模式另行设计。

这套边界不增加用户审批，也不改变 Agent 的工具权限。它约束的是进程之间的访问，不是
Agent 工作流。

## 1. 威胁模型

| 调用者 | 首版处理 |
|---|---|
| 局域网/其他网卡上的进程 | `127.0.0.1` bind 使其不可连接 |
| 同机但不知道 token 的普通进程 | HTTP/WS bearer auth 拒绝 |
| 浏览器页面、iframe、webview | 无 root token；privileged IPC 还需 main-frame sender check |
| 正常 Electron main | 持当前 generation token，可调用 |
| self-update helper | 只读无 secret liveness/status，不能调用业务 API |
| staging smoke parent | 自己生成并通过 pipe 传测试 token，可调用 authenticated health |
| 未来 external MCP client | 使用独立短期 scoped token；本 effort 不实现 |
| 同一 OS 用户下能读/改进程内存、注入进程或替换安装文件的攻击者 | 超出首版本地 bearer 边界 |
| 已被用户授权 Shell 的可信 Agent | trust-first 不变；不新增逐次确认 |

## 2. 不变量

1. **Bind 与 auth 双重成立。** 只有 loopback 或只有随机 token 都不算完成。
2. **Renderer 不持 secret。** preload API、IPC 参数、window 全局、DevTools、URL 和
   localStorage 都不出现 root token。
3. **磁盘不持 root secret。** runtime/status/update 文件只包含非敏感连接状态。
4. **先认证，后解析。** 未认证大 body 不进入 50 MB JSON parser 或业务 router。
5. **HTTP 与 WS 同源认证。** 不存在“REST 已保护但 `/ws` 可直连”的旁路。
6. **每代轮换。** 每次 backend spawn/restart 使用新 port、token 和 generation。
7. **切换原子。** main 的 HTTP、ready poll 与 WS 使用同一 BackendConnection snapshot。
8. **IPC 另设边界。** root token 不替代 Electron sender validation。
9. **公开 liveness 最小。** unauthenticated endpoint 不读 DB、不返回版本、路径、计数或
   uptime，不执行写 probe。
10. **无兼容后门。** 不保留 query token、cookie token、旧无认证 WS、`localhost`
    fallback 或 hidden feature flag。
11. **未来 scoped token 正交。** external MCP 不得获得或复用 desktop root token。

## 3. 组件

```text
Electron main
├── TrustedIpcSender
├── BackendSupervisor
│   ├── randomBytes(32) → generation token
│   ├── spawn child
│   └── stdin bootstrap
├── BackendConnectionManager
│   └── { generation, endpoint, authHeader, status }
├── IPC → authenticated HTTP proxy
├── authenticated WS event bridge
└── RuntimeStatusPublisher
    └── runtime.status.json（无 secret）

Backend child
├── BootstrapReader（启动前、限长、超时、一次）
├── LocalAuth（token digest + header validator）
└── startServer
    ├── bind 127.0.0.1
    ├── GET /api/live → 204（唯一 unauth route）
    ├── auth middleware
    ├── JSON parser + /api/* + /api/health
    └── upgrade /ws → auth → WebSocketServer.handleUpgrade
```

## 4. ServerSecurityConfig

`startServer` 不再有可启动 privileged server 的安全默认值：

```ts
const LOCAL_BACKEND_HOST = "127.0.0.1" as const;

interface ServerSecurityConfig {
  mode: "desktop-private" | "test";
  host: typeof LOCAL_BACKEND_HOST;
  rootToken: string;
  generation: string;
}

interface StartServerOptions {
  port: number;
  security: ServerSecurityConfig;
}
```

- 生产只允许 `desktop-private`；`test` 也必须显式 token。
- 不接受 `0.0.0.0`、`::`、hostname 或调用者任意字符串。
- `port:0` 继续使用 OS 随机端口，但只是分配机制，不是认证。
- 删除 `serveStatic` 和无参数 `startServer()`。
- `src/serve.ts` 及其活动文档入口删除；`src/backend.ts` 是完整 server 的唯一生产入口。
- router unit test 可以继续单独 mount Router；完整 server integration 必须使用 security
  config。

## 5. Root token 与 bootstrap

### 5.1 生成

- Electron main 在每次 spawn 前调用 `randomBytes(32)`，编码为 base64url。
- generation 使用独立随机 id；它不是 credential，可以出现在 status/日志。
- token 只保存在当前 BackendConnection 的 main 内存和 backend LocalAuth 内存。

### 5.2 parent-child 协议

```text
main spawn child --port=0
main → child stdin:
  {"type":"bootstrap","protocol":1,"generation":"...","token":"..."}

child validates → startServer(...)
child → main stdout:
  {"type":"ready","protocol":1,"generation":"...","port":12345,"pid":...}
```

规则：

- child 在收到合法 bootstrap 前不打开数据库、不监听端口。
- 首条控制消息必须是 bootstrap；限制单行字节数和等待时间。
- token/协议错误、重复 bootstrap、EOF 或 timeout 都非零退出。
- ready 必须回显 generation，但绝不回显 token/header。
- 后续 stdin 只接受 shutdown 等已知 control message。
- token 不通过 argv/env/临时文件/IPC 到 Renderer。

## 6. HTTP 认证

唯一接受形式：

```http
Authorization: Bearer <base64url-token>
```

- 不接受 query、form/body、cookie、WebSocket subprotocol 或 URL credential。
- parser 严格校验单一 scheme/token；错误统一 `401`，不回显输入。
- Node 会特殊处理重复 Authorization header；实现必须检查 `rawHeaders`/等价原始 header
  视图，不能只读已经去重的 `req.headers.authorization` 后误把重复输入当成单一 header。
- backend 收到 token 后立即保存 SHA-256 digest 并丢弃原始值；请求 token 同样 hash 后使用
  `timingSafeEqual` 比较固定长度 digest。
- auth middleware 安装在 `express.json()` 和所有业务 router 前。
- 响应增加 `Cache-Control: no-store`；日志、telemetry 和错误 sanitizer 永远删除
  Authorization。
- auth 失败不触发 DB、Store、Agent、文件或 body parser。

首版不在 loopback 上增加 TLS：连接双方都属于同一桌面应用、server 只绑定
`127.0.0.1`、token 每代轮换且不离开内存。这个决定不适用于 remote/standalone；一旦
允许跨主机连接，bearer token 必须使用 TLS 和新的用户认证设计。

### 6.1 liveness 与 health

```text
GET /api/live    # unauthenticated, 204, empty body
GET /api/ready   # authenticated
GET /api/health  # authenticated, existing business probe
```

`/api/live` 只证明该端口存在当前进程，不读取业务状态。所有现有 ready/health 内容继续
受 auth 保护。

## 7. WebSocket 认证

- 改为 `WebSocketServer({ noServer:true, ... })`。
- `server.on("upgrade")` 只允许：
  - method `GET`；
  - exact pathname `/ws`；
  - desktop-private 模式下无浏览器 `Origin`；
  - 当前 bearer token 有效。
- 任一失败在 upgrade 前返回最小 HTTP error 并 destroy socket，不发 `connection`。
- main 的 Node `ws` client 用 options header 发送 Authorization，不把 token放进 URL 或
  subprotocol。
- `maxPayload` 必须显式设定。Plan 00 先记录实际最大事件/fixture，再选有余量的界限；
  不继续依赖 `ws` 默认 100 MiB。
- 是否禁用 per-message deflate 由 Plan 00 基线确认；若当前消息没有依赖，首版关闭以减少
  状态和压缩攻击面。

## 8. BackendConnection generation

```ts
interface BackendConnection {
  generation: string;
  endpoint: `http://127.0.0.1:${number}`;
  wsEndpoint: `ws://127.0.0.1:${number}/ws`;
  credential: BackendCredential; // opaque, main-private, non-serializable/redacted
  status: "starting" | "ready" | "stopping" | "failed";
}
```

- `BackendSupervisor` 是 generation 的生产者。
- `BackendConnectionManager` 是 main 内 endpoint/token 的唯一真相源。
- `BackendCredential` 只有受控 HTTP/WS adapter 能转换为请求 header；它不能被 spread、
  JSON 序列化、默认 inspect 或投影进 runtime status。
- IPC proxy 注册一次；每次 handler invocation 获取当前 immutable snapshot，不捕获首次
  port。
- WS bridge 订阅 generation change：关闭旧 socket、连接新 endpoint，只有新连接 open
  后发一次 reconnect/resync。
- ready poll、普通 fetch 和 WS 必须来自同一 generation，不能拼接新 token + 旧 port。
- backend 意外退出时当前 generation 立即标为 unavailable；调用快速失败，不在旧端口
  无限重试。
- 自动重启生成新 token。旧 token 对新 backend 必须返回 401。

## 9. IPC sender boundary

所有 `ipcMain.handle` privileged handler 共用：

```ts
assertTrustedSender(event, currentMainWindow)
```

判定至少要求：

- `currentMainWindow` 存在且未销毁；
- `event.sender === currentMainWindow.webContents`；
- `event.senderFrame === currentMainWindow.webContents.mainFrame`；
- frame 未销毁。

不只按 URL 字符串判断。dev URL 与 packaged file URL 仍可作为诊断信息，但不是唯一授权
条件。校验必须在参数解析、文件 dialog、外部 login window 和 HTTP proxy 前执行。

本 effort 只处理 IPC sender；CSP、导航、permission 与 webview sandbox 继续留给 D-015。

## 10. Runtime status 与 self-update

root token 不写盘。Electron main 在 authenticated `/api/health` 成功后原子发布：

```json
{
  "protocol": 1,
  "pid": 1234,
  "port": 4567,
  "generation": "non-secret-id",
  "startedAt": "2026-07-17T00:00:00.000Z",
  "checkedAt": "2026-07-17T00:00:01.000Z",
  "healthy": true
}
```

位置为 `<ZERO_CORE_DIR>/runtime.status.json`。它不是认证材料：

- helper 用 `startedAt/generation` 区分旧文件，使用 `/api/live` 判断进程退出；
- relaunch 后等待新的 `healthy:true` status；业务 health 由持 token 的 Electron main
  执行；
- staging smoke 自己是 backend parent，生成测试 token、走 bootstrap pipe，并带 auth
  调 `/api/health`；
- `runtime.port` 在同一原子 cutover 中删除，脚本和测试不保留双读 fallback；
- status 使用 temp + atomic replace，shutdown 尽力删除；消费者必须处理 stale file。

## 11. standalone 决策

`src/serve.ts` 当前无 npm script、无 package bin、无正式认证协议。首版删除该生产入口和
server static hosting 分支。

如果未来需要浏览器/headless remote server，必须单独设计：

- 用户身份和 session；
- TLS 与可信 origin；
- CSRF/CORS/WebSocket origin；
- 远程 capability/authorization；
- secret provisioning、撤销和审计。

不能用 desktop root token 或 `ZERO_CORE_SERVER_TOKEN` 环境变量假装完成上述边界。

## 12. 故障语义

| 故障 | 行为 |
|---|---|
| random token 生成失败 | 不 spawn backend，应用启动失败并记录无 secret 错误 |
| bootstrap timeout/invalid | child 非零退出；supervisor 受重启上限约束 |
| bind 非 loopback/失败 | backend 不 ready，不 fallback unspecified host |
| HTTP missing/wrong token | 401，零业务副作用 |
| WS missing/wrong token | upgrade 前拒绝，零 connection |
| backend crash | generation unavailable；新 spawn 使用新 token |
| status 写失败 | 桌面功能可继续，更新/外部健康显示 degraded；不把 token 写盘兜底 |
| authenticated health 失败 | 不发布 healthy status，main/UI 显示 backend unavailable |
| forged IPC sender | handler 直接拒绝，零 HTTP/file/dialog/login 副作用 |

## 13. 与其他 effort 的关系

- **wiki-system-redesign**：当前实施先等其合并，再按新 `CoreDatabase/server/index` 对齐；
  不修改其 worktree。
- **session-summary-restart-integrity**：Wiki 合并后仍应优先重新验证该 P0 数据完整性
  缺陷；两者可以分别规划，但实现不得在同一文件上无协调并行。
- **agent-eval-harness**：它将增加 Flow/Work API；本安全边界先落地可让新 API 默认受
  保护。两份计划没有运行时自动 dependency。
- **external-subagent-mcp**：实施前必须重审其旧 design。MCP scoped token 与 desktop
  root token 必须是两个 credential domain。
- **D-015 Renderer hardening**：IPC sender 验证在本 effort；CSP/webview/navigation 等
  仍独立。

## 14. 被否决的替代方案

- **只依赖随机端口**：可扫描、可从 runtime 文件读取。
- **只绑定 loopback，不认证**：同机任意进程仍可调用。
- **把 token 放 query/WS URL**：进入日志、错误、历史和代理观测面。
- **把 token 暴露给 Renderer**：DevTools/XSS/webview 风险可绕过 main IPC capability。
- **把 token 写 `runtime.port` 旁边**：同机读文件者直接获得 root capability。
- **用全局固定 token**：无法按 backend generation 撤销，泄露寿命过长。
- **后端重启继续用首次 port/token closure**：连接状态分裂，UI 无法恢复。
- **让 `/api/health` 免认证**：泄露业务状态并允许外部触发 DB probe。
- **用 `verifyClient` 做 WS auth**：`ws` 官方不推荐；应在 HTTP upgrade 阶段认证。
- **用 URL allowlist 代替 IPC frame identity**：导航和 frame 情况下容易误判。
- **顺手开放 standalone server**：远程/browser auth 是另一套威胁模型。
- **给每次 Agent/API 操作加用户批准**：增加摩擦且没有解决进程身份问题。

## 15. 已定设计决策

| # | 决策 |
|---|---|
| D1 | 生产后端只绑定 `127.0.0.1`，不使用 hostname 或 unspecified address。 |
| D2 | loopback 与 bearer auth 必须同时成立。 |
| D3 | 每个 backend generation 使用 main 生成的 256-bit root token。 |
| D4 | token 只经 parent-child stdin bootstrap 传输，不进 argv/env/disk/stdout/Renderer。 |
| D5 | HTTP 只接受 Authorization Bearer header，auth 位于 body parser 前。 |
| D6 | `/api/live` 是唯一 unauth route，返回空 204；ready/health authenticated。 |
| D7 | WS 使用 noServer + upgrade auth，不用 query token、subprotocol token 或 verifyClient。 |
| D8 | BackendConnectionManager 是 main 的动态 endpoint/token 真相源。 |
| D9 | backend restart 轮换 port/token/generation，HTTP/WS 原子切换。 |
| D10 | 所有 privileged IPC 验证当前主窗口 main frame sender。 |
| D11 | runtime status 不含 secret；main 验证 health 后发布，updater 不持 root token。 |
| D12 | staging smoke 自己生成测试 token并走同一 bootstrap/auth 协议。 |
| D13 | 删除 `src/serve.ts` 与 static server 分支；远程/standalone 以后独立设计。 |
| D14 | external MCP scoped token 不得复用 desktop root token。 |
| D15 | 本 effort 不增加用户逐次批准，不改变 Agent trust-first。 |
| D16 | CORS、随机端口、firewall、URL allowlist 都不能替代身份认证。 |

## 16. 进入执行前的验收边界

执行计划必须覆盖：

1. post-Wiki 源码 reconciliation 与 baseline；
2. bind address、standalone/static surface removal 和最小 liveness；
3. 全 IPC handler 的 main-frame sender validation；
4. token 生成、bootstrap、解析、constant-time compare 和 non-leak；
5. auth-before-parser 的 HTTP 正反矩阵；
6. WS upgrade auth、Origin、payload limit 和零 connection 失败语义；
7. initial start、crash、restart、token rotation、stale generation 和 resync；
8. runtime status/self-update/staging smoke 无 secret 协议；
9. Windows/macOS/Linux 可判定测试；
10. unit/build/E2E、活动文档和最终独立验收。
