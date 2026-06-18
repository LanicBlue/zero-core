# Acceptance P8 — UI 收尾

> **前置**:P1/P2。**核心**:验「wiki 浏览器按角色可见域 + agent 配置页改全 harness」。

### WikiPage 全局树浏览器
- [ ] 左树按 session 锚点截断:zero 看全树,项目角色看 本子树 ∪ memory
- [ ] 右节点正文 expand 全文;docPointer 跳转原文
- [ ] UI 可见域与 store 守卫一致(看不到的不显示,显示的能操作)

### agent 配置页
- [ ] 身份:name/systemPrompt/model/provider(无 roleTag)
- [ ] 工具:toolPolicy 硬编码工具开关
- [ ] 委派:subagents 列表加/删(name/description)
- [ ] wiki 锚点:自由锚点加/删 + inject(system/context/off)+ depth;自动锚点 inject 可覆盖
- [ ] template 参考:listTemplates/getTemplate(从模板建)

### 测试(sub2 写 + 跑)
- [ ] e2e:wiki 浏览器渲染(zero 全树 vs 项目角色子树)
- [ ] e2e:agent 配置页编辑保存(subagents/wikiAnchors/toolPolicy round-trip)
- [ ] 权限一致:UI 不可见的节点,操作也 reject

### 边界(不验证)
- [ ] ~~wiki 多锚点/注入机制~~ → P1
- [ ] ~~AgentRecord 字段~~ → P0
