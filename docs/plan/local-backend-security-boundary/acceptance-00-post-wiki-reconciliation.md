# Acceptance 00：Wiki 合并后安全基线对齐

对应 [Plan 00](plan-00-post-wiki-reconciliation.md)。

## A. 前置与 baseline

- [ ] Wiki final PASS，当前 commit 包含用户同意的 merge。
- [ ] 环境、commit、dirty files 与全部 baseline 命令有实际结果。
- [ ] 没有修改生产代码、schema、测试预期或 Wiki plan。

## B. 接口映射

- [ ] server/DB/HTTP/WS/backend/main/IPC/updater/test 所有者完整。
- [ ] Wiki 合并后的新增 route 与 health 接口已纳入影响面。
- [ ] 后续计划没有引用消失接口而未记录替代。

## C. 复现

- [ ] bind address 有实际 `server.address()` 证据。
- [ ] 无认证 HTTP 和 WS 行为有隔离环境证据。
- [ ] IPC sender guard 缺口有 handler/test 证据。
- [ ] restart 后 endpoint 生命周期有可复查 trace。
- [ ] runtime/self-update 协议有文件与请求 trace。

## D. 设计一致性

- [ ] D1–D16 在合并后仍可实施。
- [ ] 任何需改变威胁模型/standalone 决策的问题已停止执行并交回用户。
- [ ] result 明确判定是否允许进入 Plan 01。

## E. 拒绝条件

- Wiki 未合并便按旧 `SessionDB/server/index` 写实现。
- 把 firewall、随机端口或“只能本机用”当成认证证据。
- baseline 阶段包含功能补丁。
