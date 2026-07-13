# Issue: doc-artifacts-as-files

- **状态**:① issues(问题记录)
- **提出**:2026-07-11
- **类型**:改进(架构)

## 问题

sessions.db 里有一类「文档型」数据(agents / wiki / templates),本质是「带 frontmatter 的 markdown 文档」,现在却以 blob 存 DB 行、靠专用工具访问;而 skill 体系已证明这类数据更适合「文件 + 虚拟路径 + 基础文件工具」模型。同一类数据两套存储/访问机制:文档型数据既不可 git 版本化、也不可在编辑器里直接改,且养出一组本可塌进基础工具的专用工具。

## 现状 / 真相源 / 影响面

### 已文件化(参考模型)
- **skills**:纯文件 `~/.zero-core/skills/<id>/SKILL.md` + 虚拟前缀 `[skills]/`(`SKILL_VIRTUAL_PREFIX` [skill-paths.ts:41](../../src/tools/skill-paths.ts#L41))。system prompt 只注入 name+description(渐进式披露),agent 经基础工具(Read/Write/Edit/Glob/Grep)按需读写。设计动机见 [archive/skill-system/design.md](../../archive/skill-system/design.md):渐进式披露 / 统一工具接口 / 沙箱基础 / 可移植。
- **wiki 正文**:**已在磁盘**(`~/.zero-core/wiki/` 镜像树,`WikiStore.diskPathFor` [wiki-node-store.ts](../../src/server/wiki-node-store.ts);架构说明见 [arch/06-knowledge-subsystems.md](../../arch/06-knowledge-subsystems.md));DB `project_wiki` 表只存索引(parentId / path / title / summary / docPointer)。**半迁移状态**。
- attachments / archives:纯文件。

### DB 里、且 agent 经专用工具读写的「文档型」数据

| 表 | 专用工具 | 读写 | 文档部分 |
|---|---|---|---|
| `agents` | `AgentRegistry` [agent-registry.ts:187](../../src/tools/agent-registry.ts#L187) | list / get / create / update / delete + 模板 | system_prompt(大段散文)+ 结构化配置 |
| `templates` | `AgentRegistry`(`listTemplates` / `getTemplate`) | 只读 | 同上 |
| `project_wiki` | `Wiki` [wiki-tool.ts](../../src/tools/wiki-tool.ts) | 结构 op + 文档 op | 节点正文 markdown |

### DB 里、但「状态/结构型」(不适合文件化,留 DB)
有状态机 / 历史(`requirements` [flow-tool.ts](../../src/tools/flow-tool.ts)、`delegated_tasks`)、结构化注册表(`crons` [cron-tool.ts](../../src/tools/cron-tool.ts)、`project_work` [work-tool.ts](../../src/tools/work-tool.ts))、含密钥(`providers`,api_key)、事务时序(`steps` / `messages` / `tool_executions` / `provider_usage`)。

**分界线 = 数据形态**:文档型(散文 + 少量 frontmatter)适合文件 + 虚拟路径;状态/结构型(状态机、历史、密钥、cron 表达式、时序追加)留 DB。

### 影响面(若推进)
`wiki-node-store` / `wiki-tool`、`agent-store` / `agent-registry`、`template-store`、system-prompt 注入(子代理 name+description)、启动迁移、新增 `[agents]/` `[wiki]/` 虚拟前缀解析(现仅 `[skills]/`)。

## 下一步

进 ② design 细化方案(`/effort design`)。核心待决策:① 文档型(agents / wiki / templates)是否以及如何迁文件 + 虚拟路径;② 校验 / 结构语义(子代理图校验、wiki 树 type 继承 / title 唯一)是吃进文件写入层,还是保留薄 store 做不变式;③ 迁移顺序。**暂不实施。**
