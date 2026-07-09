# acceptance-1:scanner 协议对齐

对应 `sub-1.md`。

## 用例

1. **优先级方向正确**:同 id(目录名)skill 在 personal(`~/.claude/skills/foo`)与 app(`~/.zero-core/skills/foo`)都存在 → `scanSkills()` 返回 **personal 那个**(`source:"user"`),app 被覆盖。
2. **getSkillRoots 可用**:导出 source 目录列表(含优先级顺序),sub-2/3 可调。
3. **name→dir 解析索引**:`resolveSkillByName("foo")`(或 `getSkillIndex().get("foo")`)返 `{baseDir, source, ...}`;不存在 → undefined。
4. **identity=目录名**:`DiscoveredSkill.id` = 目录名;同目录前两个 skill 同 frontmatter name 但不同目录名 → 视为两个不同 skill(id 不同)。
5. **display name 兜底**:frontmatter 无 name → display name = 目录名。
6. **body 不读**:`DiscoveredSkill` 无 body 字段;scanner 不返回正文。
7. **无存量破坏**:typecheck 三层 + vitest 全套绿(优先级翻转后,相关测试按协议更新)。

## 验证手段

- 单测:mock 临时 skill 目录(同 id 跨 source、缺 name、多 skill 同 name 不同 id)。
- typecheck 三层 + `npm run test`。
