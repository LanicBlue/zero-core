# acceptance-3 Wiki(#2 + #3 + #4)

> 独立验收清单。对应 [`./sub-3.md`](./sub-3.md)。

## #2 regex

1. **regex:true 按正则**:`search { query: "foo.*bar", regex: true }` 匹配 title/summary 含 "foo...bar" 的节点(跨字符)。
2. **默认子串不回归**:`search { query: "a.b" }`(无 regex)→ 字面匹配 "a.b"(`.` 不是任意),与改前一致。
3. **type 过滤仍生效**:`search { query: "x", type: "header" }` 只返 header 节点(regex 与 type 可叠加)。
4. **非法 regex 友好错误**:`search { query: "(unclosed", regex: true }` → 返 `Invalid regex: ...`(不抛崩)。
5. **大小写不敏感**:regex 与子串都大小写不敏感(对齐现有 toLowerCase)。

## #3 计数

6. **非叶节点显 ▾direct(total)**:expand 一个有子的节点,渲染的每个非叶子子节点行含 `▾<直接子数>(<总子孙数>)`。
7. **叶节点显 leaf**:无子的节点显 `leaf`(无括号)。
8. **总数正确**:某节点 direct=2、两个子各 3 个孙 → 该节点 total=2+3+3=8,显 `▾2(8)`。
9. **不回归 expand 基本输出**:nodeId/Title/Type/Summary/Body/Source file 行仍在。

## #4 path 跳层

10. **path 直达**:有树 A/B/C,`expand { path: "A/B/C" }` 直接定位到 C 并 expand 它(返回 C 的 metadata + 子树),不需先 expand A、再 B、再 C。
11. **末段 * 展子层**:`expand { path: "A/B/*" }` → 定位到 B,展 B 的直接子节点(depth=1)。
12. **path 优先于 nodeId**:`expand { path: "A/B", nodeId: "xxxx", depth: 2 }` → 用 path(定位到 B),depth=2 生效,nodeId 被忽略。
13. **path 定位失败清晰错误**:`expand { path: "A/不存在" }` → 错误指明哪段没匹配(不是静默空)。
14. **纯 nodeId 不回归**:`expand { nodeId: "xxxx" }`(无 path)与改前完全一致。

## 通用

15. **typecheck 绿**。
16. **既有 wiki 测试不回归**。
