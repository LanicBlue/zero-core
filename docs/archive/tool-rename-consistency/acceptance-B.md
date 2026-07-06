# Acceptance-B:ALL_TOOLS key 派生

> 节点 B 验收。对应 [plan-B.md](plan-B.md)。

## 实施核对(review sub-B 改动)

- [ ] `src/runtime/tools/index.ts`:`ALL_TOOLS` 不再是工具名作 key 的字面量;改为 `Object.fromEntries(TOOL_DEFS.map(d => [getToolName(d), d]) + platform)`。
- [ ] `TOOL_DEFS` 数组顺序 = 原字面量顺序(platform 仍末尾)。
- [ ] `getToolName` 已 import。
- [ ] 无其它处依赖"ALL_TOOLS 是字面量"的代码被破坏(`registerRuntimeTools`/`buildToolsSet`/`getToolCategories`/`getAllToolInfo` 全用 `Object.entries`,派生对象兼容)。

## 测试(sub2 写 + 跑绿)

- [ ] **契约测试(新增)**:对每个 `ALL_TOOLS` entry 断言 `key === getToolName(def)`(结构性单一来源的直接验证)。
- [ ] **契约测试(新增)**:种子策略(`builtin-role-templates.ts` MANAGEMENT_TOOLS)的 tools key ⊆ `ALL_TOOLS` keys ∪ `RENAMED_TOOLS` keys。
- [ ] `p2-agent-runtime.test.ts` 的 Subagent 断言改造后通过(运行时或文本兜底,记录实际用了哪条)。
- [ ] **顺序稳定**:`Object.keys(ALL_TOOLS)` 与改造前快照一致(或至少 platform 在末尾、基础工具在前;若加 snapshot 测试,记录顺序)。

## 构建 + 回归
- [ ] `npm run build:lib`(tsc)绿。
- [ ] `vitest` 全绿(基线 957,本 branch 起步)。
- [ ] 手测(可选):`/tools` API 返回顺序与改名前一致。

## 完成
全绿 → commit(`feat(tools): ALL_TOOLS key 派生 + 契约测试`)→ 进 sub-D。不绿 → review 意见回 sub-B。
