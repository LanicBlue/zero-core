# acceptance-1:Wiki 注入默认根调整

> 对应 [./sub-1.md](./sub-1.md)。

## 功能验收

1. **memory-root 默认 inject=system**:`resolveAnchors` 对 memory-agent 根输出 `inject:"system"`(不再是 context)。
2. **zero global-root 注入**:zero(无 projectId)拿到 global-root 且 `inject:"system"`,渲染 doc+一层 summary(受 doc/summary cap 有界)。
3. **有 project 的 agent**:仍注入 project-root(system);memory-root 也进 system。
4. **冻结快照(本 sub 验冻结部分)**:wiki-system-anchors section `cacheBreak:false`;mid-session wiki 写(memory turn / docWrite)**不触发** `invalidate("wiki-system-anchors")` → prefix cache 不失效(sub-7 anchor merger 已落地冻结;本 sub 改默认根后保持)。"压缩后刷新"由 sub-3 压缩流程保证,本 sub 不验。
5. **free wikiAnchors 保留**:可经 agent-registry 加自定义锚点;per-anchor `inject:system|context|off` 仍生效。注:sub-7 anchor merger 已把 context 锚点也并入 cached wiki-system-anchors section(与 system 同享冻结快照,不每轮重算)——本 sub 沿用 merger 现状(实现选 A,不回退)。
6. **渲染格式不变**:root doc + 一层 children summary(`renderAnchorOutline`)。

## 不破坏验收

7. 现有 wiki 注入测试 + system prompt 装配测试仍过。

## build

8. **typecheck 过**(`build:lib`)。
