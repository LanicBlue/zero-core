# runtime/tools/outline/

多语言代码大纲提取模块：把源码解析为符号树（类 / 函数 / 方法 / 标题等），供 FileRead 等工具展示文件结构。

## 核心功能

- `index.ts`：入口，按文件扩展名选择对应 `LangExtractor`，返回 `OutlineResult`。
- `types.ts`：核心数据结构 `OutlineNode`（kind/name/line/endLine/detail/close/children）、`OutlineResult`、`LangExtractor` 接口。
- `stripper.ts`：剥离注释 / 字符串，避免提取器误命中注释里的伪符号。
- `renderer.ts`：把大纲树渲染为可读文本（带折叠提示）。
- `extractors/`：各语言的具体提取器（TS/Python/JSON/Markdown/C-Family/Java/Go/Rust/HTML/CSS/Ruby/PHP/Swift/Kotlin/Scala/Dart/Lua/Shell/SQL/Protobuf/GraphQL/Elixir/R/Zig/Nim/YAML/TOML/INI/Vue/Svelte）。

## 输入

- 源代码文本。
- 文件扩展名 / 语言标识（用于路由到 extractor）。

## 输出

- `OutlineResult`：`{ file, language, totalLines, nodes }`，nodes 为嵌套 `OutlineNode` 树。
- 经 `renderer` 转换后的可读大纲文本。

## 定位

`src/runtime/tools/outline/` 是 FileRead / 代码理解工具的子模块，处于 `runtime/tools` 与具体语言解析之间；不依赖 LLM，纯本地解析。

## 依赖

- 内部：`types.ts`、`stripper.ts`、`extractors/*`。
- 无第三方解析器依赖，主要基于正则与轻量状态机。
- 被上层 `runtime/tools/file-read.ts` 等调用。

## 维护规则

- 新增语言支持：在 `extractors/` 实现 `LangExtractor`，并在 `index.ts` 注册到路由表。
- `OutlineNode` 结构变更需确保全部 extractor 兼容，并同步 `renderer` 的渲染逻辑。
- 修改 `stripper` 后需回归各语言，避免误删真符号或残留注释干扰提取。
- 提取器正则脆弱，遇到新语法（如 TS `satisfies`、新装饰器）需及时补案例。
