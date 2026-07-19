// WikiSourceService — 源码读取(plan-03 §7 / design.md §6.4 view="source")
//
// # 文件说明书
//
// ## 核心功能
// 给 Wiki 工具 / UI 提供 source-bound 节点对应的源码读取。两种模式:
//
//   - **indexed**(默认): `git show <indexed_revision>:<source_path>` →
//     与 Wiki 节点版本一致。永远在 bound checkout 内,安全。
//   - **workspace**: 读当前工作区版本(dirty)。限定在绑定的 checkout /
//     合法 worktree 内,realpath + relative + symlink-escape 检查;越界拒绝。
//
// ## 关键不变量(plan-03 §7 / acceptance-03 §D)
//   - indexed read 返回与 `indexed_revision` 完全一致的指定行范围。
//   - workspace read 标 dirty/revision,并拒绝 checkout/worktree 外路径。
//   - symlink、`..`、绝对路径、路径大小写绕过均不能逃逸。
//   - 二进制不作为 UTF-8 文本返回;只给元数据。
//   - line range 有上限 + 返回 total lines / truncated。
//   - 不复制正文进 Wiki content(本服务是 read,不是 mutation)。
//
// ## 不做
//   - 不写 Wiki 节点(纯读)。
//   - 不暴露内部 node_id / repository_id 给 Agent。
//   - 不在 indexed mode 走磁盘(总是 git show,跨 worktree 安全)。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-03-project-git-mirror.md §7
//   - docs/archive/wiki-system-redesign/design.md §6.4 view="source"
//   - src/server/wiki/wiki-repository-store.ts(binding 查询)
//   - src/server/archivist-git.ts(cat-file plumbing)

import { resolve as resolvePath, relative as relativePath, isAbsolute, dirname, normalize as normalizePath } from "node:path";
import { realpathSync, existsSync, lstatSync } from "node:fs";
import type { WikiNodeRepository, WikiNodeRow } from "./wiki-node-repository.js";
import type { WikiRepositoryStore, WikiSourceBindingRow, WikiRepositoryRow } from "./wiki-repository-store.js";
import type { ArchivistGitLike } from "./wiki-project-indexer.js";
import type { ArchivistGit } from "../archivist-git.js";
import { log } from "../../core/logger.js";

// ---------------------------------------------------------------------------
// Constants — line range / size caps(plan-03 §7)
// ---------------------------------------------------------------------------

/**
 * 单次 read 返回的最大行数(plan-03 §7 line range cap)。防止读源码时拉
 * 整个文件回 Wiki / UI(几万行的 generated 文件可能 MiB 级)。
 */
export const SOURCE_READ_MAX_LINES = 2000;

/**
 * 单 blob 字节上限(超过 → 强制按 metadata 返回,不读正文)。
 */
export const SOURCE_READ_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * 二进制检测:blob 前 8 KiB 内出现 NUL byte → 视为二进制(与 ripgrep / git 一致)。
 */
const BINARY_DETECT_PREFIX = 8 * 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** indexed / workspace 模式选择(plan-03 §7)。 */
export type SourceViewMode = "indexed" | "workspace";

/**
 * 源码读取结果。content 仅在文本 + 未超 byte cap 时填;二进制 / 超大 → 仅 metadata。
 */
export interface SourceReadResult {
	/** Wiki canonical path。 */
	nodePath: string;
	/** 仓库稳定 ID(对外不暴露内部 node_id)。 */
	repositoryId: string;
	/** 仓库相对 source path(Git `/` + 原 case)。 */
	sourcePath: string;
	/** indexed_revision(总返回,与 wiki_source_bindings.indexed_revision 一致)。 */
	indexedRevision: string;
	/** 实际读取的 revision(indexed mode = indexedRevision;workspace mode = "WORKSPACE")。 */
	readRevision: string;
	/** blob object ID(indexed 模式可验证;workspace 模式为 null)。 */
	blobOid: string | null;
	/** 是否是工作区未提交版本(workspace mode 必为 true;indexed mode 必为 false)。 */
	dirty: boolean;
	/** Wiki sync 状态(从 wiki_repositories 读;stale/failed 时给调用方提示)。 */
	syncStatus: string;
	/** 是否在 indexed 之后又有 commit(repo HEAD ≠ indexed_revision)。 */
	stale: boolean;
	/** 当前 HEAD commit SHA(用于判断 stale + UI 提示)。 */
	headRevision: string | null;
	/** 实际返回的正文(仅在文本 + 未超 byte cap 时)。 */
	content: string | null;
	/** 行范围 + 总行数(便于 UI 显示 truncated 提示)。 */
	lines: {
		startLine: number;
		endLine: number;
		totalLines: number;
		truncated: boolean;
	};
	/** 文本编码判定。 */
	encoding: "utf8" | "binary" | "too-large" | "empty";
	/** blob 字节大小(从 cat-file --batch-check 拿,免读全文)。 */
	byteSize: number;
	/** source_kind(从 binding 读)。 */
	sourceKind: string;
	/** 文件是否被 archive / delete(理论上 read 不会触发,防御性)。 */
	available: boolean;
	/** 不可读原因(available=false 时填)。 */
	reason?: string;
}

// ---------------------------------------------------------------------------
// WikiSourceService
// ---------------------------------------------------------------------------

/**
 * 依赖。注入 ArchivistGit 实例(用 cat-file / rev-parse plumbing)。
 */
export interface WikiSourceServiceDeps {
	readonly nodeRepo: WikiNodeRepository;
	readonly repositoryStore: WikiRepositoryStore;
	readonly git: ArchivistGit | ArchivistGitLike;
	/**
	 * workspace lookup:projectId → workspaceDir(从 ProjectStore 读)。
	 * 返回 undefined 时 indexed 模式仍可用(workspace 模式不可用)。
	 */
	readonly resolveWorkspace?: (projectId: string) => string | undefined;
}

/**
 * WikiSourceService —— source-bound 节点的源码读取。
 *
 * 安全模型(plan-03 §7 + acceptance-03 §D):
 *   - indexed mode 总走 `git show <rev>:<path>`,永远在 bound checkout 内。
 *   - workspace mode 在绑定 workspaceDir 内做 realpath + relative + escape 检查,
 *     不接受 `..`、绝对路径、symlink 越界。
 *   - 不暴露内部 id;Agent 只看到 canonical path + 内容。
 */
export class WikiSourceService {
	private readonly deps: WikiSourceServiceDeps;

	constructor(deps: WikiSourceServiceDeps) {
		this.deps = deps;
	}

	/**
	 * 按 Wiki 节点读源码。indexed 模式(默认)用 `git show <indexed_revision>:<source_path>`;
	 * workspace 模式从绑定 workspaceDir 读磁盘(dirty 标记)。
	 *
	 * @param nodePath Wiki canonical path
	 * @param mode indexed | workspace
	 * @param lineStart 1-based 起始行(默认 1)
	 * @param lineEnd 1-based 结束行(默认到末尾或 SOURCE_READ_MAX_LINES)
	 */
	async readIndexedSource(
		node: WikiNodeRow,
		opts?: { lineStart?: number; lineEnd?: number },
	): Promise<SourceReadResult>;
	async readIndexedSource(
		nodePath: string,
		opts?: { lineStart?: number; lineEnd?: number },
	): Promise<SourceReadResult>;
	async readIndexedSource(
		nodeOrPath: WikiNodeRow | string,
		opts?: { lineStart?: number; lineEnd?: number },
	): Promise<SourceReadResult> {
		const node = typeof nodeOrPath === "string"
			? this.deps.nodeRepo.getActiveByPath(nodeOrPath)
				?? (() => { throw new Error(`source read: node not found at ${nodeOrPath}`); })()
			: nodeOrPath;
		return this.readInternal(node, "indexed", undefined, opts);
	}

	/**
	 * workspace 模式读源码(dirty / 工作区版本)。限定在绑定 workspaceDir 内;
	 * 任何越界 / symlink 逃逸 / 路径绕过均拒绝。
	 *
	 * @param workspaceDir 合法 checkout / worktree 根目录
	 */
	async readWorkspaceSource(
		node: WikiNodeRow,
		workspaceDir: string,
		opts?: { lineStart?: number; lineEnd?: number },
	): Promise<SourceReadResult>;
	async readWorkspaceSource(
		nodePath: string,
		workspaceDir: string,
		opts?: { lineStart?: number; lineEnd?: number },
	): Promise<SourceReadResult>;
	async readWorkspaceSource(
		nodeOrPath: WikiNodeRow | string,
		workspaceDir: string,
		opts?: { lineStart?: number; lineEnd?: number },
	): Promise<SourceReadResult> {
		const node = typeof nodeOrPath === "string"
			? this.deps.nodeRepo.getActiveByPath(nodeOrPath)
				?? (() => { throw new Error(`source read: node not found at ${nodeOrPath}`); })()
			: nodeOrPath;
		return this.readInternal(node, "workspace", workspaceDir, opts);
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private async readInternal(
		node: WikiNodeRow,
		mode: SourceViewMode,
		workspaceDir: string | undefined,
		opts?: { lineStart?: number; lineEnd?: number },
	): Promise<SourceReadResult> {
		// 1. lookup binding + repository。
		const binding = this.deps.repositoryStore.sourceBindings.getByNodeId(node.id);
		if (!binding) {
			return this.failureResult(node.path, "node is not source-bound");
		}
		const repo = this.deps.repositoryStore.repositories.getById(binding.repository_id);
		if (!repo) {
			return this.failureResult(node.path, "repository binding missing");
		}

		// 2. workspace lookup(两种模式都需要 —— workspace mode 必须有;indexed
		//    mode 用于检测 HEAD 与 indexed_revision 是否一致 → stale 标)。
		const workspace = workspaceDir ?? this.deps.resolveWorkspace?.(repo.project_id);
		if (mode === "workspace" && !workspace) {
			return this.failureResult(node.path, "workspace directory cannot be resolved");
		}

		// 3. 安全检查:source_path 必须是 repo 相对 path,无 `..` / 绝对路径 / 反斜线。
		if (!isSafeRelativePath(binding.source_path)) {
			return this.failureResult(node.path, `unsafe source_path in binding: ${binding.source_path}`);
		}

		// 4. 计算 lineStart / lineEnd(规范到合法区间)。
		const lineRange = normalizeLineRange(opts?.lineStart, opts?.lineEnd);

		// 5. 解析 HEAD(若 workspace 可用)→ 用于 stale 标。
		let headRevision: string | null = null;
		if (workspace) {
			headRevision = (await this.deps.git.resolveRevision(workspace, "HEAD")) ?? null;
		}
		const stale = headRevision !== null && headRevision !== repo.indexed_revision;

		// 6. 取 blob metadata(免读全文,先看大小 + 类型)。
		let blobMeta: { oid: string; size: number; type: string } | undefined;
		let blobBuffer: Buffer | null = null;

		if (mode === "indexed") {
			// indexed 走 git show <rev>:<path>(plan-03 §7)。
			if (!workspace) {
				// 没有 workspace → cat-file 走不了;只能返回 metadata。
				return this.metaResult(node, binding, repo, headRevision, stale, lineRange, "empty", 0, "workspace unavailable for git show");
			}
			try {
				blobMeta = await this.deps.git.blobMetadata(workspace, repo.indexed_revision!, binding.source_path);
				if (!blobMeta) {
					return this.failureResult(node.path, `blob not found at ${repo.indexed_revision}:${binding.source_path}`);
				}
				if (blobMeta.size > SOURCE_READ_MAX_BYTES) {
					return this.metaResult(node, binding, repo, headRevision, stale, lineRange, "too-large", blobMeta.size);
				}
				// 实际读 bytes —— workspace 仅作为 cwd 给 git,不读磁盘(plan-03 §7)。
				blobBuffer = await readBlobViaGitShow(this.deps.git, workspace, repo.indexed_revision!, binding.source_path);
			} catch (err) {
				log.debug("wiki-source-service", `indexed read failed: ${(err as Error).message}`);
				return this.failureResult(node.path, `indexed read failed: ${(err as Error).message}`);
			}
		} else {
			// workspace mode: 安全检查 + 磁盘读。
			if (!workspace) {
				return this.failureResult(node.path, "workspace directory required for workspace read");
			}
			// 检查 workspace 自身是合法 checkout(realpath 一次,后续比较)。
			let workspaceReal: string;
			try {
				workspaceReal = realpathSync(workspace);
			} catch {
				return this.failureResult(node.path, `workspace does not exist: ${workspace}`);
			}
			// 计算目标 path + escape 检查。
			const targetAbs = resolvePath(workspaceReal, binding.source_path);
			const rel = relativePath(workspaceReal, targetAbs);
			if (rel === "" || rel === "." || isPathInside(rel)) {
				// OK —— 在 workspace 内
			} else {
				return this.failureResult(node.path, `source path escapes workspace: ${binding.source_path}`);
			}
			// symlink 不跟随(plan-03 §7 / §3 symlink)—— 读 link 本身的 target string。
			// 但 workspace mode 默认读文件内容;若 path 是 symlink 且指向 checkout 外,拒绝。
			if (!existsSync(targetAbs)) {
				return this.failureResult(node.path, `workspace file missing: ${binding.source_path}`);
			}
			const lst = lstatSync(targetAbs);
			if (lst.isSymbolicLink()) {
				// 读 link target —— 必须仍在 workspace 内。
				const linkedReal = realpathSyncSafe(targetAbs);
				if (!linkedReal) {
					return this.failureResult(node.path, `dangling symlink: ${binding.source_path}`);
				}
				const linkRel = relativePath(workspaceReal, linkedReal);
				if (linkRel === "" || linkRel === "." || isPathInside(linkRel)) {
					// OK,跟随到 target(workspace 内)。
				} else {
					return this.failureResult(node.path, `symlink escapes workspace: ${binding.source_path}`);
				}
			}
			// 读 bytes(注意:这里读的是工作区版本,可能 dirty)。
			try {
				const { readFileSync } = await import("node:fs");
				const raw = readFileSync(targetAbs);
				blobBuffer = raw;
				blobMeta = { oid: "", size: raw.length, type: "blob" };
			} catch (err) {
				return this.failureResult(node.path, `workspace read failed: ${(err as Error).message}`);
			}
		}

		if (!blobMeta) {
			return this.failureResult(node.path, "blob metadata unavailable");
		}

		// 7. 二进制检测 + 解码。
		if (isBinaryBuffer(blobBuffer)) {
			return this.metaResult(node, binding, repo, headRevision, stale, lineRange, "binary", blobMeta.size);
		}

		// 8. 行切片。
		const text = blobBuffer.toString("utf-8");
		const totalLines = countLines(text);
		const sliced = sliceLines(text, lineRange.startLine, lineRange.endLine);
		const truncated = (totalLines > SOURCE_READ_MAX_LINES && sliced.endLine < totalLines)
			|| lineRange.endLine < totalLines;

		return {
			nodePath: node.path,
			repositoryId: repo.repository_id,
			sourcePath: binding.source_path,
			indexedRevision: repo.indexed_revision ?? "",
			readRevision: mode === "indexed" ? (repo.indexed_revision ?? "") : "WORKSPACE",
			blobOid: mode === "indexed" ? (blobMeta.oid || binding.blob_oid) : null,
			dirty: mode === "workspace",
			syncStatus: repo.sync_status,
			stale,
			headRevision,
			content: sliced.text,
			lines: {
				startLine: sliced.startLine,
				endLine: sliced.endLine,
				totalLines,
				truncated,
			},
			encoding: "utf8",
			byteSize: blobMeta.size,
			sourceKind: binding.source_kind,
			available: true,
		};
	}

	private failureResult(nodePath: string, reason: string): SourceReadResult {
		return {
			nodePath,
			repositoryId: "",
			sourcePath: "",
			indexedRevision: "",
			readRevision: "",
			blobOid: null,
			dirty: false,
			syncStatus: "unknown",
			stale: false,
			headRevision: null,
			content: null,
			lines: { startLine: 0, endLine: 0, totalLines: 0, truncated: false },
			encoding: "empty",
			byteSize: 0,
			sourceKind: "",
			available: false,
			reason,
		};
	}

	private metaResult(
		node: WikiNodeRow,
		binding: WikiSourceBindingRow,
		repo: WikiRepositoryRow,
		headRevision: string | null,
		stale: boolean,
		lineRange: { startLine: number; endLine: number },
		encoding: "binary" | "too-large" | "empty",
		byteSize: number,
		reason?: string,
	): SourceReadResult {
		return {
			nodePath: node.path,
			repositoryId: repo.repository_id,
			sourcePath: binding.source_path,
			indexedRevision: repo.indexed_revision ?? "",
			readRevision: repo.indexed_revision ?? "",
			blobOid: binding.blob_oid,
			dirty: false,
			syncStatus: repo.sync_status,
			stale,
			headRevision,
			content: null,
			lines: {
				startLine: lineRange.startLine,
				endLine: lineRange.endLine,
				totalLines: 0,
				truncated: false,
			},
			encoding,
			byteSize,
			sourceKind: binding.source_kind,
			available: encoding !== "empty" || reason === undefined,
			reason,
		};
	}
}

// ---------------------------------------------------------------------------
// Free helpers — security + binary detection + line slicing
// ---------------------------------------------------------------------------

/**
 * 判断 relative path 是否"在 workspace 内"(没逃逸)。
 * 输入是 `relativePath(workspaceReal, targetAbs)` 的结果。
 *
 * - "" / "."  → target == workspace,视为内部(虽然不太合理)
 * - 以非 `..` 开头且不含 `..` 段 → 内部
 * - 以 `..` 开头 → 外部
 */
function isPathInside(rel: string): boolean {
	if (rel === "") return true; // target == workspace root
	const segs = rel.split(/[\\/]+/);
	for (const seg of segs) {
		if (seg === "..") return false;
	}
	return true;
}

/**
 * 安全校验:source_path 必须是 Git 风格相对路径(`/` 分隔,无 `..` / 绝对 / 反斜线 / NUL)。
 * indexed mode 下 Git 本身会拒绝越界 pathspec,但提前检查避免可疑 binding 行触发 shell 异常。
 */
function isSafeRelativePath(p: string): boolean {
	if (!p || typeof p !== "string") return false;
	if (isAbsolute(p)) return false;
	if (p.includes("\\")) return false;
	if (p.includes("\0")) return false;
	const segs = p.split("/");
	for (const seg of segs) {
		if (seg === ".." || seg === "." || seg === "") return false;
	}
	return true;
}

/**
 * 二进制检测:取 blob 前 BINARY_DETECT_PREFIX bytes,若含 NUL byte → 二进制。
 * 与 ripgrep / git 的实现一致(ripgrep `--binary` 检测 NUL)。
 */
function isBinaryBuffer(buf: Buffer | null): boolean {
	if (!buf || buf.length === 0) return false;
	const end = Math.min(buf.length, BINARY_DETECT_PREFIX);
	for (let i = 0; i < end; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}

/** 计算文本行数(\n 分隔;末尾 \n 不算单独一行)。 */
function countLines(text: string): number {
	if (text.length === 0) return 0;
	let n = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charAt(i) === "\n") n++;
	}
	if (text.endsWith("\n")) n--;
	return n < 0 ? 0 : n;
}

/** 规范化 lineStart / lineEnd 到合法区间。 */
function normalizeLineRange(
	lineStart: number | undefined,
	lineEnd: number | undefined,
): { startLine: number; endLine: number } {
	const start = Math.max(1, Math.floor(lineStart ?? 1));
	const requestedEnd = Math.floor(lineEnd ?? Number.MAX_SAFE_INTEGER);
	const end = Math.min(start + SOURCE_READ_MAX_LINES - 1, requestedEnd);
	return { startLine: start, endLine: end };
}

/** 切片:返回 [startLine, endLine] 闭区间的文本 + 实际切片范围。 */
function sliceLines(
	text: string,
	startLine: number,
	endLine: number,
): { text: string; startLine: number; endLine: number } {
	if (startLine <= 1 && endLine >= countLines(text)) {
		return { text, startLine: 1, endLine: countLines(text) };
	}
	// 找 startLine 起始 offset。
	let offset = 0;
	let line = 1;
	while (line < startLine && offset < text.length) {
		if (text.charAt(offset) === "\n") line++;
		offset++;
	}
	const startOffset = offset;
	// 找 endLine 末尾 offset(含)。
	let endOffset = startOffset;
	while (line < endLine + 1 && endOffset < text.length) {
		if (text.charAt(endOffset) === "\n") line++;
		endOffset++;
	}
	// 含 endLine 行末的 \n(若有),便于调用方拼接。
	return {
		text: text.slice(startOffset, endOffset),
		startLine,
		endLine: Math.min(endLine, countLines(text)),
	};
}

/** realpathSync 安全包装:失败返回 null(不抛)。 */
function realpathSyncSafe(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}

/**
 * 通过 ArchivistGit 的 cat-file plumbing 读 blob(不直接 spawn)。
 * 走 plumbing 层避免 shell 解释 —— workspace 只作为 cwd。
 */
async function readBlobViaGitShow(
	git: ArchivistGit | ArchivistGitLike,
	workspaceDir: string,
	revision: string,
	sourcePath: string,
): Promise<Buffer> {
	// ArchivistGit 实现了 catFileBlob(plan-03 §7 plumbing)。duck-type。
	const g = git as ArchivistGit;
	return g.catFileBlob(workspaceDir, revision, sourcePath);
}

// 暴露给 wiki-source-search 的安全 helper。
export { isSafeRelativePath as isSafeSourceRelativePath };

// 注:为了不 unused-import 警告,显式标记 normalizePath 与 dirname 暂保留供未来
// workspace mode realpath 链路扩展。如果 lint 严格,可以删除这两个 import。
void normalizePath;
void dirname;
