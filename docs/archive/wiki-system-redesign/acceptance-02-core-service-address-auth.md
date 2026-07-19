# Acceptance 02：核心服务、逻辑地址与授权

对应 [Plan 02](plan-02-core-service-address-auth.md)。

## A. 事务与编辑

- [ ] create/update/archive/link/unlink/move 均原子更新 node、FTS 和 audit。
- [ ] 人工注入事务失败后，node/link/FTS/audit 均回到提交前状态。
- [ ] expected_revision 正确时 revision 恰好 +1；错误时无任何写入并返回 `WRITE_CONFLICT`。
- [ ] replace_text 能区分 0 次、1 次和多次命中。
- [ ] section 操作正确处理同名不同层级、最后一节、空节和 fenced code block 内的 `#`。
- [ ] ATX/Setext、同名 occurrence、最后一节、空节、nested heading、fenced code 均有 input→expected oracle；parser 是直接依赖而非偶然 transitive dependency。
- [ ] move 更新整棵后代 path，不更新 link 端点或静态地址 target；根 revision +1，后代 revision/updated_at 不变。
- [ ] 10,000 节点边界成功，超限稳定返回 `MOVE_TOO_LARGE` 且无半更新。
- [ ] hard delete 对 child、incoming link、address 和 source binding 分别有拒绝测试。
- [ ] source-bound 节点 create/move/delete 返回 `SOURCE_MANAGED`。

## B. 地址

- [ ] canonical path、`memory://`、`project://` 和静态 alias 均解析正确。
- [ ] `memory://x` 只能解析到当前 agent Memory root 下的 `x`。
- [ ] 缺 active project 时 `project://` 返回稳定错误，不回退到全局 projects。
- [ ] 非法地址为 `INVALID_ADDRESS`，缺动态上下文为 `ADDRESS_UNRESOLVED`，有效但不存在为 `NOT_FOUND`。
- [ ] `memory://`/`project://` 不存在于地址表；静态 alias 才持久化且不泄露 target ID。
- [ ] alias target 节点 move 后地址仍解析到新 canonical path。
- [ ] 地址循环、重复、未知 resolver 和越界相对路径被拒绝。
- [ ] 普通 WikiService 接口不存在 address create/update/delete action。

## C. 权限与防泄露

- [ ] scope 匹配按路径段，`wiki-root/a` 不覆盖 `wiki-root/ab`。
- [ ] 无 grant 时，存在和不存在节点均返回同一 `NOT_FOUND` 外观。
- [ ] scope 覆盖但缺 action 时返回 `ACCESS_DENIED`。
- [ ] deep grant 不能 expand/read 其未授权祖先。
- [ ] link 对端不可见时 read links 不返回 link、对端 path 或数量暗示。
- [ ] authorization 在 repository 读取节点/正文之前执行；使用 spy 或 query tracing 提供证据。
- [ ] compiled access 不能从 service 输入中的 agentId/projectId 被覆盖。

## D. Memory root

- [ ] ensure 同一稳定 Agent ID root 多次调用幂等；显示名改变只更新 display_name/summary，不移动 root path。
- [ ] 系统不创建固定子树。
- [ ] Agent 删除 helper 默认归档 root，不硬删除历史。

## E. 验证命令

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run check:links
```

## F. 必备证据

`result-02.md` 包含：

- 权限矩阵测试表（scope × action × exists）。
- 事务故障注入结果。
- move 前后 path、link、address 的对照。
- section/edit edge case 列表。
- WikiService 公共 TypeScript 签名和 internal helper 列表。
- 修改文件与 commit SHA。

## G. 拒绝条件

- 先查节点是否存在再授权。
- 把 grants/ACL 写入 node 或 Wiki DB。
- 用双写 incoming/outgoing 代替 link 表。
- move 后扫描全库字符串并改 links/address。
- 为兼容旧 anchors 增加隐藏全局 grant。
