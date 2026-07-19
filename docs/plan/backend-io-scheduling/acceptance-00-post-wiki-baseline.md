# Acceptance 00：Wiki 合并后重 I/O 基线

对应 [Plan 00](plan-00-post-wiki-baseline.md)。

## A. 前置

- [ ] Wiki Final PASS，当前 commit 包含用户同意的 merge。
- [ ] 环境、commit、dirty files 与全部 baseline 命令有实际记录。
- [ ] 全部测试使用隔离数据目录和临时 Project。
- [ ] 没有修改生产执行路径、schema 或测试预期。

## B. Inventory

- [ ] startup migration、Wiki full/diff index、FTS/integrity/optimize、archive export、
      recovery/sweep、backup/verify/restore/rotation 全部有 owner 和 execution domain。
- [ ] 普通 API/tool 的无 cap list/search/export 已扫描。
- [ ] 每条路径有 bound、atomicity、cancel、recovery 和 caller semantics。
- [ ] Security/Session/Wiki 的共享文件和接口冲突已映射。

## C. 响应性证据

- [ ] harness 同时记录 heartbeat、event-loop delay、HTTP、WS、CPU、RSS、SQLite busy。
- [ ] fresh/legacy startup、100k full index、大 diff、FTS、integrity、大 archive、sweep、
      backup verify 均有原始 JSON 报告。
- [ ] 报告记录 fixture 规模、命令、commit、机器和持续时间。
- [ ] 没有用 mock heavy operation 或缩小 fixture 代替真实负载。

## D. 锁与恢复

- [ ] worker writer + main WAL read 实验有实际结果。
- [ ] 当前 busy timeout 的主线程停顿有计时证据。
- [ ] worker/child crash 的 DB/artifact 状态有 inspection 证据。
- [ ] 已有 async native backup 是否保留有明确判断。

## E. 结论

- [ ] 每条重路径被分类为 bootstrap process、writer worker、file/CPU worker、
      cooperative main、async native 或 bounded sync。
- [ ] result 明确指出 baseline 违反 D1 的场景和允许进入 Plan 01 的结论。
- [ ] 任何需要改变事务/业务语义的问题已停止并交回用户。

## F. 拒绝条件

- Wiki 未合并便按 worktree 文件机械实施。
- 只有总耗时，没有 event-loop/HTTP/WS 延迟。
- 以函数是 `async` 或 connection 独立作为不阻塞证明。
- baseline 阶段混入修复。
