# sub-8:agent 运行时自建 skill(经 `[skills]/` 虚拟路径,不造新工具)

> agent 用**基本 Write/Edit 工具**经 `[skills]/<id>/SKILL.md` 虚拟路径创建/编辑 skill,per-agent `canAuthorSkills` 门禁。对应 design 决策 4(写)+ 11。**复用 sub-2 解析器,不造专用 skill 工具。**

## 任务

1. **Write/Edit `[skills]/` 前缀适配**:复用 sub-2 解析器(`skill-paths.ts`);识别 `[skills]/<id>/<rel>` 前缀 → 解析真实路径 → 写。
   - 写**已存在** skill:`<rel>` 沙箱(须在该 skill baseDir 内);若该 skill 来源非 app(`~/.claude`、`~/.agents`)→ **拒绝**(外部只读,对齐决策 8)。
   - 写**新** skill(id 不存在):基目录 = `~/.zero-core/skills/<id>`;校验 id **path-safe**(无 `../`、无空格/特殊字符)+ 不与已有冲突;创建目录 + 写文件。
2. **写门禁**:`[skills]/` 写操作查当前 agent `skillPolicy.canAuthorSkills`;`false` → 拒绝(返回权限错误,不落盘)。**读不受影响**(读始终放行,对齐决策 4)。
3. **SkillsSection toggle**(决策 11):加「允许此 agent 创建 skill」checkbox → `form.skillPolicy.canAuthorSkills`(默认 `false`)+ 持久化(`AgentRecord.skillPolicy`)。
4. **prompt 引导**(sub-4 扩展):`canAuthorSkills=true` 的 agent 系统提示词加一段「当某流程确有复用价值时,可写成 skill:用 Write 写 `[skills]/<id>/SKILL.md`(name+description frontmatter + body)」;`false` 的不含。
5. **溯源标记**:agent 自建 skill 写入时,SKILL.md frontmatter 打 `author: agent:<agentId>`(agent 未自填则框架补);scanner 可选暴露该字段,UI 展示「由 agent X 创建」。
6. **E2E**:按 `acceptance-8.md`。

## 范围

- **复用 sub-2 解析器,不造新工具**;不动 SkillsPage 手写 CRUD(sub-6)、git 安装(sub-7)。
- 仅落 `~/.zero-core/skills/`(agent 不可写外部来源);与用户手写 / git 装同根,UI 可同样编辑/删除。
- `canAuthorSkills` 只控「写 `[skills]/`」,不控读(读随 `enabledSkills`/sub-4)。

## 风险

- **写门禁位置**:在 `[skills]/` 写解析路径上查 flag,确保无权限 agent 写 `[skills]/` 一定被拒(不能绕过);读路径不查 flag。
- **新 skill id 安全**:path-safe(拒 `../`、空格、特殊字符)+ 重名拒绝(防覆盖)+ 仅落 app 根(防越界写外部)。
- **外部只读**:写已存在 skill 须判来源,`~/.claude`/`~/.agents` 的 skill 拒写。
- **与 sub-6 CRUD 共根**:agent 写的和用户手写混在 `~/.zero-core/skills/`;v1 UI 不强行区分,靠 `author` frontmatter 溯源。
- **prompt 过引导**:文案须克制(「当流程确有复用价值时」),防 agent 滥建低质 skill。
- **Edit 工具空白字符陷阱**:Write/Edit 实现注意 CRLF/tab(见 `feedback-edit-tool-whitespace`)。

## 验收

见 `acceptance-8.md`。
