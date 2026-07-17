# Plan 05：安全加固、平台矩阵与活动文档

## 目标

在最终验收前完成故障注入、资源上限、平台行为和活动文档切换，删除临时 adapter 与过时
安全叙事。

## 依赖

Acceptance 01–04 通过。

## 实施范围

### 1. 故障注入

覆盖：

- CSPRNG/child spawn/stdin write/bootstrap timeout；
- bind collision/permission；
- auth middleware throw；
- WS malformed upgrade/oversize/slow close；
- backend crash loop/backoff 上限；
- stale ready/exit/socket/message；
- status temp/write/rename/delete；
- updater stale file/relaunch/rollback；
- app/window shutdown 中 timer/socket 清理。

错误不能打印 Authorization、bootstrap line 或 token-bearing object。

### 2. 资源边界

- HTTP headers/request timeout 使用 Node 合理显式值或记录沿用默认的证据。
- body limit 保持业务需要，但 unauthorized 先拒绝。
- WS maxPayload 取 Plan 00 测量结果上方安全余量；记录值和最大合法 fixture。
- auth failure 不创建高基数日志或每次同步写盘；仍保留可聚合诊断计数。
- reconnect/backoff 不形成 busy loop。

### 3. 平台矩阵

Windows 为必跑平台，并在可用 CI/验收环境覆盖 macOS/Linux：

- address family/address；
- stdin line protocol；
- atomic status replace；
- child exit/signal；
- packaged/dev spawn；
- updater helper。

不能用平台 skip 让核心 bind/auth/restart 场景失去验收；缺平台环境时 final result 明确
blocked，不写 PASS。

### 4. 清理

生产 grep 分类：

- `server.listen(port)` / omitted host；
- `localhost:${port}`；
- unauth `/api/ready` / `/api/health`；
- `new WebSocketServer({server...})` auto-upgrade；
- `runtime.port`；
- `serveStatic` / `src/serve.ts`；
- token in query/env/file；
- privileged `ipcMain.handle` 无 guard；
- fixed test token/feature flag/bypass。

允许历史 plan/archive 文字命中，必须人工分类。

### 5. 活动文档

实现证据通过后更新：

- system overview/backend structure；
- renderer/IPC boundary；
- cross-cutting security；
- self-update/runbook；
- tech debt D-002 状态；
- extension guide：新增 route 自动受 auth、新 IPC 默认 sender guard；
- standalone server 已不支持及未来另开 effort。

不得把 D-015、skill sandbox、remote auth 或 MCP scoped token 写成已实现。

## 完成定义

[Acceptance 05](acceptance-05-hardening-docs.md) 通过并创建 `result-05.md`，随后执行
[Final Acceptance](acceptance-final.md)。
