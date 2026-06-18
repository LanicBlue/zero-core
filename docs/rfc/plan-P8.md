# Plan P8 — UI 收尾(wiki 浏览器 + agent 配置页)

> **依赖**:P1(wiki 多锚点/注入)+ P2(AgentRecord.subagents/wikiAnchors)。**验收**:`acceptance-P8.md`。
> **文件**:`src/renderer/components/wiki/WikiPage.tsx`、`WikiTree.tsx`、`WikiDetail.tsx`、agent 配置页组件。

**为什么在后**:依赖 wiki 多锚点(P1)+ AgentRecord harness 字段(P2)就绪。

## 设计细节要求

### WikiPage 升级为全局树浏览器(§10.9)

1. 左树:全局根 → knowledge/projects/memory,按 session 锚点截断可见性(zero 看全树,项目角色看本子树 ∪ memory)。
2. 右节点正文:`Wiki(expand)` 全文;docPointer 跳转原文按钮(项目文件用 FS 读 workspaceDir)。
3. 树渲染按 session 角色的锚点并集(P1 守卫)。

### agent 配置页(§11.10)

4. 身份:name / systemPrompt / model / provider(无 roleTag)。
5. 工具:toolPolicy(硬编码工具开关)。
6. 委派:subagents 列表(加/删 target agentId + name/description)。
7. wiki 锚点:自由锚点加/删 + 每锚点 inject(system/context/off)+ depth;自动锚点(memory/project)的 inject 也可覆盖。
8. template 参考:listTemplates/getTemplate(从模板建)。

## 风险

- **树渲染性能**:大 wiki 树前端渲染卡顿;虚拟滚动 + 按需 expand。
- **配置页字段多**:harness 字段(subagents/wikiAnchors/toolPolicy)结构嵌套,表单易出错;JSON 编辑兜底。
- **权限与 UI 一致**:UI 显示的可见域必须和 store 守卫一致,别 UI 看得到但操作被拒。

## 不在本阶段

- wiki 多锚点/注入机制 → P1;AgentRecord 字段 → P0;subagents 委派 → P2。本阶段纯 UI 接现有能力。
