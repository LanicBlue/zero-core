# sub-1 Grep:#5 单文件 + #6 截断提示

> 对应 design:[`./design.md`](./design.md) #5 #6。范围:`src/tools/grep.ts`(仅此文件)。

## 背景

Grep 双路径:rg 可用走 rg;不可用(Windows)走 `nativeGrepSearch`。两个 bug 都在 native fallback,rg 路径正常。

## #5 单文件静默空

**现状**:[nativeGrepSearch](../../../src/tools/grep.ts#L103) 的 `walkFiles(searchPath)` 对**文件路径**调用 `readdir` → 抛错被 catch → 空生成器 → "No matches found."。rg 路径单文件正常(rg 原生支持),纯 fallback 缺陷。

**做法**:
- execute 里解析出 `searchPath` 后,`await stat(searchPath)` 判断文件 vs 目录。
- 是文件 → 走"单文件"分支:直接对该文件做匹配(复用 nativeGrepSearch 内"读文件 + 逐行 regex"逻辑),不 walkFiles。relPath = `basename(searchPath)`。
- 是目录 → 现状(walkFiles)。
- 抽出"匹配单文件内容"为可复用函数 `matchSingleFile(file, relPath, ...)`,让 nativeGrepSearch 的目录循环和单文件分支共用,避免逻辑重复。
- rg 路径不动(本就支持单文件)。
- 三种 output_mode(content/files_with_matches/count)单文件都要正确。

## #6 截断无提示

**现状**:[nativeGrepSearch L132](../../../src/tools/grep.ts#L132) `totalMatches >= head_limit` 时 `break`(停止收集),[L181](../../../src/tools/grep.ts#L181) `slice(0, head_limit)` 直接返回,无截断提示。rg 路径有提示([L359](../../../src/tools/grep.ts#L359))。

**做法**:
- native fallback 不在 `totalMatches >= head_limit` 处停止**计数**(继续扫文件/行,计真实 totalMatches,但不再 push 新结果行)。
- 末尾若 `totalMatches > 已输出数`,追加 `\n... (${totalMatches - shown} more matches truncated, refine your pattern)`。
- 对齐 rg 路径提示风格(files_with_matches/count 模式同理:files 模式截断时提示被截断的文件数;count 模式本身是聚合,可不提示或提示文件数截断——acceptance 定边界,content 模式必须)。
- FILE_SCAN_CAP(8000)仍保留(防巨型目录扫描),但与 head_limit 截断提示是两回事。

## 不在范围

- 不改 rg 路径行为。
- 不改 grep 的 schema 参数集。
- 不改 skill 虚拟路径通道。

## 验收见 [`./acceptance-1.md`](./acceptance-1.md)
