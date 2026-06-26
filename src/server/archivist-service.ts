// Archivist 服务 (v0.8 M2)
//
// # 文件说明书
//
// ## 核心功能
// archivist 是全局角色(M0 已有预设),经 session 上下文服务某个 project。本
// 服务实现 RFC §2.7/§2.13/§2.16/§2.17a/§2.19 在 wiki 侧的落地:
//
//   1. **建/改 project 子树结构**(header→代码文件、intent→需求文档、
//      structure→模块/子系统)+ docPointer + 关系;不写代码、不写需求文档内容
//      (决策 9/18)。wiki 在数据库,不经 git(决策 27 N1)。
//   2. **git 增量更新**:`lastScannedRef` 按 (archivist, project) 维度记录
//      (游标不能挂 agent 上,§4.2);合并后跑 `git log/diff <last>..main`,只
//      重读变化部分(决策 19/26)。
//   3. **意图从 artifact 聚合,不发明**:结构层读代码;意图层读 commit msg /
//      需求文档 / ADR / 注释;缺失时 flag「无记录理由」(决策 20)。
//   4. **provenance 打标**:每条结构断言标 structure/derived/confirmed
//      (决策 33)。
//   5. **意图↔结构分歧信号**:需求未实现 flag / 代码有能力需求没覆盖 flag
//      (决策 31)。
//   6. **archivist 管 main 分支 git**:统一 commit PM 写的需求文档、verify 后
//      合并 feature→main、非 repo 自动 init、清理 worktree(§2.15)。
//
// 写入守卫:WikiStore.upsertProjectNode 在 store 层强制 scope = 自己 project
// 子树 + 类型只能是 header/intent/structure。本服务是 WikiStore 的唯一调用方。
// 项目文档(代码/需求文档)archivist 只读(用 fileReadTool),不在本服务里
// 写(决策 39)。
//
// ## 输入
// - WikiStore(全局树)
// - WikiScanCursorStore(游标)
// - ArchivistGit(main 分支 git 操作)
// - ProjectStore
// - RequirementStore
// - archivistId(全局 archivist agent 的 id)
//
// ## 输出
// - scanProject(projectId):扫描 + 增量更新 wiki
// - rescanProjectFull(projectId):周期全量 rescan 兜底漂移
// - commitRequirementDoc / mergeFeatureToMain / cleanupWorktree:git 管理
// - detectDivergence(projectId):意图↔结构分歧信号
//
// ## 定位
// 服务层,被 cron / requirement-hooks / 项目通知分发调用。
//
// ## 依赖
// - ./wiki-node-store, ./wiki-scan-cursor-store, ./archivist-git
// - ./project-store, ./requirement-store
// - ../core/logger
//
// ## 维护规则
// - archivist 只在自己服务的 project 子树下写结构节点(决策 39)
// - feature WIP 不进 wiki(决策 26)—— 只跟踪 main
// - 意图缺失时 flag「无记录理由」,不发明
//

import { resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { WikiStore } from "./wiki-node-store.js";
import { projectSubtreeRootId } from "./wiki-node-store.js";
import type { WikiScanCursorStore } from "./wiki-scan-cursor-store.js";
import { ArchivistGit } from "./archivist-git.js";
import type { ProjectStore } from "./project-store.js";
import type { RequirementStore } from "./requirement-store.js";
import type { WikiNode } from "../shared/types.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Scan configuration
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"out",
	"build",
	".next",
	".cache",
	".worktrees",
	"target",
	"vendor",
	".venv",
	"__pycache__",
	".idea",
	".vscode",
]);

const IGNORED_FILE_SUFFIXES = [".lock", ".min.js", ".min.css", ".map"];

const CODE_SUFFIXES = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
	".py", ".go", ".rs", ".java", ".kt", ".swift",
	".c", ".cc", ".cpp", ".h", ".hpp",
	".rb", ".php", ".scala", ".clj", ".ex", ".exs",
	".vue", ".svelte", ".astro",
]);

const DOC_SUFFIXES = new Set([
	".md", ".mdx", ".rst", ".txt", ".adoc",
]);

const INTENT_DOC_HINTS = [
	// Conventional requirement-doc path fragments (PM writes these).
	"docs/requirements/",
	"docs/req/",
	"docs/rfc/",
	"requirements/",
	"adr/", "docs/adr/", "docs/adrs/",
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScanResult {
	projectId: string;
	scannedRef: string;
	isInitial: boolean;
	filesScanned: number;
	nodesUpserted: number;
	flagsRaised: number;
	notes: string[];
}

export interface DivergenceReport {
	projectId: string;
	/** Requirements whose intent exists in wiki but no code structure realizes them. */
	unimplementedRequirements: Array<{ requirementId: string; title: string; intentNodeId: string }>;
	/** Code structure nodes with no intent node covering them (orphan capability). */
	uncoveredCode: Array<{ nodeId: string; path: string; docPointer: string }>;
}

// ---------------------------------------------------------------------------
// ArchivistService
// ---------------------------------------------------------------------------

export class ArchivistService {
	private wiki: WikiStore;
	private cursors: WikiScanCursorStore;
	private git: ArchivistGit;
	private projectStore: ProjectStore;
	private requirementStore: RequirementStore;
	/** Default archivist agent id (single-archivist v1; multi-archivist: per-call arg). */
	private archivistId: string;

	constructor(deps: {
		wikiStore: WikiStore;
		cursorStore: WikiScanCursorStore;
		git: ArchivistGit;
		projectStore: ProjectStore;
		requirementStore: RequirementStore;
		archivistId?: string;
	}) {
		this.wiki = deps.wikiStore;
		this.cursors = deps.cursorStore;
		this.git = deps.git;
		this.projectStore = deps.projectStore;
		this.requirementStore = deps.requirementStore;
		this.archivistId = deps.archivistId ?? "archivist";
	}

	// ─── Scan entry points ──────────────────────────────────────────

	/**
	 * Scan a project's main branch and update its wiki subtree incrementally.
	 * Reads the (archivist, project) cursor, runs `git log/diff <last>..main`,
	 * and re-reads only the changed files (decision 19/26).
	 *
	 * Feature-branch WIP is NEVER picked up here — only main.
	 */
	async scanProject(projectId: string): Promise<ScanResult> {
		const project = this.projectStore.get(projectId);
		if (!project) {
			return this.emptyResult(projectId, "project not found");
		}

		// Ensure workspace is a git repo (auto-init if needed). RFC §2.15.
		await this.git.ensureRepo(project.workspaceDir);

		// Ensure the project subtree root exists in the wiki tree.
		this.wiki.ensureProjectSubtree(projectId, project.name);

		// Read the (archivist, project) scan cursor.
		const cursor = this.cursors.get(this.archivistId, projectId);
		const lastScannedRef = cursor?.lastScannedRef;

		const changeSet = await this.git.changesSince(project.workspaceDir, lastScannedRef);

		// No changes since last scan → no-op.
		if (!changeSet.isInitial && changeSet.files.length === 0) {
			return {
				projectId,
				scannedRef: changeSet.ref,
				isInitial: false,
				filesScanned: 0,
				nodesUpserted: 0,
				flagsRaised: 0,
				notes: ["no changes since last scan"],
			};
		}

		const result = await this.ingestFiles(projectId, project.workspaceDir, changeSet.files);

		// Persist the new cursor.
		if (changeSet.ref) {
			this.cursors.setLastScannedRef(this.archivistId, projectId, changeSet.ref);
		}

		return {
			projectId,
			scannedRef: changeSet.ref,
			isInitial: changeSet.isInitial,
			filesScanned: result.filesScanned,
			nodesUpserted: result.nodesUpserted,
			flagsRaised: result.flagsRaised,
			notes: result.notes,
		};
	}

	/**
	 * Periodic full rescan — re-walks the workspace and refreshes every wiki
	 * node (drift backstop, RFC §2.13). Resets the cursor to main's current
	 * HEAD at the end.
	 */
	async rescanProjectFull(projectId: string): Promise<ScanResult> {
		const project = this.projectStore.get(projectId);
		if (!project) return this.emptyResult(projectId, "project not found");

		await this.git.ensureRepo(project.workspaceDir);
		this.wiki.ensureProjectSubtree(projectId, project.name);

		const allFiles = await this.git.changesSince(project.workspaceDir, undefined);
		const result = await this.ingestFiles(projectId, project.workspaceDir, allFiles.files);

		if (allFiles.ref) {
			this.cursors.setLastScannedRef(this.archivistId, projectId, allFiles.ref);
		}
		this.cursors.setLastFullScanAt(this.archivistId, projectId, new Date().toISOString());

		return {
			projectId,
			scannedRef: allFiles.ref,
			isInitial: false,
			filesScanned: result.filesScanned,
			nodesUpserted: result.nodesUpserted,
			flagsRaised: result.flagsRaised,
			notes: [...result.notes, "full rescan"],
		};
	}

	/**
	 * Clean rebuild — drop the project's entire wiki subtree + scan cursor,
	 * then run a fresh full scan with the CURRENT structure-node logic. Use
	 * when the structure semantics changed (e.g. flat-module → directory-mirror)
	 * and the old nodes would otherwise persist as stale siblings. The project
	 * row itself is untouched.
	 */
	async rebuildProjectSubtree(projectId: string): Promise<ScanResult> {
		const project = this.projectStore.get(projectId);
		if (!project) return this.emptyResult(projectId, "project not found");
		// Wipe the old subtree (root + all descendants + body files) and the
		// scan cursor so the next scan is treated as initial.
		this.wiki.deleteByProject(projectId);
		this.cursors.delete(this.archivistId, projectId);
		return this.rescanProjectFull(projectId);
	}

	// ─── Git management (RFC §2.15) ─────────────────────────────────

	/** Commit PM-written requirement docs to main. */
	async commitRequirementDoc(
		projectId: string,
		requirementId: string,
		title: string,
		docPaths: string[],
	): Promise<{ ok: boolean; ref?: string; error?: string }> {
		const project = this.projectStore.get(projectId);
		if (!project) return { ok: false, error: "project not found" };
		await this.git.ensureRepo(project.workspaceDir);
		const r = await this.git.commitRequirementDoc(
			project.workspaceDir,
			requirementId,
			title,
			docPaths,
		);
		if (r.ok && r.ref) {
			// PM wrote the doc → archivist re-scans to ingest the new intent
			// node and (potentially) the divergence baseline.
			try {
				await this.scanProject(projectId);
			} catch (err) {
				log.warn("archivist", `post-commit scan failed: ${(err as Error).message}`);
			}
		}
		return r;
	}

	/** Merge a verified feature branch back to main + clean up its worktree. */
	async mergeFeatureToMain(projectId: string, requirementId: string) {
		const project = this.projectStore.get(projectId);
		if (!project) return { ok: false, error: "project not found" };
		await this.git.ensureRepo(project.workspaceDir);
		const r = await this.git.mergeFeatureToMain(project.workspaceDir, requirementId);
		if (r.ok) {
			// main advanced → re-scan (RFC §2.15: "合并后 main 前进 → 通知 archivist
			// 刷新 wiki/traceability").
			try {
				await this.scanProject(projectId);
			} catch (err) {
				log.warn("archivist", `post-merge scan failed: ${(err as Error).message}`);
			}
		}
		return r;
	}

	/** Clean up a feature worktree + branch (called on cancel / abort). */
	async cleanupWorktree(projectId: string, requirementId: string): Promise<void> {
		const project = this.projectStore.get(projectId);
		if (!project) return;
		await this.git.cleanupWorktree(project.workspaceDir, requirementId);
	}

	// ─── Divergence detection (RFC §2.16) ───────────────────────────

	/**
	 * Detect wiki-intent ↔ code-structure divergence:
	 *   - intent nodes whose requirement is not realized by any code structure
	 *     (requirement unimplemented → flag)
	 *   - code structure nodes with no covering intent (orphan capability → flag)
	 *
	 * Baseline = wiki intent nodes (NOT docs/basic, which is dropped — decision 31).
	 * Flags are written back onto the affected nodes so PM/lead surface them.
	 */
	async detectDivergence(projectId: string): Promise<DivergenceReport> {
		const nodes = this.wiki.listByProject(projectId);
		const intentNodes = nodes.filter((n) => n.type === "intent");
		const structureNodes = nodes.filter(
			(n) => n.type === "structure" || n.type === "header",
		);

		const unimplementedRequirements: DivergenceReport["unimplementedRequirements"] = [];
		const uncoveredCode: DivergenceReport["uncoveredCode"] = [];

		// 1. Intent nodes with no relation to any code structure → unimplemented.
		for (const intent of intentNodes) {
			const hasImpl = structureNodes.some((s) =>
				this.nodeReferences(s, intent.id) || this.sharesRequirement(s, intent),
			);
			if (!hasImpl) {
				unimplementedRequirements.push({
					requirementId: intent.requirementIds?.[0] ?? "",
					title: intent.title,
					intentNodeId: intent.id,
				});
				this.wiki.addFlag(projectId, intent.id, "intent:unimplemented");
			} else {
				this.wiki.clearFlags(projectId, intent.id);
			}
		}

		// 2. Code structure with no covering intent → orphan capability.
		for (const code of structureNodes) {
			const covered = intentNodes.some(
				(i) => this.nodeReferences(code, i.id) || this.sharesRequirement(code, i),
			);
			// Don't flag too aggressively on the very first scan: a project may
			// legitimately have code without a written requirement yet. We still
			// surface it — PM decides whether it's a hidden requirement or noise.
			if (!covered) {
				uncoveredCode.push({
					nodeId: code.id,
					path: code.path,
					docPointer: code.docPointer ?? "",
				});
				this.wiki.addFlag(projectId, code.id, "code:uncovered-by-intent");
			}
		}

		return { projectId, unimplementedRequirements, uncoveredCode };
	}

	// ─── Internal: per-file ingestion ───────────────────────────────

	private async ingestFiles(
		projectId: string,
		workspaceDir: string,
		files: string[],
	): Promise<{ filesScanned: number; nodesUpserted: number; flagsRaised: number; notes: string[] }> {
		const subtreeRoot = this.wiki.ensureProjectSubtree(projectId);
		const notes: string[] = [];
		let nodesUpserted = 0;
		let flagsRaised = 0;
		let filesScanned = 0;

		// Fresh per-scan cache of directory structure nodes so the chain is
		// built once per distinct directory across the whole file list.
		this._dirNodeCache = new Map();

		// Per-scan children-by-parent index. Built ONCE from the existing
		// subtree and maintained incrementally as we upsert nodes. This avoids
		// the O(N²) trap of calling `getChildren` (a full table scan) once per
		// file — the previous scan took minutes on a ~2800-file repo because
		// findHeader/intent-lookup each did store.list().filter per file.
		const childrenByParent = new Map<string, WikiNode[]>();
		const indexExisting = childrenByParent; // alias for clarity below
		for (const n of this.wiki.listByProject(projectId)) {
			if (!n.parentId) continue;
			const arr = indexExisting.get(n.parentId) ?? [];
			arr.push(n);
			indexExisting.set(n.parentId, arr);
		}
		const indexAdd = (parentId: string, node: WikiNode) => {
			const arr = childrenByParent.get(parentId) ?? [];
			arr.push(node);
			childrenByParent.set(parentId, arr);
		};

		// Tally file counts per directory so we can stamp a directory summary
		// (mirrors the old module-summary, now per directory).
		const dirFileCount = new Map<string, number>();

		for (const relPath of files) {
			if (this.isIgnoredPath(relPath)) continue;
			filesScanned++;

			const abs = resolve(workspaceDir, relPath);
			if (!existsSync(abs)) {
				// File was deleted — caller can prune its header node in a
				// follow-up pass. For now we skip; divergence detection later.
				continue;
			}
			const stat = statSync(abs);
			if (stat.isDirectory()) continue;

			const isCode = CODE_SUFFIXES.has(extOf(relPath));
			const isDoc = DOC_SUFFIXES.has(extOf(relPath));
			if (!isCode && !isDoc) continue;

			// The file's immediate parent directory (relPath, slash-joined) —
			// the node its header/intent leaf hangs under. Empty for repo-root
			// files (they hang directly under the project subtree root).
			const norm = relPath.split(/[\\/]+/).join("/");
			const lastSlash = norm.lastIndexOf("/");
			const dirRelPath = lastSlash >= 0 ? norm.slice(0, lastSlash) : "";
			dirFileCount.set(dirRelPath, (dirFileCount.get(dirRelPath) ?? 0) + 1);

			if (isCode) {
				// Header node: describes one code file.
				// v0.8 (P1 §10.1): docPointer is no longer a per-call input —
				// the store derives + stamps the body file path itself. The
				// reference to the actual workspace file lives in the node's
				// body (markdown link) and in the path (`header:<relPath>`).
				//
				// Performance: the rich summary (exports / head / line count) is
				// NOT computed at scan time — that would readFileSync EVERY
				// workspace file on each scan, blocking startup for large repos
				// (2800+ files). The summary is a cheap placeholder here and is
				// materialized lazily on first expand via ensureSummary (which
				// reads the file once, then caches). The tree only renders
				// title/path, so the empty summary costs nothing until expand.
				const dirNode = this.ensureDirectoryChain(projectId, subtreeRoot.id, dirRelPath);
				const existing = this.findHeader(projectId, dirNode.id, relPath, childrenByParent);
				const wasFlagged = existing?.flags?.includes("intent:no-recorded-reason");
				const upserted = this.wiki.upsertProjectNode(projectId, {
					parentId: dirNode.id,
					type: "header",
					path: `header:${relPath}`,
					title: basenameOf(relPath),
					summary: existing?.summary ?? "",
					provenance: "structure",
					lastUpdatedBy: "archivist",
				});
				if (existing && existing.id === upserted.id) {
					// update in place — replace the indexed copy
					const arr = childrenByParent.get(dirNode.id) ?? [];
					const i = arr.findIndex((c) => c.id === upserted.id);
					if (i >= 0) arr[i] = upserted;
				} else {
					indexAdd(dirNode.id, upserted);
				}
				nodesUpserted++;

				// If the previous run flagged "no recorded reason" and this
				// update produced no new intent, keep the flag (intent still
				// missing). Otherwise clear it.
				if (wasFlagged) flagsRaised++;
			} else if (isDoc) {
				// Intent node — describes a requirement / design / ADR doc.
				// Intention: derive from commit log + doc content; flag if absent.
				// Summary is lazy (see code branch above) — not read at scan time.
				const intent = this.classifyIntentDoc(relPath);
				if (intent) {
					const requirementId = this.lookupRequirementId(projectId, relPath);
					const dirNode = this.ensureDirectoryChain(projectId, subtreeRoot.id, dirRelPath);
					const intentPath = `intent:${relPath}`;
					const existingIntent = (childrenByParent.get(dirNode.id) ?? [])
						.find((c) => c.type === "intent" && c.path === intentPath);
					const upserted = this.wiki.upsertProjectNode(projectId, {
						parentId: dirNode.id,
						type: "intent",
						path: intentPath,
						title: basenameOf(relPath),
						summary: existingIntent?.summary ?? "",
						// v0.8 (P1 §10.1): docPointer is code-internal, derived
						// by the store — not an upsert input.
						provenance: "confirmed",
						requirementIds: requirementId ? [requirementId] : undefined,
						lastUpdatedBy: "archivist",
					});
					if (existingIntent && existingIntent.id === upserted.id) {
						const arr = childrenByParent.get(dirNode.id) ?? [];
						const i = arr.findIndex((c) => c.id === upserted.id);
						if (i >= 0) arr[i] = upserted;
					} else {
						indexAdd(dirNode.id, upserted);
					}
					nodesUpserted++;
				}
			}
		}

		// Stamp per-directory file counts into each directory node's summary so
		// the tree browser shows how many code/doc files live under each folder.
		for (const [dirRelPath, count] of dirFileCount.entries()) {
			const node = dirRelPath === ""
				? this.wiki.get(subtreeRoot.id)
				: this._dirNodeCache?.get(dirRelPath);
			if (node) {
				this.wiki.update(node.id, {
					summary: dirRelPath === "" ? `Project root: ${count} file(s).` : `Directory ${dirRelPath}: ${count} file(s).`,
					provenance: "structure",
				});
			}
		}

		// For any code header without a sibling intent, flag "no recorded reason".
		// This is RFC §2.13's "intent only from where humans wrote it; missing →
		// flag「无记录理由」". Uses the scan-local children index (O(children))
		// instead of getChildren (a full table scan per header).
		for (const [, siblings] of childrenByParent) {
			const hasIntent = siblings.some((c) => c.type === "intent");
			if (hasIntent) continue;
			for (const h of siblings) {
				if (h.type !== "header") continue;
				if (h.flags?.includes("intent:no-recorded-reason")) continue;
				this.wiki.addFlag(projectId, h.id, "intent:no-recorded-reason");
				flagsRaised++;
				notes.push(`flagged ${h.path}: no recorded intent (RFC §2.13)`);
			}
		}

		return { filesScanned, nodesUpserted, flagsRaised, notes };
	}

	// ─── Internal: helpers ──────────────────────────────────────────

	/**
	 * Ensure the chain of directory structure nodes for a file's containing
	 * directory, mirroring the on-disk layout. `apps/desktop/src/main/index.ts`
	 * produces/refreshes the chain `apps → desktop → src → main` (each a
	 * `structure:<dirRelPath>` node parented to its parent dir), and returns
	 * the **immediate parent dir** node (`main`) so the caller hangs the file
	 * leaf directly under it.
	 *
	 * Replaces the old `topModuleOf` flat module grouping (which collapsed
	 * every file under its top-level directory only). The node `path` is the
	 * full directory relPath (slash-joined), which is unique per dir, and the
	 * store's `(parentId, path)` upsert key makes this idempotent across scans.
	 */
	private ensureDirectoryChain(projectId: string, subtreeRootId: string, dirRelPath: string): WikiNode {
		if (dirRelPath === "" || dirRelPath === ".") return this.wiki.get(subtreeRootId)!;
		// Build bottom-up, caching so a deep tree is one pass per distinct dir.
		const cache = this._dirNodeCache ??= new Map();
		const cached = cache.get(dirRelPath);
		if (cached) return cached;
		const segs = dirRelPath.split("/").filter(Boolean);
		let parentId = subtreeRootId;
		let built = parentId;
		let acc = "";
		for (const seg of segs) {
			acc = acc ? `${acc}/${seg}` : seg;
			let node = cache.get(acc);
			if (!node) {
				const path = `structure:${acc}`;
				node = this.wiki.getByParentAndPath(parentId, path);
				if (!node) {
					node = this.wiki.upsertProjectNode(projectId, {
						parentId,
						type: "structure",
						path,
						title: seg,
						summary: `Directory ${acc}.`,
						provenance: "structure",
						lastUpdatedBy: "archivist",
					});
				}
				cache.set(acc, node);
			}
			parentId = node.id;
			built = node.id;
		}
		const result = this.wiki.get(built)!;
		cache.set(dirRelPath, result);
		return result;
	}
	private _dirNodeCache: Map<string, WikiNode> | null = null;

	private findHeader(projectId: string, moduleId: string, relPath: string, childrenByParent?: Map<string, WikiNode[]>): WikiNode | undefined {
		// v0.8 (P1 §10.1): look up by node path, NOT docPointer. docPointer is
		// now a code-internal cache of the node's body content file path
		// (derived + stamped by the store); it is never set to the workspace
		// relPath anymore. The (parentId, path) pair is the canonical upsert
		// key — `header:<relPath>` uniquely identifies one code file under
		// this directory.
		const headerPath = `header:${relPath}`;
		// Prefer the scan-local index (O(children)) over a fresh getChildren
		// (which is a full table scan — O(N) per call, O(N²) per scan).
		const children = childrenByParent
			? (childrenByParent.get(moduleId) ?? [])
			: this.wiki.getChildren(moduleId);
		return children.find((c) => c.type === "header" && c.path === headerPath);
	}

	/**
	 * Lazily compute + persist a node's rich summary on first expand. Scan
	 * time leaves summary empty (it would otherwise readFileSync every
	* workspace file); this reads the source file ONCE when the user actually
	 * opens the node, caches it back onto the row, and returns it. Subsequent
	 * expands / listings get the cached summary with no file read.
	 *
	 * Only header (code) / intent (doc) nodes have a source file to summarize;
	 * structure/project/memory nodes return their existing summary unchanged.
	 */
	ensureSummary(nodeId: string): string | undefined {
		const node = this.wiki.get(nodeId);
		if (!node) return undefined;
		// Already materialized — nothing to do.
		if (node.summary && node.summary.trim() !== "") return node.summary;
		let relPath: string | undefined;
		if (node.path.startsWith("header:")) relPath = node.path.slice("header:".length);
		else if (node.path.startsWith("intent:")) relPath = node.path.slice("intent:".length);
		if (!relPath || !node.projectId) return node.summary;
		const project = this.projectStore.get(node.projectId);
		if (!project) return node.summary;
		const abs = resolve(project.workspaceDir, relPath);
		if (!existsSync(abs)) return node.summary;
		const summary = node.path.startsWith("header:")
			? (this.summarizeCodeFile(abs, relPath) ?? "")
			: (this.summarizeDocFile(abs) ?? "");
		if (summary) {
			this.wiki.update(node.id, { summary } as any);
		}
		return summary || node.summary;
	}

	private summarizeCodeFile(absPath: string, relPath: string): string | undefined {
		try {
			const content = readFileSync(absPath, "utf-8");
			const lines = content.split(/\r?\n/);
			const exportsList = extractExports(content);
			const head = lines.slice(0, 3).join(" / ");
			const parts = [`${relPath} — ${lines.length} line(s).`];
			if (exportsList.length > 0) {
				parts.push(`Exports: ${exportsList.slice(0, 6).join(", ")}.`);
			}
			if (head.trim()) parts.push(`Head: ${head.slice(0, 120)}`);
			return parts.join(" ");
		} catch {
			return undefined;
		}
	}

	private summarizeDocFile(absPath: string): string | undefined {
		try {
			const content = readFileSync(absPath, "utf-8");
			// First non-empty heading or first paragraph.
			const heading = content.split(/\r?\n/).find((l) => /^\s*#\s+/.test(l));
			if (heading) return heading.replace(/^\s*#\s+/, "").trim().slice(0, 200);
			const firstPara = content.split(/\n\s*\n/)[0];
			return (firstPara ?? "").trim().slice(0, 200);
		} catch {
			return undefined;
		}
	}

	private classifyIntentDoc(relPath: string): boolean {
		const lower = relPath.toLowerCase();
		return INTENT_DOC_HINTS.some((hint) => lower.includes(hint));
	}

	private lookupRequirementId(projectId: string, relPath: string): string | undefined {
		// Try to match a requirement by id appearing in the doc filename
		// (e.g. docs/requirements/req-abc123.md → requirement id "req-abc123").
		const base = basenameOf(relPath).replace(/\.[^.]+$/, "");
		const reqs = this.requirementStore.listByProject(projectId);
		const match = reqs.find((r) => r.id.startsWith(base) || base.includes(r.id.substring(0, 8)));
		return match?.id;
	}

	private nodeReferences(node: WikiNode, targetId: string): boolean {
		return (node.relations ?? []).some((r) => r.targetId === targetId);
	}

	private sharesRequirement(a: WikiNode, b: WikiNode): boolean {
		const aIds = new Set(a.requirementIds ?? []);
		const bIds = b.requirementIds ?? [];
		return bIds.some((id) => aIds.has(id));
	}

	private isIgnoredPath(relPath: string): boolean {
		const parts = relPath.split(/[\\/]+/);
		if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
		if (IGNORED_FILE_SUFFIXES.some((s) => relPath.endsWith(s))) return true;
		return false;
	}

	private emptyResult(projectId: string, note: string): ScanResult {
		return {
			projectId,
			scannedRef: "",
			isInitial: false,
			filesScanned: 0,
			nodesUpserted: 0,
			flagsRaised: 0,
			notes: [note],
		};
	}
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

function extOf(p: string): string {
	const i = p.lastIndexOf(".");
	return i >= 0 ? p.slice(i).toLowerCase() : "";
}

function basenameOf(p: string): string {
	const norm = p.split(/[\\/]+/).join("/");
	return norm.slice(norm.lastIndexOf("/") + 1) || p;
}

function extractExports(content: string): string[] {
	const out = new Set<string>();
	// TS/JS export patterns — best-effort structural scan (cheap, no AST).
	const patterns = [
		/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
		/export\s+(?:async\s+)?function\*\s+([A-Za-z0-9_$]+)/g,
		/export\s+class\s+([A-Za-z0-9_$]+)/g,
		/export\s+const\s+([A-Za-z0-9_$]+)/g,
		/export\s+default\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
		/export\s+interface\s+([A-Za-z0-9_$]+)/g,
		/export\s+type\s+([A-Za-z0-9_$]+)/g,
	];
	for (const p of patterns) {
		let m: RegExpExecArray | null;
		while ((m = p.exec(content)) !== null) out.add(m[1]);
	}
	return [...out];
}

/** Sentinel re-export so callers can resolve project subtree root ids. */
export { projectSubtreeRootId };

/** Convenience for readdir-based fallback scans (when git is unavailable). */
export function walkWorkspace(rootDir: string, accumulator: string[] = [], prefix = ""): string[] {
	let entries: string[];
	try {
		entries = readdirSync(rootDir);
	} catch {
		return accumulator;
	}
	for (const name of entries) {
		if (IGNORED_DIRS.has(name)) continue;
		const abs = resolve(rootDir, name);
		const rel = prefix ? `${prefix}/${name}` : name;
		let st;
		try { st = statSync(abs); } catch { continue; }
		if (st.isDirectory()) {
			walkWorkspace(abs, accumulator, rel);
		} else {
			accumulator.push(rel);
		}
	}
	return accumulator;
}
