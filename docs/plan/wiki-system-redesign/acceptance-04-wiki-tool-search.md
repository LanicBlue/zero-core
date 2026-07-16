# Acceptance 04：Wiki Agent 工具与统一搜索

对应 [Plan 04](plan-04-wiki-tool-search.md)。

## A. Schema 与边界

- [ ] action 枚举恰好包含 9 个最终 action。
- [ ] schema 无旧 memory/doc action、管理 action、nodeId、agentId、projectId、grants 或 cwd。
- [ ] 当前 ToolRegistry 未额外暴露 `WikiV2`/测试工具名称。
- [ ] 所有结果 payload 与 format 文本不含 Wiki 内部整数 ID、合成/短 ID或旧 path prefix；canonical path 中稳定 Agent/Project 业务 ID 路径段不视为内部 Wiki ID。
- [ ] 普通 Agent 无 hard-delete/address/repository/grant/context action。

## B. ToolResult

- [ ] execute 返回结构化 ToolResult；UI 可不经 format 消费完整字段。
- [ ] format 输出中的每个 canonical path/address 回灌对应 expand/read schema 都能解析成功，不用主观“紧凑”代替断言。
- [ ] error code 可机器判断，不要求解析 message。
- [ ] mutation 返回 revision/auditId；并发冲突不伪装为普通错误文本。

## C. Read/expand/write

- [ ] expand 默认不返回 content，children 支持 limit/cursor。
- [ ] child/link 在 SQL/service 层已权限过滤，而不是 format 后删文本。
- [ ] read 五种 view 与 section/source range 均有测试。
- [ ] update 缺 expected_revision 被拒绝。
- [ ] create/update/link/unlink/move/delete 分别证明调用正确 service action 和授权。
- [ ] source-bound create/move/delete 显示 `SOURCE_MANAGED`。

## D. Search

- [ ] exact、substring、glob、regex、fulltext、hybrid 全部有正反测试。
- [ ] case_sensitive true/false 对 ASCII fixture 正确；Unicode 限制在文档/API 中诚实说明。
- [ ] glob 的 `*` 不跨段、`**` 可跨段、`?` 单字符。
- [ ] regex pattern 2,048 bytes、50,000 candidates、16 MiB、250 ms、200 results 五个默认阈值分别有边界测试；worker 超时被 terminate，后续请求可立即执行。
- [ ] FTS/search 在无授权 scope 时不执行正文查询或 snippet 生成。
- [ ] `both` 能融合 Wiki/source 命中且无重复/丢失来源。
- [ ] source search 不能通过参数改变 cwd 或逃离绑定仓库。
- [ ] cursor/limit 结果稳定，同输入同 revision 顺序可重复。
- [ ] hybrid 精确符合共享 `(match_type_rank, -normalized_score, canonical_path, target)` 排序 oracle，同分不依赖内部 ID。

## E. 泄露测试

准备 authorized 与 secret 两棵子树，secret 包含唯一关键词：

- [ ] wiki/source/both 各模式均无法返回 secret path、snippet、数量或 score 暗示。
- [ ] link 到 secret 时 read/expand 不泄露对端。
- [ ] direct read secret existing/non-existing 外观一致为 `NOT_FOUND`。

## F. 验证命令

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run check:links
```

## G. 必备证据

`result-04.md` 包含：

- 导出的 LLM-visible JSON schema。
- 每个 action 的一组 sanitized input/result。
- search mode × target × case 表。
- regex timeout/worker 证据。
- 旧 10-action caller inventory 及每项的迁移阶段。
- secret keyword 防泄露测试输出摘要。

## H. 拒绝条件

- search 先全库取结果/snippet 后再过滤。
- regex 在主线程无上限运行。
- 工具通过读取 AgentStore 或 input 自行决定身份。
- 保留旧 ID/短 ID 作为“兼容入口”。
- 把管理功能塞进 Wiki action 枚举。
