# Acceptance 03：Local Auth、Bootstrap 与 Connection 原语

对应 [Plan 03](plan-03-auth-primitives.md)。

## A. token

- [ ] token 来自 32-byte CSPRNG，generation 与 token 类型/用途分离。
- [ ] 只接受单一 Authorization Bearer header。
- [ ] digest 固定长度并用 timing-safe compare。
- [ ] malformed/oversize/duplicate 输入稳定拒绝，无 secret log/error。

## B. bootstrap

- [ ] server factory 只在合法 bootstrap 后调用。
- [ ] timeout/EOF/unknown/duplicate/oversize/partial/chunked 输入矩阵通过。
- [ ] ready/control output 不含 token/header/digest。
- [ ] argv/env/file fixture 中无 token transport。

## C. HTTP

- [ ] `/api/live` 是唯一 bypass，其他 fixture route 统一 auth。
- [ ] auth-before-parser 有 invalid/large body 自动化证据。
- [ ] unauthorized 零 downstream/DB/file/Agent 模拟调用。
- [ ] query/body/cookie token 不生效。

## D. WS

- [ ] noServer + upgrade authentication，不使用 verifyClient。
- [ ] path/method/origin/token 全部在 connection 前校验。
- [ ] wrong token 不产生 WebSocket connection。
- [ ] maxPayload 明确并有 oversize 测试。

## E. connection/status

- [ ] generation CAS 阻止 stale ready/exit 覆盖新连接。
- [ ] subscriber/change/unavailable 语义幂等。
- [ ] public status 永远不序列化 secret。
- [ ] atomic status write/stale/failure 矩阵通过。

## F. 生产边界

- [ ] 本阶段未形成一半启用的生产 auth 或旧/新双路径。
- [ ] 新原语尚未被文档描述成当前已生效安全边界。
- [ ] typecheck、build:lib、unit、check:links 通过。

## G. 拒绝条件

- 固定全局 token、Math.random、明文文件或环境变量传输。
- auth middleware 位于 body parser 后。
- 用 WS query/subprotocol 携带 token。
- 为防 stale event 只比较 port，不比较 generation。
