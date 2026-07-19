# Acceptance 08：最终切换、旧实现清理与加固

对应 [Plan 08](plan-08-cutover-hardening.md)。

## A. Legacy absence

- [ ] 生产 runtime 无 `ProjectWikiStore`、legacy project-wiki router、anchor injection 或 disk-detail fallback。
- [ ] Agent schema 无旧 memory/doc action、nodeId/short ID 寻址。
- [ ] Runtime/CallerCtx/Agent Editor 无 `wikiAnchors/wikiAnchorNodeIds` 行为字段。
- [ ] 生产代码不查询/写入 `project_wiki`，不读旧 Wiki Markdown。
- [ ] `db-migration.ts` 不再创建/迁移/加列 `project_wiki`；fresh core.db 无该表，既有表启动前后 schema/count 不变。
- [ ] `ensureWikiSkeleton/rebuildStaleStructureLayouts` 和 `project_wiki` data subscriber 在生产 runtime 不可达。
- [ ] 无 `header:/intent:/structure:` 生成或解析逻辑。
- [ ] 无 `WikiLegacy/WikiV2` 用户可见工具或 hidden fallback。

允许历史 migration/archive 文档出现旧词；grep 证据必须人工分类，不能只按零命中判断。

## B. 文件系统保护

- [ ] Read/Write/Edit/Grep/Glob/Shell 对 db/core.db、db/wiki.db、各自 WAL/SHM、backup、runtime 均拒绝。
- [ ] 相对路径、引号、环境变量、大小写、symlink/junction 和 shell 拼接绕过有测试。
- [ ] 合法项目源码访问不被误拦截。
- [ ] attachment 访问经 API/grants，不开放 Wiki 根目录。

## C. 备份恢复

- [ ] snapshot 使用 Backup API/VACUUM INTO，不复制活跃 DB 文件。
- [ ] 并发写入期间 snapshot 可打开且 integrity/foreign key 通过。
- [ ] restore 到临时实例后 roots、nodes、links、addresses、repositories、FTS 查询一致。
- [ ] 活跃 DB/WAL 不进入 Git 备份 commit。
- [ ] explicit legacy cleanup 不在普通 startup 自动执行。
- [ ] Core/Wiki snapshot manifest 成对记录但分别验证；写 Wiki 不触发 Core checkpoint/mtime/WAL 变化。
- [ ] readonly 诊断不会对活跃数据库执行 checkpoint/VACUUM/migration。

## D. 规模与查询计划

- [ ] 100k 自动 benchmark 完成且无 OOM/文件数爆炸。
- [ ] 1M 发布前 benchmark 有记录；若 CI 不跑，result 必须附人工输出和硬件信息。
- [ ] path/parent/link 查询计划使用对应索引，无全表 scan。
- [ ] FTS top-k 不把全部 content 拉入 Node 内存。
- [ ] authorized search 随 grant scope 数量有界，不先全库结果后过滤。
- [ ] Windows 上 Wiki 物理文件数量与节点数无关，仅 DB/WAL/附件/备份增长。
- [ ] result 附 1M benchmark 原始命令日志、日期、commit SHA、硬件、数据生成参数；只有总结文字不通过。
- [ ] 10,000 节点 Agent move 与更大管理批量 move 均有延迟/WAL/rollback 记录。
- [ ] 大项目启动不等待 full reindex，background 状态和进度可观察。

## E. 文档与构建

- [ ] arch 04/05/06/07/08/12 与新实现一致。
- [ ] docs link check 通过。
- [ ] 新模块文件头/公共类型注释符合仓库约定。
- [ ] 旧 tests 被等价或更强的新 tests 替代，不是简单删掉。

## F. 验证命令

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run test:e2e
npm run check:links
```

另运行 Wiki benchmark、integrity、backup/restore 和 legacy grep 审查。

## G. 必备证据

`result-08.md` 包含：

- legacy grep 分类表。
- filesystem bypass 测试矩阵。
- backup/restore 一致性报告。
- 100k/1M benchmark 输出和 query plans。
- 完整测试命令、耗时与结果。
- 架构文档更新列表。

## H. 拒绝条件

- 旧实现仍可被生产入口调用。
- 仅 grep 通过但运行时仍有 `project_wiki` subscriber/旧 router。
- 直接复制运行中的 wiki.db 当备份。
- Agent shell 可访问 DB/WAL/backups。
- 没有 1M 规模记录就宣称百万节点目标已验证。
- 为通过性能门槛关闭权限过滤、FTS 同步或审计。
