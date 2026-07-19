# Acceptance 05：安全加固、平台矩阵与活动文档

对应 [Plan 05](plan-05-hardening-docs.md)。

## A. 故障与资源

- [ ] spawn/bootstrap/bind/auth/WS/restart/status/updater 故障矩阵自动化。
- [ ] 所有错误与日志经过 secret non-leak 断言。
- [ ] HTTP timeout/header/body 与 WS payload limit 有明确值/依据和边界测试。
- [ ] reconnect/auth failure 不产生 busy loop、高基数 secret 日志或残留 timer。

## B. 平台

- [ ] Windows 完整矩阵通过。
- [ ] macOS/Linux 有实际结果；无环境时 final 不伪造 PASS。
- [ ] path/status atomicity 和 child lifecycle 无仅 POSIX 假设。

## C. 清理

- [ ] active production 无 omitted host、localhost fallback、unauth ready/health、
  auto-upgrade WS、runtime.port、standalone/static server。
- [ ] 所有 privileged IPC handler 有 sender guard。
- [ ] 无 query/env/file/Renderer token 和固定生产 token。
- [ ] 无 feature flag 双路径、temporary bypass、skipped/only。

## D. 文档

- [ ] 活动文档准确描述 loopback/auth/IPC/restart/status。
- [ ] D-002 只在 Final 通过后标已解决。
- [ ] D-015、remote server、MCP scoped token 明确仍未实现。
- [ ] `npm run check:links` 通过。

## E. 全局验证

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run test:e2e
npm run check:links
```

- [ ] 全部成功。
- [ ] `result-05.md` 包含故障、平台、资源、grep 和文档证据。

## F. 拒绝条件

- 用手工 curl 截图替代自动 auth/rotation/IPC 测试。
- 只在 Windows 代码分支绑定 loopback，其他平台沿用默认。
- 在 Final 前把活动文档写成完整安全边界已交付。
