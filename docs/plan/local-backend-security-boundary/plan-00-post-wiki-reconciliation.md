# Plan 00：Wiki 合并后安全基线对齐

## 目标

不实现安全功能；确认 Wiki effort 已最终验收并合并，按合并后源码重新定位 server
composition、database health、Electron main、backend spawn、WS、self-update 和测试接口。

## 当前实施前置

- Wiki `result-final.md` 结论 PASS。
- 用户已同意 Wiki 合并，当前 checkout 包含目标 merge commit。
- 不从 Wiki 并行旧 worktree 开始。

任一不满足，按当前人工计划报告 blocked。Plan 00 不创建 zero-core Flow 控制状态。

## 实施范围

### 1. baseline

记录：

- commit、Wiki merge commit、dirty files；
- Node、npm、Electron、ws、OS；
- typecheck、build:lib、unit、build、E2E、check:links；
- 当前启动、自动重启和 self-update 相关已知失败。

### 2. 真实所有者映射

`result-00.md` 至少映射：

| 设计职责 | 合并后真实所有者 |
|---|---|
| Core/Wiki DB open、health、close | 文件/类 |
| Express composition 与 body parser | 文件/函数 |
| HTTP server bind | 文件/函数 |
| WS construction/upgrade/message | 文件/函数 |
| backend child bootstrap/shutdown/restart | 文件/类 |
| main IPC proxy/local handler | 文件/函数 |
| renderer main window/frame lifecycle | 文件/函数 |
| runtime status、自更新 staging/helper | 文件/脚本 |
| server/main/E2E 测试 harness | 文件/helper |

### 3. 最小复现

在临时环境证明并记录当前行为：

1. 启动最小 Node server，确认省略 host 的 address；
2. 当前完整 server 无 auth 可访问一个只读 endpoint；
3. 当前 WS 无 credential 可 upgrade；
4. forged/非主 frame IPC handler 测试是否存在；
5. backend restart 后 proxy/WS 是否仍捕获旧 port；
6. `runtime.port` 与 updater health 的实际协议。

复现不得连接外网、修改活跃用户数据库或关闭防火墙。

### 4. 冲突判定

- 若 Wiki 已引入统一 server security primitive，只有语义完全满足 D1–D16 才复用。
- 若 class/file 改名，只更新后续 plan 定位。
- 若 Wiki 新增 route，默认纳入统一 auth，不逐路由维护 allowlist。
- 若 Wiki 改变 health/database contract，同步 Plan 04 runtime status 字段，但不能让
  `/api/health` 变成 unauthenticated。

## 明确不做

- 不改 bind/auth/IPC/WS。
- 不给 Wiki worktree 补代码。
- 不用临时 token 或测试 skip 掩盖 baseline。

## 完成定义

[Acceptance 00](acceptance-00-post-wiki-reconciliation.md) 通过并创建 `result-00.md`。
