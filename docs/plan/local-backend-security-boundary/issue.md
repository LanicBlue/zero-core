# Issue: local-backend-security-boundary

- **状态**：③ plan（用户已确认，Ready）
- **提出**：2026-07-17
- **类型**：缺陷 / 安全加固（P0）
- **来源**：[`D-002`](../../arch/10-tech-debt-architect-view.md#d-002桌面后端缺少明确的本机安全边界)
- **设计**：[design.md](./design.md)

## 问题

zero-core 桌面应用把高权限业务能力放在独立 Node 后端，通过随机 TCP 端口向 Electron
main 提供 HTTP 和 WebSocket。随机端口不是认证：

- [`startServer()`](../../../src/server/index.ts) 使用 `server.listen(port)`，没有显式
  host；Node 在省略 host 时绑定 unspecified IPv6 `::` 或 IPv4 `0.0.0.0`，可能暴露到
  非 loopback 网卡。
- 所有 `/api/*`、`/ws` 和 health 路由都没有统一认证。
- [`ipc-proxy.ts`](../../../src/main/ipc-proxy.ts) 只知道 `localhost:<port>`，请求不带
  credential；WebSocket upgrade 同样无认证。
- [`runtime.port`](../../../src/main/backend-spawn.ts) 只保存端口，自更新 helper 直接
  请求未认证 `/api/ready` / `/api/health`。
- Electron `ipcMain.handle` 代理与本地主进程 handler 没有验证 `senderFrame` 是否是可信
  主窗口 main frame。

这些 API 可以读写文件、配置 Provider/Agent、驱动会话和执行工具。只要非预期进程能连接
端口，就可能绕过 Renderer/preload 暴露的能力边界。

## 已核实影响

### 网络暴露

`server.listen(port)` 没有 host，日志写“localhost”不会改变实际 bind address。远端主机
是否最终可达还受 OS firewall 影响，但应用本身没有建立 loopback-only 契约，不能把
firewall 当作安全机制。

### 同机调用

即使收敛到 loopback，同一机器上的其他进程仍可扫描端口或读取 `runtime.port`，直接调用
REST/WS。当前没有 bearer secret、cookie、peer credential 或 capability token。

### Renderer / webview 绕过

Electron main 当前通过全局 `ipcMain.handle` 接受调用，但 handler 忽略 event。安全设计
不能假定只有顶层可信 Renderer 能发 IPC；外部登录窗口、webview 或未来新 frame 必须在
进入 privileged handler 前被拒绝。

### 崩溃恢复与 token 轮换

[`backend-spawn.ts`](../../../src/main/backend-spawn.ts) 会在后端崩溃后拉起新进程和新随机
端口，但 [`registerProxyHandlers(port)`](../../../src/main/ipc-proxy.ts) 与
`connectEventBridge(win, port)` 捕获首次端口，没有接收新 connection generation。
加入每代 token 后若不同时修复这个生命周期，重启后的 UI 会继续访问旧 endpoint。

## 目标影响面

- `startServer` 的 bind/security contract；
- HTTP auth middleware、WebSocket upgrade authentication；
- Electron main → backend 的一次性 bootstrap secret；
- main 内部 BackendConnection generation 与自动重启接线；
- IPC sender 验证；
- self-update staging/health/status 协议；
- server、main、WS、IPC、updater 和 E2E 测试；
- 活动架构与运行说明。

## 非目标

- 不实现多用户、远程访问、TLS 终止或公网 server。
- 不把本机 bearer token 当成 OS 沙盒；同一用户下可读进程内存/注入进程的攻击者不在
  首版承诺内。
- 不实现 external-subagent MCP host；未来 MCP 必须使用独立 scoped token，不能复用
  desktop root token。
- 不顺带完成 CSP、navigation、permission handler、webview sandbox 等完整 Renderer
  hardening；这些属于 [`D-015`](../../arch/10-tech-debt-architect-view.md#d-015rendererelectron-防护未系统化)。
- 不增加逐 API 用户确认，不改变 Agent trust-first 执行策略。
- 不回写已经合并并归档的 `wiki-system-redesign` 历史 effort。

## 当前实施安排

`wiki-system-redesign` 已于 2026-07-19 最终验收并合并。当前应先执行 Plan 00，按合并后的
`server/index.ts`、后端启动协议和活动架构文档完成 reconciliation，再开始实现。这个顺序
不是 zero-core 已建立的 Flow 控制，也不会由软件自动执行。
