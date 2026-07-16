# Acceptance 03：Project Git 语义镜像

对应 [Plan 03](plan-03-project-git-mirror.md)。

## A. 全量镜像

- [ ] 对 fixture commit，所有 tracked 文件均存在唯一 source-bound 节点。
- [ ] 所有推导非空目录存在，Git 不存在的平行 features/flows/docs 分支不存在。
- [ ] untracked 和 ignored 文件不进入 Wiki。
- [ ] project root/目录/文件均有非空确定性 summary，但 Wiki content 不含源码或 README 正文。
- [ ] `source_root` 正确裁剪；越界或不存在的 source_root 被拒绝。
- [ ] 文件名空格、Unicode、大小写在 canonical path 与 source_path 中保持正确。
- [ ] symlink 不被跟随；submodule 不被隐式递归。

## B. 增量同步

- [ ] add 创建缺失目录链和文件节点。
- [ ] modify 只更新 source binding/blob/stale 状态，不覆盖 curated summary/content/links。
- [ ] delete 归档原节点，不留下 active source binding。
- [ ] rename 保留内部 ID、summary、content、revision 历史和 links，只改变 path/source binding。
- [ ] Git diff 中 copy 按新节点处理，不复用源节点 ID。
- [ ] 故障注入后所有结构变更 rollback，`indexed_revision` 不推进，状态为 failed 且可重试成功。
- [ ] 对同一 SHA 重试幂等，不增加节点/revision/audit 噪声。

## C. Commit 集成

- [ ] 成功 commit/merge 后调用 indexer 并记录目标 SHA。
- [ ] Git 成功、Wiki 失败时 Git commit 保留且 UI/service 可读到 stale/failed。
- [ ] 显式 full reindex 可从 Wiki 空 project subtree 重建相同 canonical tree。

## D. Source read/search 安全

- [ ] indexed read 返回与 `indexed_revision` blob 完全一致的指定行范围。
- [ ] workspace read 标记 dirty/revision，并拒绝 checkout/worktree 外路径。
- [ ] symlink、`..`、绝对路径和路径大小写绕过不能逃逸。
- [ ] 二进制不作为文本返回。
- [ ] ripgrep 的 cwd、glob 和 scope 由服务端绑定推导，模型不能传绝对 cwd。
- [ ] source search 结果均能映射回唯一 Wiki canonical path。
- [ ] case-insensitive 与 regex 搜索有 fixture 测试。

## E. 验证命令

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run check:links
```

## F. 必备证据

`result-03.md` 包含：

- fixture Git log 与各 commit 的 diff 类型。
- full index 节点数 = tracked files + inferred dirs + project root 的计算。
- rename 前后同一内部 ID 的查询证据（内部测试证据，不进入 Agent API）。
- 故障 rollback 前后 repository revision 和节点快照。
- Wiki content 未复制源码的断言结果。

## G. 拒绝条件

- 用递归文件系统扫描替代 Git tree 事实源。
- 只索引代码/文档后缀，遗漏 tracked 文件。
- rename 通过 delete+create 丢失语义或 links。
- sync 失败仍推进 revision。
- 在 summary/content 存放完整源码或仓库文档正文。

