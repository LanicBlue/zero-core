# acceptance-1:scanner 读 body + 去重切 by name

对应 `sub-1.md`。

## 用例

1. **body 字段存在**:`DiscoveredSkill`(scanner + shared/types)有 `body: string`。
2. **body 读取正确**:给定一个含 frontmatter 的 SKILL.md,`scanSkills()` 返回项的 `body` = frontmatter 之后的正文(不含 `---` 块);无 frontmatter 时 body = 全文。
3. **去重 by name**:构造两个目录、同 name、不同 source(user / app),`scanSkills()` 只返回高优先级 source 那个(user 胜 app)。
4. **id 保留**:返回项仍有 `id`(目录名)+ `baseDir`/`filePath`(磁盘定位字段不变)。
5. **无行为回退**:系统提示词注入的 "Available Skills" 仍是 name+desc(sub-3 之前不指望 body 进 prompt)。
6. **存量无破坏**:既有 skill 扫描测试(若有)全过;typecheck 三层 + vitest baseline 全绿。

## 验证手段

- 单测:mock 临时 skill 目录(含/不含 frontmatter、同 name 跨 source),断言 body 与去重。
- typecheck 三层(tsconfig.cli/web/node)+ `npm run test` 全套。
- grep:`DiscoveredSkill` 无残留只读 name/desc 的旧用法。
