# Local Backend Security Boundary：实施路线图

> 设计基线：[design.md](./design.md)
> 状态：计划已于 2026-07-17 经用户确认完成，进入 **Ready**；尚未实施。
> Wiki 外部门禁已满足：Final PASS，已于 2026-07-19 合入 `master`（基线 `a58102d`）并归档。
> 现在可执行 Plan 00；该顺序仍是外部工作安排，不是 zero-core 当前已建立的 Flow 控制。
> 除 Plan 00 发现合并后事实与已定安全不变量冲突外，执行 Agent 可自行处理实现细节，
> 不需要重新进入需求讨论。

## 1. 目标

把 Electron main ↔ 本地 backend 建成可验证的私有进程边界：

- 明确 loopback-only bind；
- 每个 backend generation 的内存 root token；
- HTTP/WS 统一认证；
- Renderer IPC sender 验证；
- 崩溃重启时 endpoint/token 原子切换；
- self-update 与 staging 不持久化 root secret；
- 删除未定义安全协议的 standalone/static server 入口。

本计划不修改 Agent 授权模型，不增加逐次用户确认。

## 2. 执行 Agent 读序

每个阶段开始前依次阅读：

1. [issue.md](./issue.md)；
2. [research.md](./research.md)；
3. [design.md](./design.md)；
4. 本 README；
5. 当前 plan 与 acceptance；
6. 所有已完成阶段的 result；
7. 合并后的 Wiki result、当前源码和活动架构文档。

若真实接口变化但设计不变量仍成立，只更新 result 中的文件映射。若无法同时满足 D1–D16
或 acceptance，停止并回到设计讨论，不得留下无认证 fallback。

## 3. 阶段

| 阶段 | Plan | Acceptance | 依赖 | 主要产物 |
|---|---|---|---|---|
| 00 | [Post-Wiki Reconciliation](plan-00-post-wiki-reconciliation.md) | [Acceptance 00](acceptance-00-post-wiki-reconciliation.md) | wiki final + merge | baseline、真实接口/冲突映射 |
| 01 | [Loopback Surface](plan-01-loopback-surface.md) | [Acceptance 01](acceptance-01-loopback-surface.md) | 00 | 显式 bind、最小 live、移除 standalone/static |
| 02 | [Trusted IPC Sender](plan-02-trusted-ipc-sender.md) | [Acceptance 02](acceptance-02-trusted-ipc-sender.md) | 01 | main-frame sender guard、全 handler 接线 |
| 03 | [Auth Primitives](plan-03-auth-primitives.md) | [Acceptance 03](acceptance-03-auth-primitives.md) | 01–02 | token/bootstrap/auth/WS/connection 原语与独立测试 |
| 04 | [Atomic Credential Cutover](plan-04-credential-cutover.md) | [Acceptance 04](acceptance-04-credential-cutover.md) | 01–03 | desktop 全量接线、轮换、status/updater/staging |
| 05 | [Hardening & Docs](plan-05-hardening-docs.md) | [Acceptance 05](acceptance-05-hardening-docs.md) | 01–04 | 故障注入、平台矩阵、活动文档 |

全部通过后执行 [Final Acceptance](acceptance-final.md)。

```text
wiki-system-redesign FINAL + merge
                ↓
00 → 01 → 02 → 03 → 04 → 05 → FINAL
```

表中依赖只是本计划交接顺序，不代表 runtime FlowDependency。

## 4. 最终不变量与预切换约束

以下目标从 Plan 04 原子切换完成后必须全部成立。Plan 01–03 期间既有 ready/health 尚未
认证，但只能在已经收敛的 loopback 上维持现状；不得新增 unauthenticated surface，
也不得提前把边界描述成已完成。

### 4.1 网络与认证

- 生产 bind address 精确为 `127.0.0.1`。
- `/api/live` 之外的完整 server route 全部 authenticated。
- auth 早于 50 MB JSON parser 和业务 router。
- WS 在 upgrade 前使用与 HTTP 同一 generation token。
- 不允许 query/body/cookie/subprotocol token。

### 4.2 secret

- root token 至少 256-bit CSPRNG，每次 backend generation 轮换。
- token 不进入 argv、env、Renderer/preload、磁盘、URL、stdout、日志、错误或 telemetry。
- runtime status/port 不是 credential。
- future MCP scoped token 与 desktop root token 分域。

### 4.3 生命周期

- main 使用动态 BackendConnection snapshot，不捕获首次 port/token。
- restart 时旧 generation 立即 unavailable；新 HTTP/WS 一起切换。
- 无 backend 时 IPC 快速返回稳定 unavailable，不偷偷访问旧 endpoint。
- updater 和 staging 使用计划定义的显式协议，无认证旁路。

### 4.4 Electron

- 所有 proxied/local privileged IPC 在副作用前验证 main window main frame。
- token 永远不下发 Renderer。
- 本计划不把 IPC sender guard 宣称为完整 Renderer sandbox。

## 5. 阶段提交规则

- 每阶段独立 commit，typecheck/build/unit/check:links 全绿；涉及桌面链路的阶段还跑 E2E。
- 实现 Agent 创建 `result-XX.md`，记录 commit、命令、测试数、偏差和失败注入。
- Acceptance 04 与 Final 由非主要实现 Agent 验证。
- 不使用 skipped/only、新增临时 unauth route、固定生产 token 或 feature flag 双路径
  通过验收。
- 最终合并仍需用户决定。
