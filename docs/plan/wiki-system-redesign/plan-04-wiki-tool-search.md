# Plan 04：Wiki Agent 工具与统一搜索

## 目标

基于新 WikiService 实现最终 Agent 数据面工具和结构化搜索。此阶段先以未注册 factory/export 供测试直接调用；正式 `Wiki` tool 注册在 Plan 05 与 runtime 一起原子切换，避免中间阶段破坏现有 session。

## 依赖

- Acceptance 01–03 已通过。

## 实施范围

### 1. Action schema

保持顶层 `z.object`，action 固定为：

```text
expand, read, search, create, update,
delete, link, unlink, move
```

不得包含：

```text
createMemory, updateMemory,
docRead, docWrite, docEdit,
address/register/grant/context/repository actions
```

寻址字段统一使用 `node/parent/source/target/newParent` 的逻辑地址或 canonical path；不接受 nodeId、短 ID 或旧 title path。

### 2. Host 注入

工具只从 `CallerCtx.wikiAccess` 读取：

- agent identity。
- active project。
- compiled grants。
- policy revision。

LLM input schema 不得出现 agentId、projectId、grant、canonicalScope 或 arbitrary cwd。

本阶段可提供测试 factory：

```ts
createWikiTool(deps: { wikiService, searchService }): ToolDefinition
```

不要在 ToolRegistry 注册第二个 `WikiV2` 用户可见工具。Plan 05 直接让正式 `Wiki` 指向这个实现。

### 3. 结构化 ToolResult

每个 action 返回稳定 JSON：

```ts
ToolResult<WikiExpandResult | WikiReadResult | WikiSearchResult | WikiMutationResult>
```

- Agent-facing payload 无内部 ID。
- mutation 返回 path/address/revision/auditId/changedFields。
- error 返回稳定 code/message/details（details 也必须权限过滤）。
- `format()` 生成紧凑 Markdown，REST/UI 不调用 format。

### 4. Expand/read

`expand`：

- 默认只直接 children。
- cursor 分页，server max limit。
- 可选 include_links，但过滤不可见端点。
- 不返回 child content。

`read` view：

```text
summary, content, links, all, source
```

支持 Markdown section 和 source line range；多节点 batch read 暂不加入，除非有严格总预算。

### 5. SearchService

统一接口：

```text
target: wiki | source | both
mode: exact | substring | glob | regex | fulltext | hybrid
fields: name | path | summary | content
case_sensitive: boolean
kinds, limit, cursor
```

所有模式必须先把 `search` grants 编译为允许 scopes，再查询。

#### Wiki search

- exact：canonical name/path/字段精确匹配。
- substring：大小写选项明确；不能因 SQLite NOCASE 只覆盖 ASCII 而声称完整 Unicode。
- glob：按路径段实现 `*`、`**`、`?`。
- fulltext：FTS5 + scope filter + snippet。
- regex：在 worker/可终止执行环境中运行；pattern length、候选数、正文总字节、时间和结果数均有限制。
- hybrid：第一版融合 exact/path/FTS/source，不要求 embedding。

不得在 SQLite 主线程对全库直接执行不受限 JavaScript regex。

#### Source search

调用 Plan 03 source search，不能自行执行任意 shell/cwd。`both` 合并时：

- 统一 canonical path/address。
- 标出 target/matched_field/match_type/revision。
- 同一 source-bound 节点的 Wiki/source 命中可合并但保留命中来源。
- 排名确定且可测试。

### 6. 写 action

- create/update/delete/link/unlink/move 直接委托 WikiService。
- update 强制 expected_revision。
- exact edit 使用 operations，不接收整文件 `overwrite=true` 绕过冲突。
- source-bound 结构错误原样返回 `SOURCE_MANAGED`。
- delete 默认 archive；hard delete 不向普通 Agent schema 暴露。

### 7. 工具 Prompt

描述控制在必要范围：

- 告知逻辑地址和 canonical path。
- 推荐 `search → expand → read`。
- 说明 update expected_revision 与 source-managed 限制。
- 不解释内部 ID、数据库、anchor 或旧 doc actions。

更新/准备 `wiki-operations.ts` 和 Archivist enrichment prompt 使用新 action/path，但在 Plan 05 注册切换前不得触发未注册工具。

## 测试要求

建议：

```text
tests/unit/wiki-v2-tool-contract.test.ts
tests/unit/wiki-v2-tool-auth.test.ts
tests/unit/wiki-v2-search.test.ts
tests/unit/wiki-v2-regex-limits.test.ts
tests/unit/wiki-v2-tool-format.test.ts
```

使用真实临时 Wiki DB 与临时 Git repo，CallerCtx 由测试 host 构造。

## 明确不做

- 不注册第二个 Agent 可见 Wiki 名称。
- 不读取 AgentStore 自行补 grants。
- 不在 format 文本中藏 UI 才需要的结构。
- 不实现管理面 action。
- 不接运行时 Prompt；留给 Plan 05。

## 完成定义

[Acceptance 04](acceptance-04-wiki-tool-search.md) 全部通过并提交 `result-04.md`。

