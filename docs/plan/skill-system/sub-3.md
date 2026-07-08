# sub-3:prompt 注入 + 默认全不开

> 告知 agent skill 存在 + `[skills]/` 寻址用法 + 默认全不开。对应 design 决策 5。

## 任务

1. **"Available Skills" 段增强**(`src/core/system-prompt.ts:64-74`):enabled skill 列表保持 `- **<display>**: <desc>`,并在段尾加**寻址与加载指引**(三段式用法):
   - 加载:需要某 skill 详细步骤时,`Read [skills]/<id>/SKILL.md`。
   - 资源:skill 可含兄弟文件,按需 `Read [skills]/<id>/<file>`(skill 正文里的 `${SKILL_DIR}` 已替换为 `[skills]/<id>`)。
   - 脚本:skill 可含脚本,`Shell` 运行 `[skills]/<id>/scripts/...`。
2. **默认全不开**:
   - 新建 agent `skillPolicy.enabledSkills = []`(显式空数组)——核对 agent 创建/seed 路径(`fresh-db-seed.ts`、`builtin-role-templates.ts` 等)。
   - **`system-prompt.ts:66-69` 的 undefined 分支不动**(legacy `enabledSkills===undefined`=注入全部,保兼容);显式 `[]` 走 filter→空。注释写清二元语义。
3. **prompt 注入仍只 name+desc**:不灌 body(body 经 sub-2 按需 Read)。

## 范围

- 只改 prompt 文案 + seed 默认值 + 注释。
- **不动工具/虚拟通道**(sub-2)、**不动 UI**(sub-4/5)。

## 风险

- undefined vs `[]` 二元语义易混 → 注释 + 单测覆盖两路径。
- 现有内置 agent(Coder 等)未用 skill,核对无依赖。

## 验收

见 `acceptance-3.md`。
