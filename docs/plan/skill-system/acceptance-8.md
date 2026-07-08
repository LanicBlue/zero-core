# acceptance-8:agent 运行时自建 skill

对应 `sub-8.md`。

## 用例

1. **有权限写新 skill**:`canAuthorSkills=true` 的 agent Write `[skills]/my-flow/SKILL.md`(合法 frontmatter + body)→ `~/.zero-core/skills/my-flow/SKILL.md` 落盘 → scanner 下次扫描读到。
2. **无权限拒绝**:`canAuthorSkills=false` 的 agent Write `[skills]/x/SKILL.md` → 拒绝(权限错误)+ 不落盘。
3. **读不受门禁**:无权限 agent 仍能 Read `[skills]/<id>/SKILL.md`(读始终放行)。
4. **外部只读**:有权限 agent Write 已存在的外部 skill(`[skills]/<external-id>/...`)→ 拒绝(外部只读)。
5. **id 护栏**:写新 skill 时 id 非 path-safe(含 `../`、空格、特殊字符)→ 拒绝;id 与已有冲突 → 拒绝。
6. **沙箱**:写已存在 app skill 时 `<rel>` 含 `../` 越界 → 拒绝。
7. **溯源**:agent 自建 skill 的 SKILL.md 含 frontmatter `author: agent:<agentId>`。
8. **prompt 引导**:`canAuthorSkills=true` 的 agent 系统提示词含「可写 skill」引导;`false` 的不含。
9. **toggle 持久化**:SkillsSection 勾选 `canAuthorSkills` → 保存 → 重开还原(往返)。
10. **无存量破坏**:typecheck 三层 + vitest 全套绿。

## E2E(扩 `tests/e2e/p8-wiki-and-agent-config.spec.ts` 或 `skills-agent-config.spec.ts`)

11. **toggle 往返**:SkillsSection 勾选「允许创建 skill」→ autosave → 关重开 → 仍勾选(同 sub-5 round-trip 模式)。
12. **(若 E2E 可驱动 agent 写)** 有权限 agent 经 Write 工具写 `[skills]/e2e-flow/SKILL.md` → SkillsPage 出现该 skill;无权限 agent 写 → 工具返回权限错误 + SkillsPage 不出现。
    - 注:E2E 驱动 agent 实际调用 Write 需 tool-call fixture 配合;若成本高,用例 12 改单测覆盖(写解析 + 门禁),E2E 只覆盖 toggle 往返(11)。

**前置(fixture)**:用 mock provider + tool-call fixture 触发 agent Write `[skills]/...`;或单测直接覆盖写解析 + 门禁逻辑。

## 验证手段

- 单测:写解析(新 / 已存在 / 外部 / 越界)+ 门禁(true / false)+ id 护栏 + `author` 标记。
- E2E:上述 11(必须),12(若可行)。
- typecheck 三层 + `npm run test`(含 e2e)。
