# Acceptance P1 — wiki 存储分离 + 多锚点

> **前置**:P0 完成(wiki_nodes.links、AgentRecord.wikiAnchors 就位)。**核心**:验「正文磁盘 + FS 隔离 + 多锚点可见性 + 注入渲染」,不验委派/memory 合并(P2)。

### 存储:结构/内容分离
- [ ] wiki 正文在 `~/.zero-core/wiki/<path>.md`;改正文不动 DB 行(只动文件)
- [ ] DB wiki_nodes 行只存结构字段;`detail` 列已删(内容已导出磁盘);`type` 列已删
- [ ] `docPointer` 指节点正文文件路径,不向 agent 暴露(agent 只见 nodeId)
- [ ] migration:旧库 detail 导出成 .md 后删列;type 按位置归位 projects/knowledge/memory

### FS 隔离
- [ ] agent 用 Shell/Read/Grep/Glob/Write/Edit 访问 `~/.zero-core/wiki/` 被 reject
- [ ] wiki 工具用 nodeId 操作,不暴露文件路径;workspaceDir 读取不受影响(不误拦)

### 多锚点权限
- [ ] `assertNodeInsideProjectScope`(type-based)已废;守卫改为「目标在 caller 任一锚点子树内」
- [ ] session 锚点 = 自动(memory/<agentId> + project=wiki-root:<projectId>) ∪ 自由(wikiAnchors)
- [ ] 项目角色 session 只看 本项目子树 ∪ 自己 memory;zero 看全树(全局根)
- [ ] 读 + 写用同一道锚点边界(写域 = 可见域)

### 锚点注入
- [ ] project 锚点注入 子树前 2 层 title+summary(不带正文);depth 可配
- [ ] memory 锚点注入 索引(每条 title + nodeId 链接,不展开内容)
- [ ] system 类锚点走 SystemPromptAssembler section(可缓存);context 类走 PreLLMCall(每轮重算,不入 history)
- [ ] 自动锚点派生正确(memory/<agentId>、wiki-root:<projectId>)

### migration 双路径
- [ ] fresh DB:新 schema(detail/type 无,正文走文件),正常起
- [ ] 旧 DB:detail 导出磁盘后删列成功,不崩;type 归位

### 测试(sub2 写 + 跑)
- [ ] store:正文磁盘 round-trip(写后读一致);DB 行不含正文
- [ ] scope guard:多锚点并集可见性(项目角色 A 看不到项目 B / 全局根 / 别 agent memory)
- [ ] 注入:snapshot project 2 层结构 + memory 索引渲染输出
- [ ] FS 隔离:agent-loop 拦截 wiki 路径访问(reject 带清晰错误)

### 边界(不验证)
- [ ] ~~subagents 委派 / agent-as-tool 废~~ → P2
- [ ] ~~Wiki action 工具~~ → P3(本阶段注入/守卫就绪即可,工具 P3 接)
- [ ] ~~knowledge/software-dev seed~~ → P6
