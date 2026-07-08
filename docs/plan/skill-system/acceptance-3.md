# acceptance-3:prompt 注入 + 默认全不开

对应 `sub-3.md`。

## 用例

1. **寻址指引存在**:enabled skill 时,"Available Skills" 段含 `[skills]/<id>/SKILL.md` 加载指引 + 资源/脚本用法。
2. **新 agent 默认空**:新建 agent `skillPolicy.enabledSkills === []`。
3. **显式空→不注入**:`buildSystemPrompt` 传 `enabledSkills:[]` → "Available Skills" 段不出现。
4. **undefined→全注入(legacy)**:`enabledSkills:undefined` + 有 skills → 全部 name+desc 注入(存量行为不变)。
5. **body 不进 prompt**:无论 enabled,prompt 只有 name+desc,无 body。
6. **无存量破坏**:typecheck 三层 + vitest 全套绿。

## 验证手段

- 单测:buildSystemPrompt 三态(enabled 命中 / [] / undefined)+ 指引文案断言。
- typecheck 三层 + `npm run test`。
