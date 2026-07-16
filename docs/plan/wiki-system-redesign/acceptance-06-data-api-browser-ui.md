# Acceptance 06：数据 API 与 Wiki Browser UI

对应 [Plan 06](plan-06-data-api-browser-ui.md)。

## A. API/IPC

- [ ] 九个 data endpoint 使用结构化 body/result，路径不放 `:nodeId`。
- [ ] request schema 拒绝伪造 callerCtx/grants/agentId/admin。
- [ ] server 注入 UI authority；renderer 不能扩大权限。
- [ ] preload/IPC 类型与 router request/result 同源或编译期一致。
- [ ] Wiki Browser 不再调用 legacy project-wiki CRUD/nodeId detail/search API。
- [ ] REST adapter 与 Agent tool 调用相同 service，而不是复制业务逻辑。

## B. Store 与树

- [ ] renderer state 和 React keys 只使用 canonical path，不含 DB ID/短 ID。
- [ ] 首屏只拉当前 root 的一页直接 children。
- [ ] expand 按需、分页、重复展开不重复请求。
- [ ] search result 可定位节点并按需加载祖先。
- [ ] archived 默认隐藏，管理员开关后可见。
- [ ] 1,000 个同级 child 不导致一次无界请求/渲染。

## C. 搜索 UI

- [ ] target/mode/case/fields/kinds/scope/limit 均实际传到后端，不只是视觉控件。
- [ ] 结果显示 matched field、snippet、revision 和 source/Wiki 来源。
- [ ] Both 合并结果可区分 Wiki 语义命中与源码命中。
- [ ] regex invalid/timeout 显示对应错误，不吞掉或改做 substring。
- [ ] 无授权结果不会在缓存、状态、console 或 highlight 中出现。

## D. Detail

- [ ] 五个 tab 独立懒加载并可切换。
- [ ] Markdown GFM 正确；script/event handler/javascript URL XSS fixture 无执行能力。
- [ ] content edit 带 expected_revision。
- [ ] WRITE_CONFLICT 保留本地草稿并提示 server revision。
- [ ] Relations 正确分 incoming/outgoing，link/unlink 后局部刷新。
- [ ] Source 显示 indexed/workspace、dirty/stale，不能打开仓库外文件。
- [ ] History 能显示 actor/action/revision/audit time。
- [ ] source-bound 结构按钮禁用并解释 Git ownership。

## E. 增量同步

- [ ] create/update/link/move/delete/sync event 只失效受影响缓存。
- [ ] move 同时清理 old path 并刷新 old/new parent。
- [ ] 未展开 branch 收到 event 不触发 fetch。
- [ ] WS 重连后执行有界一致性 refresh，不全量下载整树。

## F. 命令与人工验收

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run test:e2e
npm run check:links
```

人工走查：Global → Project → search both → source result → node tabs → edit conflict → relation change → Git sync event。

## G. 必备证据

`result-06.md` 包含：

- API schema/route 映射摘要。
- Wiki Browser 五个主要状态截图或 E2E trace。
- XSS fixture 结果。
- 网络请求日志证明 lazy/pagination/局部 refresh。
- conflict 与 regex timeout UI 证据。

## H. 拒绝条件

- renderer 收到或缓存内部 DB ID。
- UI 通过传 `global=true/admin=true` 自授予管理权限。
- Markdown 原始 HTML 可执行脚本。
- 搜索控件与后端参数脱节。
- 为省事一次拉整棵 Wiki 树。

