# Final Acceptance：Local Backend Security Boundary

> 只在 Acceptance 00–05 全部通过后执行。
> 验收 Agent 应与主要实现 Agent 不同。
> 任一核心场景失败，effort 不得标记完成或归档。

## 1. 前置

- [ ] 00–05 各有 result、commit、命令和偏差记录。
- [ ] 起点包含已最终验收并合并的 Wiki effort。
- [ ] 使用干净 checkout、隔离 `ZERO_CORE_DIR` 和 fresh desktop fixture。
- [ ] 准备 authorized main client、unauthorized local client 和 forged IPC frame fixture。

## 2. 场景 A：网络 surface

1. 启动 desktop backend。
2. 读取实际 server address。
3. 从 loopback 与可用非-loopback interface 尝试连接。
4. 检查 standalone/static 入口。

- [ ] address 精确 IPv4 `127.0.0.1`。
- [ ] loopback `/api/live` 返回空 204。
- [ ] 非-loopback 不可达；无接口环境仍有 address/config 强断言。
- [ ] 无 standalone/static privileged server。

## 3. 场景 B：HTTP auth

对一个只读 route 和一个有副作用 route 分别发送：

- 无 header；
- wrong/malformed/duplicate bearer；
- token in query/body/cookie；
- correct current bearer；
- old generation bearer；
- unauthorized invalid/oversize JSON。

- [ ] 只有 current bearer 成功。
- [ ] 失败统一 401，零 DB/file/Agent/downstream 调用。
- [ ] invalid/oversize 未认证 body 不进入 JSON parser。
- [ ] ready/health authenticated；live 仍最小。

## 4. 场景 C：WebSocket

尝试 wrong path/method/origin/missing token/wrong token/current token。

- [ ] 只有 exact `/ws` + current bearer 完成 upgrade。
- [ ] 失败路径 connection 计数为零。
- [ ] token 不在 URL/subprotocol/log。
- [ ] oversized payload 按显式 limit 关闭且不影响其他 client。

## 5. 场景 D：IPC sender

用 current main frame、child frame、webview/other window、destroyed old frame 调用 proxy、
window、dialog 与 login handler。

- [ ] 只有 current main frame 被允许。
- [ ] deny 路径零 fetch/window/dialog/login/cookie 副作用。
- [ ] token 没有进入 Renderer/preload/IPC 参数。

## 6. 场景 E：bootstrap 与 secret

运行 valid、missing、timeout、partial、oversize、duplicate bootstrap。

- [ ] 只有 valid bootstrap 后 DB open/listen/ready。
- [ ] 每次 spawn token 至少 256-bit 且不同。
- [ ] argv/env/files/stdout/stderr/log/error/telemetry/status 全部 secret grep 无命中。
- [ ] ready generation 正确，token 从不回显。

## 7. 场景 F：crash、rotation 与 resync

1. 完成正常 HTTP/WS。
2. 强制 backend crash。
3. 在 restart 窗口调用 IPC。
4. 等新 backend ready。
5. 发送旧 socket late event 和旧 token 请求。

- [ ] crash 后旧 generation 立即 unavailable。
- [ ] restart 获得新 port/token/generation。
- [ ] HTTP/WS 一起切换，UI 自动 resync 一次。
- [ ] stale event 不污染新状态，旧 token 401。
- [ ] backoff/上限仍有效，无 timer/socket leak。

## 8. 场景 G：runtime status 与 self-update

1. 正常启动写 healthy status。
2. 制造 stale status/status write failure。
3. 跑 staging smoke。
4. 跑 helper relaunch success 与 rollback fixture。

- [ ] status 原子、无 secret、可区分 generation/stale。
- [ ] helper 只用 live/status，不调用业务 health。
- [ ] staging parent 走 bootstrap + authenticated health。
- [ ] status failure degraded，不生成 token file/bypass。
- [ ] active code不再读写 `runtime.port`。

## 9. 场景 H：全量回归

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run test:e2e
npm run check:links
```

- [ ] 全部成功，无 skipped/only。
- [ ] 正常 Agent chat、文件、配置、Wiki、Project、附件、WS push 和 self-update fixture 可用。
- [ ] router unit tests 与完整 server auth integration 职责清楚，没有因为 auth 大量复制
  token boilerplate。

## 10. 证据包

`result-final.md` 包含：

- commit/result 链与环境；
- A–H 实际 trace；
- bind/address、HTTP/WS/IPC/bootstrap/rotation/status 矩阵；
- secret grep、资源/故障/平台报告；
- baseline/final 命令和测试数；
- 文档 diff、剩余威胁与是否阻塞发布的判断。

## 11. PASS 条件

- [ ] A–H 全部通过。
- [ ] loopback + HTTP/WS auth + IPC sender 三层同时成立。
- [ ] token 每代轮换且不离开 main/backend 内存与 pipe。
- [ ] restart/updater 不依赖旧 port、auth bypass 或用户手工恢复。
- [ ] standalone/public server 未被暗中保留。
- [ ] 活动文档和实现一致，D-002 可关闭。
- [ ] D-015、remote auth、MCP scoped token 的未实现边界如实保留。
- [ ] 独立验收 Agent 明确给出 PASS。
