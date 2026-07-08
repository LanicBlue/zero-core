# sub-1:scanner 协议对齐

> progressive disclosure 第 1 段(discovery)对齐协议。scanner 现有逻辑大方向对(元数据扫描、identity=目录名),但**优先级方向反了**,且缺给 sub-2 用的解析索引。对应 design 决策 1/2/3。

## 任务

1. **修 source 优先级方向 bug**(`skill-scanner.ts:45-52` + `scanSkills` `:167-180`):协议 personal > app/bundled。当前 `[.claude, .agents, .zero-core]` + 后覆盖前 → app 胜 personal(错)。改成 **app 先、personal 后**(personal 覆盖 app),或显式按 source 优先级合并。`~/.zero-core/skills`(app/bundled)最低,`~/.claude/skills`、`~/.agents/skills`(personal)高。
2. **暴露 `getSkillRoots()`**:导出 source 目录列表(带优先级),供 sub-2 虚拟路径解析 + sub-3 prompt 用。
3. **暴露 name→dir 解析索引**:导出 `resolveSkillByName(id)`(by 目录名)→ `{ baseDir, source, ... }`,供 sub-2 `[skills]/<id>/` 前缀解析用。或 `getSkillIndex()` 返 Map<id, DiscoveredSkill>。
4. **确认 display name 语义**(已对,加注释):id=目录名;display name=`parsed.name || 目录名`(`skill-scanner.ts:149`)。
5. **body 不读**(已对,加注释):scanner 只扫元数据,body 由 agent 经 `[skills]/` 按需 Read(别退回"读 body")。

## 范围

- 只动 scanner(scanner.ts + shared/types 的 DiscoveredSkill 若需)+ 导出辅助函数。
- **不改 prompt**(sub-3)、**不加虚拟通道**(sub-2)、**不动 UI**(sub-4/5)。
- body 保持不读——别把 G2 老方案(读 body)带回来。

## 风险

- 优先级翻转:确认现有测试无依赖"app 胜 personal"的断言;若有,按协议改。
- 解析索引:`scanSkills()` 每次读盘;索引只是其结果 Map 化,无新 IO。

## 验收

见 `acceptance-1.md`。
