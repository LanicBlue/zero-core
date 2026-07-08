# sub-3:系统提示词调用提示 + 默认全不开

> 把 sub-2 的工具"告诉"agent(prompt 文案加调用提示)+ 落实新 agent 默认不启用 skill。对应 design 决策 3 + 已定项。

## 任务

1. **"Available Skills" 段加调用提示**(`src/core/system-prompt.ts:64-74`):在 skill 列表后追加提示,覆盖三段式用法(中英文与现有 prompt 风格一致):
   - 入口:需要某 skill 的详细步骤时,调 `skill({name})` 加载 SKILL.md 正文。
   - 资源:skill 可能含兄弟文件/脚本,用 `skill({name, file})` 读特定文件、`skill({name, list:true})` 看清单。
   - 脚本:读到脚本源码后,用 bash 执行(skill 工具本身不执行)。
2. **默认全不开语义**:
   - 新建 agent 时 `skillPolicy.enabledSkills = []`(显式空数组)——在 agent 创建/seed 路径核对(`fresh-db-seed.ts`、`builtin-role-templates.ts` 等)。
   - **`system-prompt.ts:66-69` 的 undefined 分支不动**(legacy agent `enabledSkills===undefined` 仍= 注入全部,保存量兼容);只有显式 `[]` 才过滤为空。在代码注释里写清这个二元语义。
3. **prompt 注入仍只 name+desc**:不把 body 灌进 prompt(body 经 sub-2 工具按需取)。

## 范围

- 只改 prompt 文案 + seed 默认值 + 注释;**不动 UI**(sub-4/5)、**不动工具**(sub-2 已加)。
- 新 agent 默认无 skill 注入;用户后续在 SkillsSection 手动勾。

## 风险

- undefined vs `[]` 的二元语义易混淆 → 注释 + 单测覆盖两条路径。
- 现有内置 agent(Coder 等)若依赖某 skill 默认启用,需核对(预期无,内置 agent 现状未用 skill)。

## 验收

见 `acceptance-3.md`。
