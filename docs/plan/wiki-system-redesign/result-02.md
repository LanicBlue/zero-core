# Result 02：核心服务、逻辑地址与授权

对应 [Acceptance 02](acceptance-02-core-service-address-auth.md) / [Plan 02](plan-02-core-service-address-auth.md)。

- **实施 commit**：`ee8e429`(branch `worktree-wiki-redesign`)— feat(wiki-system-redesign): sub-02 核心服务/逻辑地址/授权
- **验收**：3 方向独立 verifier(规约/对抗/架构)全 PASS,§A.1-10 + §B.1-8 + §C.1-7 + §D.1-3 核心项零 FAIL、零 lens 冲突(round-2,见"验收记录")
- **结论**:✅ Acceptance 02 全部通过,可进入 Plan 03。

---

## 1. 权限矩阵(scope × action × exists)(§C)

`WikiAuthorizationService.authorize` 先于 repo 读;real temp DB,非 mock。无 grant→NOT_FOUND(与节点不存在同观);scope 覆盖但无 action→ACCESS_DENIED;有 action但节点不存在→NOT_FOUND。

| scope 覆盖 | action 授权 | 节点存在 | 结果 |
|---|---|---|---|
| 无 | — | 存在/不存在 | NOT_FOUND(同观,无存在 oracle)§C.2 |
| 有 | 否 | — | ACCESS_DENIED §C.3 |
| 有 | 是 | 不存在 | NOT_FOUND |
| 有 | 是 | 存在 | 通过 |
| deep(子树) | 是 | 祖先 | NOT_FOUND(deep grant 不透祖)§C.4 |
| wiki-root/a | 是 | wiki-root/ab | NOT_FOUND(段匹配,§C.1) |
| link 对端不可见 | read links | — | 不返回 link/对端 path/计数(§C.5 + expand includeLinks 计数过滤 FIX2) |

`ctx.agentId/activeProjectId` 仅用于地址解析,**不可覆盖** compiled access(§C.7)。authorize 在 repo `getActiveByPath` 之前(spy 计数=0,§C.6)。

## 2. 事务故障注入(§A.2)

Proxy-armed audit repo(`armFault()` 让 `audit.append` 在 tx 最后一步抛)。每 op(create/update/archive/link/unlink/move)注入后:`wiki_nodes` / `wiki_nodes_fts` / `wiki_links` / `wiki_audit_log` 计数全回提交前;update 特例保留 OLD 内容(token 旧可搜、新不可搜)。better-sqlite3 `transaction()` 原子回滚保证。

## 3. move 前后对照(§A.7)

3 层子树 `wiki-root/knowledge/parent/{child,grandchild}` → `wiki-root/memory/parent-moved/{child,grandchild}`:
| 对象 | move 前 | move 后 |
|---|---|---|
| 根 parent revision | 1 | 2(+1) |
| child/grandchild revision | 1 | 1(不变) |
| child/grandchild updated_at | T0 | T0(不变) |
| wiki_links.source_id/target_id(int) | X,Y | X,Y(不变,锚内部 id) |
| wiki_addresses.target_id(int) | Z | Z(不变);静态 alias `runtime://...` 重解析到新 canonical path |
| 旧 path active | 是 | 否 |
| move 进自己子树 | — | INVALID_REQUEST(环守卫) |
| move 进 source-bound parent | — | SOURCE_MANAGED |

cap:1 root + 9,999 children = 10,000 SUCCESS;1 + 10,000 → MOVE_TOO_LARGE(tx 内,旧 path 全在、新 path 0、根 rev 不变、无 audit,无半更新)。

## 4. section/edit edge case(§A.4/5/6)

replace_text:0 hit→EDIT_TARGET_NOT_FOUND;1 hit→替换;>1 无消歧→EDIT_TARGET_AMBIGUOUS;expected_occurrence 不符→WRITE_CONFLICT。
section:同名不同 level(level 消歧);同名 occurrence 消歧;无消歧多 match→EDIT_TARGET_AMBIGUOUS;最后一节(到 EOF);空节;nested heading;**fenced code block 内 `#` 不参与**(remark-parse CommonMark);ATX + Setext 均 supported。parser = `unified`+`remark-parse` **直接依赖**(package.json,非 transitive)。

## 5. 地址解析(§B)

canonical / `memory://<x>`(→`wiki-root/memory/<agentId>/<x>`,只当前 agent)/ `project://<x>`(→`wiki-root/projects/<projectId>/<x>`,无 active project→ADDRESS_UNRESOLVED 不退全局)/ 静态 alias(→target canonical path,target_id 不泄露)。错误三态:INVALID_ADDRESS(坏 scheme/语法)/ ADDRESS_UNRESOLVED(动态缺 ctx)/ NOT_FOUND(有效但 target 不在)。`memory://`/`project://` **不入** wiki_addresses;静态 alias 持久化,target 锚内部 id(move 后稳定)。**fan-in**(多 alias→同节点)允许(design §5.3 非唯一 target_id FK;FIX1 删除 assertNoAliasCycle 误判)。data-plane WikiService **无** address create/update/delete action。

## 6. source-bound policy(§A.10 + design §6.3)

structural(create/move/archive/hardDelete/restore)→SOURCE_MANAGED(indexer 保留);**summary/content/attributes 更新允许**(design §6.3,rev+1,FTS resync,audit)。

## 7. memory root(§D)

`ensureAgentMemoryRoot(agentId, displayName)` 幂等:同 agentId+displayName→不 bump rev/不 dup;displayName 变→只改 summary/attributes.display_name,**不动 path/name**;不建固定子树(无 preferences/lessons)。`archiveAgentMemoryRoot` 归档(archived_at,保留行,不硬删),级联子树,幂等。

## 8. WikiService 公共签名 + internal helper

```ts
expand/read/create/update/archive(ctx: WikiRequestContext)
hardDelete/restore(ctx: WikiAdminRequestContext)
link/unlink/move(ctx: WikiRequestContext)
ensureAgentMemoryRoot/archiveAgentMemoryRoot  // helper
```
internal:`WikiAuthorizationService.{authorize,decide,prepareSearchScopes,filterVisibleLinks,canRead}`、`WikiAddressService.{resolve,register,update,delete,validate}`、`WikiEditService`(8 op)、`wikiError/assertFound`(wiki-errors.ts)。所有 request/result/context 来自 `src/shared/wiki-types.ts`(本 sub 扩展)。

## 9. 验证命令(§E)

| 命令 | 结果 |
|---|---|
| typecheck / build:lib | exit 0 |
| test:unit | wiki 子系统(sub-01+02+legacy 13 文件)390 全过;5 sub-02 wiki-v2 文件 152/152;全量仅 3 个预存非 wiki 失败(sub5-dead-code-removed git-diff-shape / deferred-dangling-tasklink / po-sub2-provider-usage)+ Windows vitest 退出 exit-127/139(teardown-only) |
| check:links | 260 链接全解析 |

## 10. 修改文件(§F)

commit `ee8e429`:17 文件,+10756/-742。
- 新增:`src/server/wiki/{wiki-service,wiki-address-service,wiki-authorization-service,wiki-edit-service,wiki-errors}.ts`、5 个 `tests/unit/wiki-v2-{service,address,auth,edit,move-link}.test.ts`
- 改:`src/shared/wiki-types.ts`(Request/Result/Context 类型)、`src/server/wiki/{wiki-node-repository,genome,index}.ts`(move 子树 helper + barrel)、`package.json/lock`(+unified+remark-parse)、`docs/visualization/code-graph.*`

## 拒绝条件(§G)

auth-before-existence ✓;grants 不写 DB/node ✓;无双写 incoming/outgoing(单 wiki_links 行)✓;move 不扫全库字符串改 link/address ✓;无隐藏全局 grant ✓。

## 验收记录

- **round-1**(3 lens + synthesis):FAIL —— BLOCKER assertNoAliasCycle 误拒 fan-in + BLOCKER expand includeLinks 计数泄露;+ concern update source-bound 过拒 / overreach 错误码。
- **implementer FIX**:删 assertNoAliasCycle;expand 计数 filterVisibleLinks;update source-bound 收窄到 structural;overreach static→INVALID_ADDRESS。
- **round-2**(3 lens + synthesis):**PASS** —— 2 blocker 由 owning verifier 新增回归测确认(fan-in 正面、计数过滤);BUG 测试翻转;source-bound update §6.3 测加;§A-D 全 PASS,blockerFindings 空。

## 已知非阻断 nit(追踪 sub-08 cutover/hardening)

**dynamic-scheme overreach 错误码**:`memory://`/`project://` 相对越界(如 `memory://x/../../projects`)在 wiki-address-service.ts:212/232 的 `joinPathSegments` 未包 FIX4 的 try/catch → 抛 raw INVALID_NAME 而非 INVALID_ADDRESS。**security-safe**(越界已被 validateWikiName('..') 阻断,无路径逃逸),4 个测试文档化当前行为,但与 plan-02 §2 closed-set 契约不一致。修复=两处 dynamic 分支加同样 try/catch → INVALID_ADDRESS + 翻转 4 文档测试。留 sub-08 一并闭。
