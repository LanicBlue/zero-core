# acceptance-2:`skill` 系统工具(多文件 + 自动激活)

对应 `sub-2.md`。

## 用例

1. **工具注册**:`skill` 在 `ALL_TOOLS`;`getToolExecute("skill")` 返函数;ToolDescriptor category=`system`、isReadOnly=true。
2. **入口查询**:`skill({name:"foo"})` → `{ok:true, data:{name:"foo", body, ...}}`(SKILL.md 入口)。
3. **多文件查询**:mock skill 目录含 `SKILL.md` + `checklist.md`,`skill({name:"foo", file:"checklist.md"})` → `{ok:true, data:{file:"checklist.md", content:"..."}}`。
4. **list 枚举**:`skill({name:"foo", list:true})` → `{ok:true, data:{files:["SKILL.md","checklist.md","scripts/..."]}}`。
5. **路径沙箱**:`skill({name:"foo", file:"../../etc/passwd"})` → `{ok:false, error:"path outside skill dir"}`(或等价拒绝);`../` 越界、软链逃逸都被拒。
6. **查询失败**:`skill({name:"不存在"})` → `{ok:false, error:"skill not found: 不存在"}`。
7. **自动激活**:agent `enabledSkills` 非空 → 激活工具集含 `skill`(即便 toolPolicy 没勾);`enabledSkills=[]`/undefined → 不含。
8. **不经 toolPolicy 开关**:ToolsSection 无 `skill` 勾选项(非手动可开关);ToolsPage 在 "system" 分组可见。
9. **纯检索无副作用**:工具不执行脚本;返回脚本源码后由 agent 用 bash 跑。
10. **format 可用 + dispatcher 可达**:`getToolFormat("skill")(result)` 返可读文本;`dispatchTool("skill", {...}, {caller:"ui"})` 返 JSON。
11. **无存量破坏**:typecheck 三层 + vitest 全套绿。

## 验证手段

- 单测:mock skill 目录(单文件/多文件/越界路径)+ execute + dispatcher 两路;自动激活断言(构造 enabledSkills 非空/空两态比对激活集)。
- typecheck 三层 + `npm run test`。
