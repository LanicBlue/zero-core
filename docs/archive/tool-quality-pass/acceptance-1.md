# acceptance-1 Grep(#5 + #6)

> 独立验收清单(verifier 据此写测试,不依赖 implementer 的说法)。对应 [`./sub-1.md`](./sub-1.md)。

## #5 单文件

1. **单文件 content 模式返匹配**:`Grep { pattern, path: <一个文件路径>, output_mode: "content" }`,native fallback(无 rg)路径下返回该文件内匹配行,非空、非 "No matches found."。
2. **单文件 files_with_matches / count 模式**:单文件下两模式也正确(files_with_matches 返该文件 basename;count 返该文件的匹配数)。
3. **rg 路径单文件不回归**:rg 可用环境(或 mock rg 成功)下,单文件搜索仍正常(返匹配)。
4. **relPath 是 basename**:单文件 content 输出的路径段是文件 basename,不是空串或完整绝对路径。
5. **目录搜索不回归**:`path` 指目录时,行为与改前完全一致(walkFiles 递归)。
6. **无匹配仍返 "No matches found."**:单文件 + 目录都如此,不回归。

## #6 截断提示

7. **native fallback content 截断有提示**:构造 > head_limit 个匹配,native fallback 输出末尾含 `... (N more matches truncated, refine your pattern)`(N = 真实超出数)。
8. **真实总数正确**:提示里的 N 是真实总匹配数 - 已显示数(不是 0 或乱数)。即 native fallback 继续扫完了真实总数,没在 head_limit 提前停计。
9. **未截断无提示**:匹配数 ≤ head_limit 时,末尾**无**截断提示(不误报)。
10. **rg 路径截断提示不回归**:rg 路径仍保留原有 `... (truncated, N total matches)` 提示。

## 通用

11. **typecheck 绿**:`npm run typecheck` 通过。
12. **既有 grep 测试不回归**:`tests/unit/` 下既有 grep 相关测试仍绿。
