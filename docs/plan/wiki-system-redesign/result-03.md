# Result 03：Project Git 语义镜像

对应 [Acceptance 03](acceptance-03-project-git-mirror.md) / [Plan 03](plan-03-project-git-mirror.md)。

- **实施 commit**:`69908c4`(branch `worktree-wiki-redesign`)— feat(wiki-system-redesign): sub-03 Project Git 语义镜像
- **验收**:3 方向独立 verifier(规约/对抗/架构)全 PASS,§A 全量镜像 / §B 增量同步 / §C commit 集成 / §D source 安全 核心,零 FAIL(round-3,3 轮 implement↔verify 循环后 blockerFindings 空)
- **结论**:✅ Acceptance 03 全部通过,可进入 Plan 04。

---

## 1. fixture Git log + diff 类型(§F)

Node fixture(Windows 可跑,execFileSync git,core.autocrlf=false):多层目录 + 源码/README/配置/无扩展名 + Unicode/空格/大小写文件名;commit 序列 C0(初始树)→ C1(modify a.ts)→ C2(rename old.ts→new.ts)→ C3(delete)→ C4(copy);symlink(mode 120000,cacheinfo)+ submodule(mode 160000,cacheinfo)fixture 跨平台。

## 2. full index 节点数(§F)

`节点数 = tracked files(有 source_binding)+ 推导非空目录 + 1 project root`。目录节点**无** source_binding(design §6.1 推导节点无 blob);file/symlink/submodule 有 binding(repository/source_path/indexed_revision/blob_oid/source_kind)。`git ls-tree -r -z` 为事实源(非 readdir)。

## 3. rename 前后同内部 ID(§F,internal 证据)

`wiki-v2-indexer-rename-spotcheck.test.ts`:`git mv alpha.ts → zeta.ts`(git 发 R 非 D+A)。rename 前后 `nodeRepo.getById(alphaId)` 同 rowid;summary/content **不变**(curated 保留,不重生成);revision 恰 +1;outgoing+incoming wiki_links 存活(FK 按 id);source_binding source_path 随移、同 node_id;FTS 索引新 name token(searchFts("zeta") 命中新路径,无 SQLITE_CORRUPT);恰 1 active 新 name 节点。swap A↔B 两阶段(updateChildPathAndName)亦验:两节点到正确终态,ID/summary 保留,无 temp 残留,integrity_check=ok。

## 4. 故障 rollback 前后(§F)

故障注入(sync 中途抛)→ wikiDb.transaction 回滚:`indexed_revision` 保持旧值;`sync_status=failed` + `last_error` 设(独立小事务);节点/source_binding/audit 回提交前。重试同 SHA 成功。bogus target SHA(不存在)→ sync 顶 cat-file -e 校验 → failed,indexed_revision 不推进。enrich 阶段(diffNameStatus/listTreeAtRevision 抛)→ try/catch → failed(不外泄)。

## 5. Wiki content 未复制源码(§F)

所有 file 节点 `content=''`(空);README/source 正文不入 content;summary 是确定性骨架(project root: name+branch@shortrev+counts;dir: direct/总子项;file: source kind+lang/ext+repo-relative path)。§G 拒绝条件未触发。

## 6. source read/search 安全(§D)

- indexed read:`git cat-file -p <rev>:<path>` 返精确 blob 行范围(匹配 indexed_revision);`git ls-tree <rev> -- <path>` + `cat-file -s <oid>` 元数据。
- workspace read:realpath + relative + symlink 逃逸检查(`..`/绝对/case 绕过拒);binary 检测(首 8KiB NUL)→ 元数据/拒正文。
- ripgrep:cwd/glob/scope 服务端绑定推导(模型不能传绝对 cwd);regex ≤2048B / timeout 2s / 输出 2MiB / 结果 200 限额 → REGEX_LIMIT_EXCEEDED/REGEX_TIMEOUT + 进程终止;结果映射回 canonical path;Windows `.\` 归一后剥 `./`(repo-root 命中正确解析);resolveRipgrepBinary(env > bundled > 多扩展[cpptools/openai.chatgpt/Copilot/...]> PATH,ENOENT→SOURCE_UNAVAILABLE)。

## 7. commit 集成(§C)

成功 commit/merge → indexer sync + 记录目标 SHA;Git 成功 + Wiki 失败 → Git 保留 + 项目显示 stale/failed 可重试同 SHA;显式 full reindex 从空 project subtree 重建相同 canonical tree;`/api/archivist/:projectId/scan|rescan-full|rebuild-subtree` 路由调新 indexer;旧 WikiSkeletonService **无可达写路径**(delegating shim,§C);启动不阻塞全量扫描(bounded rev-parse stale-check + 队列 + 服务旧 indexed snapshot)。

## 8. 验证命令(§E)

| 命令 | 结果 |
|---|---|
| typecheck / build:lib | exit 0 |
| test:unit | wiki 子系统(sub-01/02/03+legacy)全绿;sub-03 wiki-v2 5 文件 + rename-spotcheck + m2/sub12 共 112/112;全量仅 3 预存非 wiki 失败(sub5-dead-code-removed / deferred-dangling-tasklink / po-sub2-provider-usage)+ Windows vitest exit-127(teardown-only) |
| check:links | 262 链接全解析 |

## 9. 修改文件(§F)

commit `69908c4`:19 文件,+11858/-3352。
- 新增:`src/server/wiki/{wiki-project-indexer,wiki-source-service,wiki-source-search}.ts`、6 个 `tests/unit/wiki-v2-{indexer,indexer-rename-spotcheck,sync,source,integration}.test.ts`
- 改:`src/server/{archivist-git,index,db-migration}.ts`、`src/server/wiki-skeleton-service.ts`(shim)、`src/server/wiki/{wiki-node-repository,wiki-path}.ts`(joinWikiPathMulti + updateChildPathAndName)、`tests/unit/{m2-wiki-archivist,sub12-summary-truncation}.test.ts`(BLOCKER6 更新到新 shim)、`docs/visualization/code-graph.*`
- 删:`src/server/wiki-scan-cursor-store.ts`(cursor→wiki_repositories)

## 拒绝条件(§G)

Git tree 事实源(非 readdir)✓;全 tracked 文件索引(非仅 code/doc)✓;rename 保 ID(非 delete+create)✓;sync 失败不推进 revision ✓;summary/content 不存源码正文 ✓。

## 验收记录(3 轮循环)

- **round-1**(3 lens + synthesis):FAIL —— 6 blocker(多段路径 joinWikiPath 崩 / `--no-renames=false` git 拒致 sync 空转推进 revision / rename swap phase-1 没改 name 撞 UNIQUE / readIndexedSource cat-file --batch-check argv 错恒 available=false / sync 到不存在 SHA 静默成功 / 删 wiki-scan-cursor-store 破 m2+sub12 测 import)+ concern。3 lens 独立 tri-确认;implementer 自测(根级文件 fixture)漏掉了多段路径崩。
- **implementer FIX 轮 1**:joinWikiPathMulti(8 处)/ --find-renames / updateChildPathAndName / cat-file -p+ls-tree / sync 顶 SHA 校验 / enrich 错置 failed / 绝对 source_root 拒 / ripgrep ./ 剥 / rg 解析。子目录 fixture probe 验证。
- **round-2**(3 lens + synthesis):FAIL —— BLOCKER6 修了 + 规约 PASS + BLOCKER 2/4/5 确认,但 2 新 blocker(swap FTS 损坏:updateChildPathAndName 改 name 没 FTS 同步 → phase-2 fts-delete 不匹配 → SQLITE_CORRUPT / Windows ripgrep `.\` 未处理:剥 ./ 在反斜杠归一前)。
- **implementer FIX 轮 2**:updateChildPathAndName 加 FTS 同步(read old→ftsDeleteCommand→UPDATE→syncFtsInsert)/ ripgrep 先 `\`→`/` 归一再剥 `./` / resolveRipgrepBinary 扩探测(openai.chatgpt 等)。两 probe 在真实 Windows 主机验证。
- **round-3**(3 lens + synthesis):**PASS** —— blockerFindings 空,zero wiki-v2 failures,3 lens 全 PASS。

## 给 Plan 04 的 handoff note

- sub-03 构造了 WikiService(数据面)+ WikiProjectIndexer(镜像)+ WikiSourceService/Search,但 **Wiki tool 尚未注册**(plan-04 接 Agent tool)+ source service/search 实例经 index.ts 闭包可达,plan-04 加 getter/路由。
- production rg bundling(sub-08 packaging):resolveRipgrepBinary 当前依赖 VS Code 扩展或 PATH,生产需 bundle rg.exe(ZERO_CORE_DIR/bin/rg)。
