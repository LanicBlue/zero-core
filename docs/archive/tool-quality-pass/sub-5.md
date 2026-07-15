# sub-5 外部化路径:#9 虚拟前缀 [tool-outputs]/

> 对应 design:[`../design.md`](../design.md) #9。范围:`src/runtime/tool-result-externalizer.ts`、`src/tools/file-read.ts`、可选新 `src/tools/tool-output-paths.ts`。照搬 `[skills]/` 虚拟前缀模式([skill-paths.ts](../../../src/tools/skill-paths.ts) 是范本)。

## 现状

[relPathForPointer](../../../src/runtime/tool-result-externalizer.ts#L113) 输出 `.zero-core/tool-outputs/<hash>.txt`(相对 ZERO_CORE_DIR≈homedir)。agent 误读为 workspace 相对,找不到文件(实在 dataDir)。externalizer 注释选相对路径为"可移植",但 steps/session.db 机器绑定,可移植是伪需求。

## 做法

1. **新前缀常量** `TOOL_OUTPUTS_VIRTUAL_PREFIX = "[tool-outputs]/"`(镜像 `SKILL_VIRTUAL_PREFIX`).
2. **[relPathForPointer](../../../src/runtime/tool-result-externalizer.ts#L113)** 改输出 `[tool-outputs]/<hash>.txt`(不再 `.zero-core/...` 相对形态)。
3. **Read 工具解析**:[file-read.ts](../../../src/tools/file-read.ts#L117) 在现有 `[skills]/` 解析(skillResolved)旁,加 `[tool-outputs]/` 通道识别:前缀 → `join(ZERO_CORE_DIR, "tool-outputs", rest)`,沙箱限该目录(`../` 越界拒,照搬 [isInsideBaseDir](../../../src/tools/skill-paths.ts#L177))。
4. **[resolvePointerRelPath](../../../src/runtime/tool-result-externalizer.ts#L135)** 识别新前缀(返 `join(ZERO_CORE_DIR, "tool-outputs", rest)`);**向后兼容**旧 `.zero-core/tool-outputs/...` 相对形态(现有解析逻辑保留,旧 steps 行仍能还原)。
5. 解析 helper 可内联进 file-read + externalizer,或抽 `src/tools/tool-output-paths.ts`(镜像 skill-paths.ts:`tryParseToolOutputPath` / `resolveToolOutputPath` / 沙箱)。acceptance 不强制文件位置,只要 Read 能解析 + externalizer 能产出。

## 注意

- Read 已 import `resolveSkillPath`([file-read.ts:45](../../../src/tools/file-read.ts#L45)) 并解析 `[skills]/`;加 `[tool-outputs]/` 是同类扩展,放在同一处(skillResolved 判断之后)。
- 沙箱必须:`[tool-outputs]/../../etc/passwd` → 拒(不能逃出 tool-outputs 目录)。
- externalizer 注释里"相对可移植"那段更新为"虚拟前缀,agent 不误读;绝对真实路径不泄露"。
- ZERO_CORE_DIR 已在 externalizer import([L60](../../../src/runtime/tool-result-externalizer.ts#L60));file-read 需补 import ZERO_CORE_DIR。

## 不在范围

- 不改外部化阈值(16K)。
- 不改 Grep/Glob 支持 `[tool-outputs]/`(agent 用 Read 读单文件即可;若后续要 grep 再说)。
- 不迁移旧 steps 里的 `.zero-core/tool-outputs/...` 指针(向后兼容解析即可)。

## 验收见 [`./acceptance-5.md`](./acceptance-5.md)
