# Acceptance P6 — template 改名 + prompt + seed

> **前置**:P0/P2。**核心**:验「Preset→Template 改名 + §12 prompt + fresh-DB seed + protected」。

### Preset → Template 改名
- [ ] `role-presets.ts`→`role-templates.ts`;`ROLE_PRESETS`→`ROLE_TEMPLATES`;getPreset/listPresets→getTemplate/listTemplates;buildAgentFromPreset→buildAgentFromTemplate;RolePreset→RoleTemplate
- [ ] preset-router→template-router;`/api/presets`→`/api/templates`;IPC `templates:*` + ROUTE_MAP 同步(契约 1.1,grep out/main 确认)
- [ ] zero-admin 引用同步;grep 无 Preset 残留(除注释/legacy)
- [ ] buildAgentFromTemplate 不拷 roleTag 到 AgentRecord

### §12 prompt
- [ ] zero/pm/lead/archivist/developer/reviewer/qa system prompt 按 §12 适配(lead verify 门/不合并、PM 判覆盖、archivist 引用文档+管 main)
- [ ] dev/reviewer/qa 的 Rules/Output format 已挪到调用 prompt(工具/dispatch 模板),system prompt 只剩身份
- [ ] analyzer/planner 模板原样保留未动

### fresh-DB seed
- [ ] 空库启动 → 自动 seed:zero agent(workspaceDir=~/.zero-core)+ wiki knowledge/software-dev 节点
- [ ] software-dev 节点含工作流配置草稿(角色/subagents/cron 建议)
- [ ] seed 触发点正确(startServer 内、store 建好后、restoreAllSessions 前、agentStore.list().length===0)

### protected
- [ ] Agent(delete: zero) reject;Wiki(delete: software-dev 节点) reject
- [ ] 正常删除不受误伤(只拦这两个 id)

### 测试(sub2 写 + 跑)
- [ ] seed 测试:空库 → 两条 seed;非空库 → 不重复 seed
- [ ] protected-delete 测试:zero/software-dev 删被拒,其他正常删
- [ ] prompt 内容断言(关键字段:lead 提交 verify、PM 判覆盖、archivist 合并)
- [ ] 改名后 import 无断(全仓 build 通过)

### 边界(不验证)
- [ ] ~~AgentRecord 字段~~ → P0
- [ ] ~~software-dev playbook 精细内容~~ → 后续 refine
