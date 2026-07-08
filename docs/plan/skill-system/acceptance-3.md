# acceptance-3:prompt 调用提示 + 默认全不开

对应 `sub-3.md`。

## 用例

1. **调用提示存在**:`buildSystemPrompt` 在有 enabled skill 时,"Available Skills" 段含调用 `skill` 工具的提示文案。
2. **新 agent 默认空**:新建 agent 的 `skillPolicy.enabledSkills === []`(显式空数组,非 undefined)。
3. **显式空→不注入**:`buildSystemPrompt` 传 `enabledSkills:[]` → "Available Skills" 段不出现(或为空)。
4. **undefined→全注入(legacy 兼容)**:`enabledSkills:undefined` 且有 skills → 全部 name+desc 注入(存量行为不变)。
5. **body 不进 prompt**:无论 enabled 与否,prompt 里只有 name+desc,无 body 字样。
6. **无存量破坏**:typecheck 三层 + vitest 全套绿。

## 验证手段

- 单测:buildSystemPrompt 三态(enabled 命中 / [] / undefined)+ 调用提示存在性断言。
- grep 新建 agent 路径默认值。
- typecheck 三层 + `npm run test`。
