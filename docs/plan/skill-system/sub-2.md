# sub-2:`skill` 系统工具(多文件 + 自动激活)

> progressive disclosure 第 2/3 段(selection + resource):agent 按需查询 skill 正文与附带资源。新增一个**系统工具**(非普通可开关工具),经 tool-decoupling 纯函数层注册。对应 design 决策 5(进 tool 系统=方案 B)+ 决策 6(多文件)+ 决策 1(入参=name)。

## 任务

1. **新工具 `skill`**(`src/tools/skill-tool.ts`,进 `src/tools/index.ts` 的 `ALL_TOOLS`):
   - 入参 schema:
     - `name: string`(必填,frontmatter name)。
     - `file?: string`(可选,相对 skill baseDir 的文件路径;省略=取 SKILL.md 入口)。
     - `list?: boolean`(可选,true=枚举 skill 目录文件清单,返回 `{files: string[]}`)。
   - 逻辑:
     - `scanSkills()` 按 name 找(去重后唯一,sub-1 保证);找不到 → `{ok:false, error:"skill not found: <name>"}`。
     - `list:true` → 枚举 `baseDir` 下文件(相对路径),返回清单。
     - `file` 省略 → 返回 `{ok:true, data:{name, description, body, source}}`(SKILL.md 入口,body=frontmatter 后正文)。
     - `file` 给定 → **路径沙箱**:`resolve(baseDir, file)` 后必须仍在 `baseDir` 前缀内,否则 `{ok:false, error:"path outside skill dir"}`;读该文件返回 `{ok:true, data:{name, file, content}}`。
   - tool-decoupling 约定:`CallerCtx` + `ToolResult<T>` + `format`(format 拼可读文本块)。
   - **纯检索、无副作用**:不执行任何脚本;脚本由 agent 读源码后用 bash 跑。

2. **ToolDescriptor / category**:新增 category `system`(或确认复用),`source:"runtime"`,`meta:{isReadOnly:true, isDestructive:false, isConcurrencySafe:true}`。ToolsPage 归 "system" 分组,**不进 toolPolicy 手动开关**。

3. **自动激活**(`buildToolsSet` 或 AgentLoop 工具集构造处,`src/tools/index.ts` / `agent-loop.ts:1405`):当 `skillPolicy.enabledSkills` 非空时,**强制纳入** `skill` 工具到激活集(不受 toolPolicy.tools 开关影响);`enabledSkills` 为空/`[]` 时不纳入。杜绝"有 skill 没 loader"坏状态。

4. **UI dispatcher 暴露**(自动,经 `listDispatchableTools()`):ToolsPage 可见可试。

## 范围

- 只加查询/资源加载工具 + 自动激活规则;**不改 prompt 文案**(sub-3)、**不改 AgentEditor**(sub-4)、**不改 SkillsPage CRUD**(sub-5)。
- 单文件 skill = `file` 省略的默认 case;多文件 = `file`/`list` 参数。

## 风险

- **路径沙箱**:`resolve` 后比对 `baseDir` 前缀;拒 `../` 越界、绝拒软链逃逸(必要时 `realpath`)。关键护栏,单测必须覆盖。
- `scanSkills()` 每次读盘:工具调用频率低可接受;缓存 deferred。
- category 新增 `system` 需同步 `ToolCategory` 联合(`src/core/tool-registry.ts:25`)与 ToolsSection 分组 label(若 UI 硬编码分组)。

## 验收

见 `acceptance-2.md`。
