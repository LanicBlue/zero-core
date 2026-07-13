# acceptance-1:Wiki 注入默认根调整

> 对应 [./sub-1.md](./sub-1.md)。

## 功能验收

1. **memory-root 默认 inject=system**:`resolveAnchors` 对 memory-agent 根输出 `inject:"system"`(不再是 context)。
2. **zero global-root 注入**:zero(无 projectId)拿到 global-root 且 `inject:"system"`,渲染 doc+一层 summary(受 doc/summary cap 有界)。
3. **有 project 的 agent**:仍注入 project-root(system);memory-root 也进 system。
4. **冻结快照**:system-prompt wiki-anchors section 在 session 内稳定;mid-session wiki 写(memory turn / docWrite)**不触发**该 section 重渲染 → prefix cache 不失效。压缩后刷新。
5. **free wikiAnchors 保留**:可经 agent-registry 加自定义锚点;per-anchor `inject:system|context|off` 仍生效(inject:system 享冻结,inject:context 每轮重算)。
6. **渲染格式不变**:root doc + 一层 children summary(`renderAnchorOutline`)。

## 不破坏验收

7. 现有 wiki 注入测试 + system prompt 装配测试仍过。

## build

8. **typecheck 过**(`build:lib`)。
