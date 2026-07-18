// Project Manifest status —— 纯 TS 辅助模块(round-2 review-fix P1 §5)
//
// # 文件说明书
//
// ## 核心功能
// 把 project root wiki 节点的「manifest 状态」(pending / partial / ready)
// 钉成单个真相源:6 个结构化字段键 + 状态判定函数 + 状态/时间戳 attribute key
// 常量。compiler / indexer / wiki-admin-router / UI 全部走本模块,杜绝分散重写。
//
// ## 背景(round-2 review-fix P1 §5)
// wiki-context-compiler 早已在 Project root 上渲染 6 个结构化字段
// (goals/stack/entrypoints/modules/risks/constraints),但**生产路径**没人写它们:
// git indexer 只造启发式 summary;wiki-enrich prompt 也只指示改普通 summary/content。
// 结果真实项目都显示六个 `(none recorded)`,但 semanticSyncStatus=fresh ——
// 虚假暗示项目语义已完整。本模块 + 调用方(indexer / wiki-enrich / compiler /
// admin router / UI)共同构成 manifest 状态生命周期,把这件事变成可见、可追踪。
//
// ## 关键不变量
//   - **纯 TS**:不 import DB / service / express —— 单元测试 + compiler +
//     indexer + admin router + UI types 都能直接 import。
//   - **类型真相源在 shared**:本模块 re-export `ProjectManifestStatus`,使 server
//     端有统一命名空间;`src/shared/wiki-admin-types.ts` 持有类型定义本身,避免
//     `shared → server` 反向依赖。
//   - **absent → "pending"**:老项目 / 未 enriched 项目走 manifestStatusFromAttrs
//     一律读到 "pending",渲染 + UI 不会乱显示。
//   - **6 个字段键固定**:与 wiki-context-compiler.renderProjectStructuredFields
//     已渲染的键完全一致 —— 不增不减。
//   - **manifest_status 与 source_stale 正交**:source_stale 是「单个节点 source
//     变了,summary 可能过时」;manifest_status 是「整个 project root 的结构化
//     manifest 是否已 enrich」。二者独立,不互相清位。
//
// ## manifest 状态生命周期(review-fix P1 §5.2)
//   - pending —— git fullIndex 成功(indexer 把刚结构索引完的项目标记为 pending,
//     绝不声称语义完整)。
//   - partial —— wiki-enrich 中途 / 不完整 / MODIFY 把 ready 项目踩回 partial。
//   - ready —— wiki-enrich 完成 6 字段填充 + 子树 enrichment 后显式标记。
//
// 参见:
//   - src/server/wiki/wiki-project-indexer.ts (fullIndex → pending, MODIFY → partial)
//   - src/server/wiki-operations.ts (wiki-enrich prompt 写 manifest)
//   - src/server/wiki/wiki-context-compiler.ts (渲染 manifest 状态行)
//   - src/shared/wiki-admin-types.ts (ProjectManifestStatus 类型真相源)

import type { WikiNodeAttributes } from "../../shared/wiki-types.js";
import type { ProjectManifestStatus } from "../../shared/wiki-admin-types.js";

/** Re-export,使 server 端有统一命名空间(类型真相源在 shared,避免 shared→server 反向依赖)。 */
export type { ProjectManifestStatus };

/**
 * manifest_status 的合法值闭集。用于 indexer / wiki-enrich 写入前的校验。
 */
export const MANIFEST_STATUS_VALUES: readonly ProjectManifestStatus[] = [
	"pending",
	"partial",
	"ready",
];

/**
 * project root attributes_json 中存 manifest_status 用的 key。
 * 与 wiki-project-indexer / wiki-enrich 写入路径保持一致;禁止散落字符串字面量。
 */
export const MANIFEST_STATUS_ATTR_KEY = "manifest_status";

/**
 * project root attributes_json 中存 manifest_updated_at(ISO-8601)用的 key。
 * 用于 UI 展示「最近一次 enrich 时间」+ 排查 enrichment 时序。
 */
export const MANIFEST_UPDATED_AT_ATTR_KEY = "manifest_updated_at";

/**
 * Project root 的 6 个结构化字段键,与 wiki-context-compiler.renderProjectStructuredFields
 * 渲染顺序一致。**绝不改这 6 个键**(compiler 已经在渲染);本常量仅用于:
 *   - wiki-enrich prompt 显式列出
 *   - 校验 / 文档 / 审计场景
 */
export const PROJECT_MANIFEST_FIELD_KEYS = [
	"goals",
	"stack",
	"entrypoints",
	"modules",
	"risks",
	"constraints",
] as const;

/**
 * 类型守卫:v 是否为合法的 ProjectManifestStatus 字面量。
 * indexer / wiki-enrich 从外部(attributes_json)读出来时,值可能是任意 JSON ——
 * 本守卫确保只接受合法闭集。
 */
export function isManifestStatus(v: unknown): v is ProjectManifestStatus {
	return v === "pending" || v === "partial" || v === "ready";
}

/**
 * 从 project root 的 attributes 解析 manifest_status。规则:
 *   - attrs 为 null/undefined 或缺 manifest_status 或值非合法闭集 → "pending"
 *     (老项目 / 未 enriched 项目一律显示 pending,绝不乱显示 ready)。
 *   - 值为合法闭集 → 直接返回。
 *
 * **absent → pending 语义**是关键:review-fix P1 §5.4 要求老项目 / 还没被
 * fullIndex 标记过的项目渲染成 pending(显式告诉用户「manifest 还没 enrich」),
 * 而不是某条默认静默路径。
 */
export function manifestStatusFromAttrs(
	attrs: WikiNodeAttributes | null | undefined,
): ProjectManifestStatus {
	if (!attrs) return "pending";
	const raw = (attrs as Record<string, unknown>)[MANIFEST_STATUS_ATTR_KEY];
	return isManifestStatus(raw) ? raw : "pending";
}
