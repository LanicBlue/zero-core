# Issue: doc-artifacts-as-files

- **状态**:① issues(问题记录)
- **提出**:2026-07-11
- **类型**:改进(架构)
- **范围更新**（2026-07-16）：本 issue 不再负责 Wiki 重构。早期独立 effort **wiki-search** 已废止（详见 [`../../archive/wiki-search/issue.md`](../../archive/wiki-search/issue.md)）；后续 Wiki 重构另有尚未实施的 [`../../plan/wiki-system-redesign/README.md`](../../plan/wiki-system-redesign/README.md)。本 issue 仅保留 agents/templates 文件化与虚拟路径前缀方向。

## 问题

sessions.db 里有一类「文档型」数据(agents / wiki / templates),本质是「带 frontmatter 的 markdown 文档」,现在却以 blob 存 DB 行、靠专用工具访问;而 skill 体系已证明这类数据更适合「文件 + 虚拟路径 + 基础文件工具」模型。同一类数据两套存储/访问机制:文档型数据既不可 git 版本化、也不可在编辑器里直接改,且养出一组本可塌进基础工具的专用工具。

## 现状 / 真相源 / 影响面

### 已文件化(参考模型)
- **skills**：纯文件 `~/.zero-core/skills/<id>/SKILL.md` + 虚拟前缀 `[skills]/`（`SKILL_VIRTUAL_PREFIX`，见 [`../../../src/tools/skill-paths.ts`](../../../src/tools/skill-paths.ts)）。system prompt 只注入 name+description（渐进式披露），Agent 经基础工具按需读写。设计动机见 [`../../archive/skill-system/design.md`](../../archive/skill-system/design.md)。
- **Wiki 正文**：已在 `~/.zero-core/wiki/` 磁盘镜像树，路径派生见 [`../../../src/server/wiki-node-store.ts`](../../../src/server/wiki-node-store.ts)；DB `project_wiki` 保存索引与 `docPointer`。当前行为见 [知识子系统](../../arch/06-knowledge-subsystems.md)。
- attachments / archives:纯文件。

### DB 里、且 agent 经专用工具读写的「文档型」数据

| 表 | 专用工具 | 读写 | 文档部分 |
|---|---|---|---|
| `agents` | `AgentRegistry` [`agent-registry.ts`](../../../src/tools/agent-registry.ts) | list / get / create / update / delete + 模板 | system_prompt(大段散文)+ 结构化配置 |
| `templates` | `AgentRegistry`(`listTemplates` / `getTemplate`) | 只读 | 同上 |
| `project_wiki` | `Wiki` [`wiki-tool.ts`](../../../src/tools/wiki-tool.ts) | 结构 op + 文档 op | 节点正文 markdown |

### DB 里、但「状态/结构型」(不适合文件化,留 DB)
有状态机/历史（`requirements`、`delegated_tasks`）、结构化注册表（`crons`、`project_work`）、含密钥的 `providers` 以及事务时序数据（`steps`、`messages`、`tool_executions`、`provider_usage`）仍应留在数据库。相关工具见 [`flow-tool.ts`](../../../src/tools/flow-tool.ts)、[`cron-tool.ts`](../../../src/tools/cron-tool.ts) 和 [`work-tool.ts`](../../../src/tools/work-tool.ts)。

**分界线 = 数据形态**:文档型(散文 + 少量 frontmatter)适合文件 + 虚拟路径;状态/结构型(状态机、历史、密钥、cron 表达式、时序追加)留 DB。

### 影响面(若推进)
`wiki-node-store` / `wiki-tool`、`agent-store` / `agent-registry`、`template-store`、system-prompt 注入(子代理 name+description)、启动迁移、新增 `[agents]/` `[wiki]/` 虚拟前缀解析(现仅 `[skills]/`)。

## 下一步

进 ② design 细化方案(`/effort design`)。核心待决策:① 文档型(agents / wiki / templates)是否以及如何迁文件 + 虚拟路径;② 校验 / 结构语义(子代理图校验、wiki 树 type 继承 / title 唯一)是吃进文件写入层,还是保留薄 store 做不变式;③ 迁移顺序。**暂不实施。**
