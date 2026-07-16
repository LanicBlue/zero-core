# Acceptance 05：Agent 配置、运行时与 Prompt

对应 [Plan 05](plan-05-agent-runtime-prompt.md)。

## A. Agent 配置与生命周期

- [ ] `wikiGrants/wikiContext/policyRevision` create/update/list/export/import 完整 round-trip。
- [ ] fresh DB agents 表含新列；旧 Wiki 数据未被转换。
- [ ] 新 Agent 创建唯一 Memory root；不创建固定子目录。
- [ ] Agent rename 保持 Memory root 内部 ID、content 和 links，只改变 canonical path。
- [ ] Agent delete 归档 root。
- [ ] 非法/冲突 Agent name 有清晰错误，不追加随机 suffix。
- [ ] Project rename 对 root/repository/source descendants 保持同样 ID 语义。

## B. Runtime 权限

- [ ] SessionConfig/CallerCtx 使用 `CompiledWikiAccess`，新 Wiki tool 不读取 anchors。
- [ ] LLM input 无法改变 agentId、active project 或 grants。
- [ ] 无 active project 时 project:// 与 `${active_project}` 不扩大到 projects 根。
- [ ] Zero 仅在 template 显式 grant 时拥有全树权限；删除该 grant 后立即失去。
- [ ] ToolRegistry 对 Agent 只暴露一个名为 `Wiki` 的新 schema，无 Legacy/V2 名称。
- [ ] Agent 调用旧 action 返回 schema validation error，而不是 fallback。

## C. Prompt compiler

- [ ] preview 与 runtime 使用同一 compiler，给定同一 snapshot 输出字节一致。
- [ ] compact/standard/deep 都尊重总 budget，并有稳定截断顺序。
- [ ] standard Memory 不依赖固定子树名，能选中 attributes 标记的高价值节点。
- [ ] standard Project 含目标/技术栈/入口/模块/sync status/风险或明确空状态。
- [ ] Prompt 显示 memory://、project:// 与 retrieval guidance，不显示 ID/短 ID/旧 action。
- [ ] 大正文、低置信度 hypothesis、过期 task_state 不被无条件固定注入。

## D. 缓存与热更新

- [ ] 普通 Wiki write 不改变当前正在执行调用的地址/权限 snapshot。
- [ ] Agent config publish、active project change、显式 refresh、memory archive 后下一 turn 使用新 context。
- [ ] 无关 UI/Agent 字段更新不导致 wiki-context cache 无意义失效。
- [ ] address/policy revision 在日志/preview 中可追踪。

## E. Memory/Archivist

- [ ] Memory ephemeral turn 只能写 own Memory，猜测其他 Memory 返回 NOT_FOUND。
- [ ] Memory prompt 只使用新 action 和逻辑地址。
- [ ] Archivist 不能通过 Wiki tool 改 source-bound 结构。
- [ ] Enrichment 不把源码/README 全文写入 Wiki content。
- [ ] changed/stale nodes 可被增量充实，不要求每次全项目 LLM 扫描。

## F. 验证命令与回归

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run check:links
```

必须更新或替换旧 anchor/tool/runtime tests；不能简单删除覆盖而不补新断言。

## G. 必备证据

`result-05.md` 包含：

- 一个只读 Agent、一个 Archivist、一个显式全局管理 Agent 的 compiled grants。
- 三种 profile 的 Prompt 样例和 token 统计。
- Agent rename 前后 Memory root identity 证据。
- Memory turn 防越权用例。
- ToolRegistry 导出工具名/schema 摘要。

## H. 拒绝条件

- `agentId === "zero"` 或无 project session 被硬编码全树权限。
- wikiAnchors 仍决定访问范围。
- Prompt 内容决定 authorization。
- preview 与 runtime 各有一套渲染器。
- 为已有 Agent 自动把旧 anchors 转成全权 grant。
