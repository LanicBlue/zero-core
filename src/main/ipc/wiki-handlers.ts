// Project Wiki（项目知识库节点）IPC 处理器。
//
// # 文件说明书
//
// ## 核心功能
// 注册 `wiki:*` 系列 IPC 通道，提供按项目组织的 Wiki 节点 CRUD：
//   - wiki:listByProject 列出某项目下全部节点；
//   - wiki:getNode / wiki:createNode（强制绑定 projectId）/
//     wiki:updateNode（失败时返回 `{error}`）/ wiki:deleteNode。
//
// ## 输入
// - IpcContext：wikiStore
// - 通道参数：projectId、节点 id、节点 input
//
// ## 输出
// - WikiNode 列表 / 单节点 / 写操作结果
// - updateNode 失败统一返回 `{error: message}`
//
// ## 定位
// src/main/ipc 下领域 IPC 处理器；由 ipc 注册入口调用
// registerWikiHandlers(ctx)。是 M4 看板/知识库浏览页面的后端入口。
//
// ## 依赖
// - ./typed-ipc.js、./types.js
// - 间接：ctx.wikiStore（sessionDb 模块）
//
// ## 维护规则
// - 创建节点必须确保 projectId 绑定，避免悬挂节点
// - WikiNode 类型/字段变更需同步 shared 类型与 wikiStore 列定义
// - 写路径上的异常需收敛为 `{error}` 返回，避免渲染层崩溃
//
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import { resolve, relative, isAbsolute } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export function registerWikiHandlers(_ctx: IpcContext): void {
	// List by project
	typedHandle("wiki:listByProject", "sessionDb", (ctx, projectId) => {
		return ctx.wikiStore.listByProject(projectId);
	});

	// Get node
	typedHandle("wiki:getNode", "sessionDb", (ctx, id) => {
		return ctx.wikiStore.get(id);
	});

	// Create node
	typedHandle("wiki:createNode", "sessionDb", (ctx, projectId, input) => {
		return ctx.wikiStore.create({ ...input, projectId });
	});

	// Update node
	typedHandle("wiki:updateNode", "sessionDb", (ctx, id, input) => {
		try {
			return ctx.wikiStore.update(id, input);
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	// Delete node
	typedHandle("wiki:deleteNode", "sessionDb", (ctx, id) => {
		ctx.wikiStore.delete(id);
		return { success: true as const };
	});

	// ── v0.8 (P8 §10.9): global-tree browser surface ──
	//
	// The renderer drives the whole tree from a SET of anchor nodeIds — the
	// session's anchor union. listByAnchors returns the union of each anchor's
	// subtree (or the whole tree if WIKI_GLOBAL_ROOT_ID is in the set). This is
	// the multi-anchor visibility the spec calls for: zero sees everything,
	// project roles see only their project subtree ∪ memory.
	typedHandle("wiki:listByAnchors", "sessionDb", (ctx, anchorIds) => {
		const wiki = ctx.wikiStore.getWikiStore();
		return wiki.listVisibleFromAnchors(anchorIds ?? []);
	});

	// Read a node's on-disk body content (the "expand" path). detail is NOT on
	// the row (lives on disk); this loads it lazily for the detail panel.
	typedHandle("wiki:readDetail", "sessionDb", (ctx, nodeId) => {
		const wiki = ctx.wikiStore.getWikiStore();
		const detail = wiki.readNodeDetail(nodeId);
		return { nodeId, detail };
	});

	// Jump-to-original for docPointer: read a project source/requirement file
	// by workspace-relative path. workspaceDir comes from the project record
	// (normalized, immutable). Path is sandboxed to stay inside the workspace.
	typedHandle("wiki:readWorkspaceDoc", "sessionDb", (ctx, projectId, relPath) => {
		const project = ctx.projectStore.get(projectId);
		if (!project) return { error: `project not found: ${projectId}` };
		const workspaceDir = project.workspaceDir;
		if (!workspaceDir) return { error: `project has no workspaceDir` };
		const abs = resolve(workspaceDir, relPath);
		const relCheck = relative(workspaceDir, abs);
		if (isAbsolute(relCheck) || relCheck.startsWith("..")) {
			return { error: `path outside workspace: ${relPath}` };
		}
		if (!existsSync(abs)) return { error: `file not found: ${relPath}` };
		try {
			const content = readFileSync(abs, "utf-8");
			const max = 50000;
			if (content.length <= max) return { content };
			return { content: content.slice(0, max) + `\n\n[truncated: ${content.length} → ${max} chars]` };
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	// Substring search scoped to caller's anchors (empty anchors → whole tree).
	// P3 simple match; P5 will land full-text. Mirrors the Wiki(search) tool.
	typedHandle("wiki:search", "sessionDb", (ctx, query, anchorIds) => {
		const wiki = ctx.wikiStore.getWikiStore();
		const q = (query ?? "").toLowerCase();
		if (!q) return [];
		const pool = (anchorIds && anchorIds.length > 0)
			? wiki.listVisibleFromAnchors(anchorIds)
			: wiki.list();
		const limit = 200;
		const hits = pool.filter(
			(n) =>
				(n.title?.toLowerCase().includes(q) ?? false) ||
				(n.summary?.toLowerCase().includes(q) ?? false) ||
				(n.path?.toLowerCase().includes(q) ?? false),
		);
		return hits.slice(0, limit);
	});
}
