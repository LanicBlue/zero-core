# Plan 06：数据 API 与 Wiki Browser UI

## 目标

用新结构化 Wiki service 替换浏览器数据路径，完成 canonical path 懒加载树、统一搜索、Markdown/关系/源码/历史详情和增量 UI 同步。本阶段只做管理员浏览器的数据面，不做 Agent grants、地址和项目绑定编辑 UI。

## 依赖

- Acceptance 01–05 已通过。

## 实施范围

### 1. REST API

在 `wiki-router.ts` 实现：

```text
POST /api/wiki/expand
POST /api/wiki/read
POST /api/wiki/search
POST /api/wiki/create
POST /api/wiki/update
POST /api/wiki/delete
POST /api/wiki/link
POST /api/wiki/unlink
POST /api/wiki/move
```

路径放 body，不使用 `/:nodeId`。REST adapter：

- 校验 request schema。
- 由 server 注入 UI admin/data authority。
- 调用与 Agent tool 相同 WikiService/SearchService。
- 原样返回结构化 result/error code。
- 不接受 callerCtx/grants/agentId 伪造。

保留管理 API 给 Plan 07，不混在这里。

### 2. IPC/preload

更新：

- `src/main/ipc-proxy.ts`
- `src/shared/preload-types.ts`
- `src/shared/ipc-api.ts`（如实际使用）
- preload 暴露

删除 renderer 对以下旧调用的依赖：

```text
wikiGetChildren(nodeId)
wikiReadDetail(nodeId)
wikiSearch(query, anchorIds)
legacy /api/project-wiki CRUD
```

新接口全部使用共享 request/result types。

### 3. Zustand store

重写 `src/renderer/store/wiki-store.ts`：

- canonical path 作为公开 key。
- children/detail/relations/source/history 分离缓存。
- children 分页与 cursor。
- search request 保存完整 mode/target/filter。
- archived 默认隐藏。
- scope 支持 canonical root 或已解析 logical address view。
- 选中 search result 可展开祖先并定位节点。

不得把内部 DB ID 存入 renderer state。

### 4. Wiki tree/browser

修改 `WikiPage/WikiTree`：

- Global、Knowledge、Agent Memory、Project、自定义地址视角。
- breadcrumb 显示首选 address + canonical path。
- kind/source/sync 状态图标。
- loading/error/empty/pagination 状态。
- source-bound 与 archived 显著标识。
- 大量 children 使用分页或虚拟化，不一次渲染全部。

### 5. 搜索 UI

支持：

```text
target: Wiki / Source / Both
mode: Full-text / Substring / Glob / Regex / Exact
case-sensitive
fields / kinds / scope / limit
```

结果展示：

- canonical path/preferred address。
- matched field/type。
- safe snippet/highlight。
- score/source revision/stale/dirty。
- 分页和执行限制错误。

regex 失败/超时必须显示具体安全错误，不退化为普通 substring。

### 6. Node detail

`WikiDetail` 拆 tabs：

```text
Overview | Content | Relations | Source | History
```

- Overview：summary/kind/revision/attributes/sync。
- Content：`react-markdown + remark-gfm`；编辑发送 expected_revision。
- Relations：incoming/outgoing 分组；link/unlink。
- Source：indexed/workspace 选择、revision/dirty/stale、范围读取。
- History：audit log。

并发 conflict 时保留用户编辑内容，显示 server revision 并要求重新加载/合并，不静默覆盖。

### 7. 数据变更推送

扩展 `data:changed`：

```text
wiki_nodes, wiki_links, wiki_sync
```

event 含 path/oldPath/parentPath/op/revision。前端：

- 只失效已加载父 branch。
- 清理对应 detail/relations/history。
- move 删除 old path cache 并刷新 old/new parent。
- 未展开 branch 不主动拉取。

## UI 安全

- Markdown 默认不执行 script；若继续用 `rehype-raw`，必须 sanitizer 白名单并有 XSS 测试。
- Source path/canonical path 仅显示和作为结构化 API 参数，不拼 `file://`。
- UI admin authority 来自 server host，不从 renderer body 声明。

## 测试要求

新增 unit/component/e2e 覆盖 store、router、proxy、Markdown、search、conflict 和增量 refresh。

## 明确不做

- 不实现 Agent Access/Context 编辑器。
- 不实现地址/仓库管理页面。
- 不恢复旧 nodeId API。
- 不在 UI 端重新实现授权或地址解析。

## 完成定义

[Acceptance 06](acceptance-06-data-api-browser-ui.md) 全部通过并提交 `result-06.md`。

