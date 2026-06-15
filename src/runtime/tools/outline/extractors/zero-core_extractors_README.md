# runtime/tools/outline/extractors/

各编程语言的代码大纲提取器实现：每个文件实现 `LangExtractor` 接口，从源码中抽取符号树。

## 核心功能

每个 extractor 负责一种或一族语言：

- `typescript.ts`：TS/JS 的 import、class、interface、function、type 等。
- `python.ts`、`ruby.ts`、`php.ts`、`swift.ts`、`kotlin.ts`、`scala.ts`、`dart.ts`、`lua.ts`、`elixir.ts`、`r-lang.ts`、`zig.ts`、`nim.ts`、`go.ts`、`rust.ts`、`java.ts`：对应语言的类 / 函数 / 方法 / 模块结构。
- `c-family.ts`：C/C++/ObjC/C++ 共用的函数 / 类 / 结构提取。
- `shell.ts`、`sql.ts`、`protobuf.ts`、`graphql.ts`：脚本 / 查询 / IDL 语言的顶层定义。
- `json.ts`、`yaml.ts`、`toml.ts`、`ini.ts`：配置文件的键结构。
- `markdown.ts`：标题层级。
- `html.ts`、`vue.ts`、`svelte.ts`、`css.ts`：标记 / 样式语言的标签与选择器。

所有 extractor 共享 `OutlineNode` 输出结构与 `stripComments` 预处理。

## 输入

- 单一参数：源代码文本（已由上层根据扩展名路由到本 extractor）。

## 输出

- `OutlineNode[]`：符号节点列表，含 kind、name、line、endLine、detail、close、children。

## 定位

`src/runtime/tools/outline/extractors/` 是大纲模块的最底层语言适配层；被 `outline/index.ts` 按扩展名调度。无 LLM、无第三方解析器，主要基于正则与轻量状态机。

## 依赖

- `../types.ts`：`OutlineNode`、`LangExtractor` 接口。
- `../stripper.ts`：注释 / 字符串剥离（按需调用，如 c 系、shell 等）。

## 维护规则

- 新增 extractor 必须实现 `LangExtractor`，并在 `../index.ts` 注册路由（扩展名 → extractor）。
- 节点 `kind` 取值需与 renderer 的展示策略保持一致；新增 kind 时同步 renderer。
- 提取器对语法变化敏感（新关键字、装饰器、模板字符串），遇到误判优先补 `stripper` 或正则案例，不要轻易改公共类型。
- 修改公共 `OutlineNode` 字段时必须回归全部 extractor，避免编译错误或字段缺失。
