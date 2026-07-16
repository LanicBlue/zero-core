# Final Acceptance：Wiki 重构端到端验收

> 本文只在 Acceptance 01–08 全部通过后执行。
> 验收者应与主要实现者不同。
> 任一关键场景失败，整个 Wiki 重构不得标记完成或归档。

## 1. 前置条件

- [ ] 01–08 各有 `result-XX.md`、commit SHA 和验收证据。
- [ ] 从干净 checkout 开始，无未说明的本地补丁。
- [ ] 使用全新 `ZERO_CORE_DIR` 或隔离测试 profile。
- [ ] 旧 `project_wiki`/旧 Markdown 不存在或存在但新 runtime 不读取。
- [ ] 准备至少两个 Agent、一个管理用户视角和一个包含多次 Git commit 的项目 fixture。

## 2. 场景 A：Fresh bootstrap 与身份

1. 启动应用。
2. 检查独立 Wiki DB 和固定根。
3. 创建 Agent `research-agent`、`coding-agent`。
4. 验证各自 Memory root。
5. 重命名其中一个 Agent。

验收：

- [ ] `wiki-root`、knowledge、memory、projects 唯一且幂等。
- [ ] 两个 Agent 只各有一个 Memory root，未自动写死子树。
- [ ] rename 保留 Memory root identity/content/links。
- [ ] Agent/API/Prompt/UI 不展示内部 ID。

## 3. 场景 B：权限隔离

配置：

- research-agent：own Memory 全权、Knowledge 只读、Project 只读。
- coding-agent：own Memory 全权、Project update/link。
- 不给任何 Agent 全局 root grant。

验收：

- [ ] research-agent 可写 own Memory，不能写 Knowledge/Project。
- [ ] research-agent 猜 coding-agent Memory existing/non-existing 均得到 NOT_FOUND。
- [ ] coding-agent 可 update/link Project 语义，但不能 create/move/delete source-bound 结构。
- [ ] 缺 action 返回 ACCESS_DENIED；无 scope 返回 NOT_FOUND。
- [ ] Wiki/source/both 搜索不泄露未授权关键词、path、snippet、link 或 count。
- [ ] Prompt 注入无权内容为零。

## 4. 场景 C：项目注册、镜像与导航

1. 注册位于任意本地目录的 Git project。
2. 绑定 project root 并 full index。
3. 打开 Project Prompt 和 Wiki Browser。
4. 使用 Wiki tool 执行 `search → expand → read → read source`。

验收：

- [ ] tracked files + inferred dirs 与 active source-bound 节点一一对应。
- [ ] untracked/ignored 不出现。
- [ ] Project Wiki 无平行 features/flows/docs 副本文档树。
- [ ] Wiki DB 不含源码/README 全文。
- [ ] standard Project Prompt 含目标、技术栈、入口、模块、revision/sync status 和 retrieval guidance。
- [ ] Agent 能从功能/摘要命中定位到 canonical file path 和准确 source lines。

## 5. 场景 D：Memory 与 Prompt

1. 在 research-agent Memory 动态创建 preference、procedure、experience、hypothesis。
2. 设置 durability/confidence/review_after。
3. 编译 compact/standard/deep。
4. 运行 memory archive/compression turn。

验收：

- [ ] Memory 子树由 Agent 动态组织，不要求固定目录名。
- [ ] standard 优先注入长期高价值内容并遵守 budget。
- [ ] 低置信度/过期内容不无条件注入。
- [ ] memory turn 只能写 own Memory。
- [ ] preview 与 runtime 文本、token 和 revision 一致。

## 6. 场景 E：编辑、关系与并发

1. 两个 client 读取同一 revision。
2. client A 局部更新。
3. client B 用旧 revision 更新。
4. 创建 project file → test 的 `tested_by` link。
5. 移动一个非 source Memory 节点。

验收：

- [ ] A 成功且 revision +1；B 返回 WRITE_CONFLICT，草稿不丢。
- [ ] replace/section 操作错误可区分 not found/ambiguous。
- [ ] 一条 link 同时在 outgoing/incoming 可查，无双写不一致。
- [ ] Memory move 后 link 和静态地址仍有效。
- [ ] audit 完整记录 actor/session/old/new revision/action。

## 7. 场景 F：Git commit 同步

依次 commit add、modify、rename、delete，然后触发同步。

验收：

- [ ] add/modify/delete 行为与 Plan 03 一致。
- [ ] rename 保留节点 identity、curated content 和 links。
- [ ] 故障注入时 indexed revision 不推进且状态 failed/stale。
- [ ] 重试到同一 SHA 幂等成功。
- [ ] UI、Prompt 和 tool result 对 stale/synced 状态一致。

## 8. 场景 G：逻辑地址与管理发布

1. 注册 `runtime://` 到 Project runtime 节点。
2. 将 target 节点 Git rename/move。
3. 修改 Agent grants/context 并 publish。

验收：

- [ ] runtime:// 继续解析同一节点的新 canonical path。
- [ ] 地址 impact preview 列出受影响 Agent/session。
- [ ] context 不隐式 grant；缺 read grant 阻止 publish。
- [ ] running session 在安全边界应用新 revision，进行中 tool call 不变。
- [ ] 普通 Wiki tool 无地址/权限/Prompt 管理 action。

## 9. 场景 H：Browser UI

- [ ] Global/Knowledge/Memory/Project/alias scope 可导航。
- [ ] 大 children 分页/懒加载，无整树请求。
- [ ] Wiki/Source/Both 与五种搜索模式可用。
- [ ] Overview/Content/Relations/Source/History 五 tab 正常。
- [ ] Markdown XSS fixture 不执行。
- [ ] WS create/update/move/link/sync 仅刷新相关缓存。
- [ ] Agent Access、Context、Address、Project Sync UI 与真实 runtime 行为一致。

## 10. 场景 I：安全旁路

尝试使用 Read/Write/Edit/Grep/Glob/Shell 访问 DB、WAL、SHM、backup 和 runtime；尝试 source path traversal、symlink/junction、regex DoS 和 renderer admin 伪造。

- [ ] 所有 Wiki 物理数据旁路被拒绝。
- [ ] 合法 workspace 源码访问不受影响。
- [ ] source 路径不能逃逸 checkout/worktree。
- [ ] regex 超时不阻塞主线程或后续请求。
- [ ] UI/LLM 参数不能伪造 identity/grants/admin。

## 11. 场景 J：备份、重启与规模

- [ ] 并发写入期间 snapshot 一致可恢复。
- [ ] restore 后 nodes/links/addresses/repositories/FTS 与 snapshot 一致。
- [ ] 应用重启后 Prompt、tool、UI 使用相同 revision。
- [ ] 100k 自动 benchmark 通过。
- [ ] 1M benchmark 有可复查报告，Windows 文件数量不随节点线性增长。
- [ ] 关键查询计划使用索引。

## 12. 全局命令门禁

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run test:e2e
npm run check:links
```

- [ ] 所有命令成功。
- [ ] 无 skipped/only 测试用于绕过关键验收；平台条件 skip 有书面理由。
- [ ] `PRAGMA integrity_check`、`foreign_key_check` 成功。
- [ ] legacy grep 审查无生产可调用旧路径。

## 13. 最终证据包

验收 Agent 创建 `result-final.md`，包含：

- 被验收 commit SHA 和环境信息。
- 01–08 result 链接。
- A–J 每个场景的实际证据。
- 全部命令结果与测试数量。
- 100k/1M benchmark、query plan、backup restore 报告。
- UI E2E trace/截图。
- 所有偏差、剩余限制和是否阻塞发布的判定。

## 14. 最终通过标准

只有同时满足以下条件才可标记完成：

- [ ] A–J 全部通过。
- [ ] 无跨阶段不变量被破坏。
- [ ] 无旧 Wiki fallback、无权限旁路、无源码正文复制。
- [ ] 设计文档、运行实现、Agent tool schema、Prompt、UI 和架构文档一致。
- [ ] 验收者明确给出 `PASS`，不是“基本可用”或“有非阻塞问题”。
