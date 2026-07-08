# sub-1:scanner 读 body + 去重切 by name

> progressive disclosure 第 1 段(元数据)的地基:scanner 现在只取 frontmatter 的 name/description,从不读 body,且按目录名去重。本 sub 让 body 可被读取、去重切到 by name(工具入参 = name 的前提)。对应 design 已定决策 1。

## 任务

1. **`DiscoveredSkill` 加 body 字段**(`src/server/skill-scanner.ts:31-38` + `src/shared/types.ts:619-626`):增 `body: string`(SKILL.md 去掉 frontmatter 后的正文)。
2. **scanDir 读 body**(`skill-scanner.ts:144-150`):解析 frontmatter 后,把剩余正文存入 `body`(复用 `parseSkillFrontmatter` 的归一化逻辑,切出 `---` 之后的部分)。
3. **去重切 by name**(`scanSkills` `skill-scanner.ts:167-180`):`merged` 的 key 从 `skill.id`(目录名)改成 `skill.name`——同名时高优先级 source 覆盖低优先级(source 顺序:user > app,见 `getSkillSources`)。`id`(目录名)保留作磁盘定位字段。
4. **`SkillsPage` / `skill-router` 适配**:若 UI 或 router 依赖按 id 去重展示,核对仍正确(展示用 name,定位用 baseDir/filePath)。

## 范围

- 只动 scanner + 类型;**不引入工具、不改 prompt、不改 UI 布局**。
- body 读到了但还没人用(sub-2 工具才会查它)。
- 既有行为(系统提示词注入 name+desc)不变。

## 风险

- 去重 key 从 id 切 name:若两个不同目录的 skill 同 name,只剩高优先级那个(符合预期,但要确认存量无意外丢失)。
- body 切分边界:frontmatter 结束标记 `\n---` 之后的内容;无 frontmatter 的 SKILL.md(body=全文)。

## 验收

见 `acceptance-1.md`。
