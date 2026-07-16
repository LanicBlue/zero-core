# Acceptance 00：数据库基础、统一布局与命名

对应 [Plan 00](plan-00-database-foundation.md)。

## A. 布局与命名

- [ ] fresh profile 只创建 `${ZERO_CORE_DIR}/db/core.db`，不创建根目录 `sessions.db` 或 `knowledge.db`。
- [ ] 生产代码、脚本和活动文档使用 `CoreDatabase/core.db`；不存在生产可调用的 `SessionDB` alias。
- [ ] 所有数据库默认路径来自同一个 `database-paths` 模块。
- [ ] Plan 00 不提前创建 `wiki.db`。

## B. 旧 Core DB 安全切换

- [ ] 仅有旧 `sessions.db` 时，既有 Agent、Project、Session、Work 和 Cron fixture 在 `core.db` 完整 round-trip。
- [ ] 切换前完成 WAL checkpoint，目标临时库通过 integrity/foreign key 后才原子 promote。
- [ ] 原 `sessions.db` 被保存为一次性 `backups/core/pre-layout-*.db`，旧 WAL/SHM 不残留在活动位置。
- [ ] 中断后重试幂等，不覆盖已验证的 `core.db`，不生成两个活动事实源。
- [ ] `sessions.db` 与 `core.db` 同时存在且无有效 marker 时稳定返回 `DATABASE_LAYOUT_CONFLICT`。
- [ ] `layout-v1.json` 包含 source/target/hash/time/version/check 结果和 complete 状态。

## C. 退役数据库删除

- [ ] `knowledge.db`、`knowledge.db-wal`、`knowledge.db-shm` 被直接删除，不备份、不导入。
- [ ] 文件不存在时启动幂等成功。
- [ ] 相邻的 `knowledge.db.keep`、其他 `.db` 和目录不被误删。
- [ ] 删除使用精确绝对路径白名单，无 glob、递归或跨 shell 拼接。
- [ ] 结构化日志记录删除动作。

## D. 生命周期与周边工具

- [ ] DatabaseManager 是生产 composition root 唯一的 CoreDatabase 生命周期所有者。
- [ ] self-update snapshot/restore、运行检测、health、Platform paths 和诊断脚本均使用新路径。
- [ ] readonly 诊断不会 checkpoint、VACUUM 或 migrate 活跃数据库。
- [ ] 打开、checkpoint、close 的顺序有自动化测试；进程退出后无未关闭句柄。

## E. 验证命令

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run check:links
```

额外运行数据库布局、切换、删除和 self-update restore 测试。

## F. 必备证据

`result-00.md` 必须包含：

- fresh/legacy/conflict/incomplete 四类布局状态矩阵；
- 旧库切换前后表数和关键对象 count/hash；
- integrity/foreign key 结果；
- knowledge 精确删除与相邻文件保留证据；
- 所有硬编码旧路径的 grep 分类；
- commit SHA、命令、耗时和修改文件。

## G. 拒绝条件

- 直接删除或覆盖现有 `sessions.db` 而未先生成并验证 `core.db`。
- 将 `knowledge.db` 迁入新 Wiki 或 Core DB。
- 同时运行两个 Core 事实源。
- DatabaseManager 暗中提供跨库 transaction。
- 为通过测试保留生产 `SessionDB` fallback。

