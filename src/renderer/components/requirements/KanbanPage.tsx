// 看板页(legacy alias — v0.8 P5 §8.5 已替换为项目页)
//
// # 文件说明书
//
// ## 核心功能
// 旧 KanbanPage 的兼容入口。v0.8 P5 把看板页整体替换为项目页(项目列表 +
// 三 tab,看板成为其中一个 tab)。AppLayout 已直接 import ProjectPage,本
// 文件保留为 ProjectPage 的别名导出,以防历史外部引用。
//
// 新代码请直接 import ProjectPage 或 KanbanBoard。
//
// ## 维护规则
// - 本文件不再承载任何逻辑,所有看板逻辑迁移到 ./KanbanBoard.js
// - 项目页骨架在 ./ProjectPage.js
//
export { default } from "./ProjectPage.js";
