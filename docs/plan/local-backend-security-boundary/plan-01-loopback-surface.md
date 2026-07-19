# Plan 01：Loopback Bind 与 Surface Reduction

## 目标

先消除非 loopback 网络暴露和未定义 standalone/static server 入口，同时保持桌面应用正常。
本阶段尚未完成同机进程认证，不能对外宣称整个安全 effort 完成。

## 依赖

Acceptance 00 通过。

## 实施范围

### 1. 显式 listen contract

- `startServer` 必须接收明确的字面量 loopback host，不再省略或从环境变量猜测。
- 生产 host 只能是字面量 `127.0.0.1`。
- `server.listen({ port, host:"127.0.0.1" })`；日志输出实际
  `server.address()`，不能写固定 localhost 掩盖事实。
- bind 失败直接启动失败，不 fallback `localhost`、`::`、`0.0.0.0` 或省略 host。
- main/ipc-proxy/WS/self-update URL 统一使用 `127.0.0.1`。

### 2. 最小 liveness

增加唯一预留的 unauthenticated：

```text
GET /api/live → 204 empty
HEAD /api/live → 204 empty
```

- 不读 DB、不构造 Store、不返回 header/body 中的业务信息。
- 其他 method/path 不属于 liveness。
- 本阶段现有 ready/health 暂保持现状，Plan 04 原子切到 auth；不得新增更多 unauth route。

### 3. retire standalone/static server

- 删除 `src/serve.ts` 生产入口。
- 删除 `serveStatic` option、Express static renderer branch 及相关死代码。
- 更新 build/docs/tests，确认 package scripts/bin 没有悬空引用。
- `startServer()` 无显式 host 时 compile/runtime fail closed，不保留默认 privileged
  server；Plan 04 再把该参数收敛进最终 `ServerSecurityConfig`。

### 4. 测试

- `server.address().address === "127.0.0.1"`。
- IPv4 loopback 可达；至少用 address 断言证明不是 unspecified。
- 非法 host/config 拒绝且不 listen。
- `/api/live` method/body/side-effect 契约。
- package/source grep 无 active `startServer()` 默认调用、`serveStatic` 或 `src/serve.ts`
  入口。
- 桌面启动、ready、HTTP/WS 和 E2E 当前功能不退化。

## 完成定义

[Acceptance 01](acceptance-01-loopback-surface.md) 通过并创建 `result-01.md`。
