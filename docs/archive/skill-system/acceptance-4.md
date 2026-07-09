# acceptance-4:prompt 注入 + 默认全不开

对应 `sub-4.md`。

## 用例

1. **每条目带路径**:enabled skill 的每个条目含 `[skills]/<id>/SKILL.md`(agent 据此寻址);段尾有加载/资源/脚本三段式指引。
2. **新 agent 默认空**:新建 agent `skillPolicy.enabledSkills === []`。
3. **显式空→不注入**:`buildSystemPrompt` 传 `enabledSkills:[]` → "Available Skills" 段不出现。
4. **undefined→全注入(legacy)**:`enabledSkills:undefined` + 有 skills → 全部 name+desc 注入(存量行为不变)。
5. **body 不进 prompt**:无论 enabled,prompt 只有 name+desc,无 body。
6. **无存量破坏**:typecheck 三层 + vitest 全套绿。

## 验证手段

- 单测:buildSystemPrompt 三态(enabled 命中 / [] / undefined)+ 指引文案断言。
- typecheck 三层 + `npm run test`。
