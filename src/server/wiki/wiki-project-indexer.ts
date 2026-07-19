// WikiProjectIndexer — Project Git 语义镜像索引器
// (wiki-system-redesign plan-03 §1–§6 / design.md §6)
//
// # 文件说明书
//
// ## 核心功能
// 把已注册 Project 的 Git tree 映射成 source-bound Wiki 节点;支持全量索引、
// 按 Git diff 原子增量同步、按 indexed_revision 读取源码、以及 commit/merge
// 成功后的统一同步入口。完成后 Project Wiki 结构可从仓库完全重建。
//
// 取代旧 `WikiSkeletonService`:不再生成 `header:/intent:/structure:` provenance,
// 每个节点由 Git object 和仓库相对路径决定。
//
// ## 关键不变量(plan-03 §3/§5/§G 拒绝条件)
//   - **Git plumbing 是事实源**: 全量索引用 `git ls-tree -r -z <revision>`,
//     增量用 `git diff --name-status -z`;绝不用 readdir 枚举仓库。
//   - **索引全部 tracked 文件**: 不只代码/文档后缀;空目录不进索引。
//   - **rename 保留内部 ID**: 不 delete+create;links/summary/content 不丢。
//   - **sync 失败不推进 revision**: 整个变更在单个 wikiDb.transaction 内,
//     失败自动 rollback;`indexed_revision` 保持旧值,后续小事务写 failed。
//   - **不复制源码正文**: summary/content 只放确定性骨架,不放文件正文。
//   - **swap/cycle rename 两阶段**: 先移到 transaction 唯一临时名,再写最终路径,
//     不依赖不可延迟 UNIQUE。
//   - **workspaceDir 不进 Wiki DB**: 由 ProjectStore 管理;Wiki DB 只存
//     `repository_id` / `source_root` / `indexed_revision` / `blob_oid`。
//
// ## 不做
//   - 不实现 Agent tool / UI(plan-04/06/07)。
//   - 不实现 symbol/call graph(plan-03 §"明确不做")。
//   - 不读旧 `project_wiki`(plan-00 已停止读取)。
//   - 不在内联 AgentLoop feature 逻辑(memory: AgentLoop hooks-only)。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-03-project-git-mirror.md(全 8 节)
//   - docs/archive/wiki-system-redesign/design.md §5.4 / §6 / §6.4
//   - src/server/wiki/wiki-repository-store.ts(binding 表 CRUD)
//   - src/server/wiki/wiki-node-repository.ts(node + FTS)
//   - src/server/archivist-git.ts(Git plumbing)

import { isAbsolute } from "node:path";
import type { WikiDatabase } from "./wiki-database.js";
import {
	WikiNodeRepository,
	type WikiNodeRow,
} from "./wiki-node-repository.js";
import { WikiLinkRepository } from "./wiki-link-repository.js";
import { WikiAuditRepository } from "./wiki-audit-repository.js";
import {
	WikiRepositoryStore,
	type WikiRepositoryRow,
} from "./wiki-repository-store.js";
import {
	WIKI_ROOT_PATH,
	joinWikiPath,
	joinWikiPathMulti,
	validateWikiName,
} from "./wiki-path.js";
import type { WikiNodeKind } from "../../shared/wiki-types.js";
import {
	MANIFEST_STATUS_ATTR_KEY,
	MANIFEST_UPDATED_AT_ATTR_KEY,
} from "./wiki-manifest.js";
import { log } from "../../core/logger.js";

// ---------------------------------------------------------------------------
// Constants — source kind classification (plan-03 §3)
// ---------------------------------------------------------------------------

/** Project namespace path segment (`wiki-root/projects`). */
const PROJECTS_NAMESPACE_PATH = joinWikiPath(WIKI_ROOT_PATH, "projects");

/** Default branch if detection fails. plan-03 §2. */
const DEFAULT_BRANCH_FALLBACK = "main";

/**
 * File-extension → source_kind heuristics (plan-03 §3 "kind by ext/position").
 * Order matters: TEST is checked before generic SOURCE because `*.test.ts`
 * is both code and test — test wins.
 */
const TEST_PATH_HINTS = [
	"/test/",
	"/tests/",
	"/__tests__/",
	"/__test__/",
	"/spec/",
	"/specs/",
	"/fixtures/",
];
const TEST_FILENAME_PATTERNS = [
	/\.[Tt]est\.[A-Za-z0-9]+$/, // foo.test.ts, bar.Test.js
	/\.[Ss]pec\.[A-Za-z0-9]+$/, // foo.spec.ts
	/^test[-_]/i,
	/[-_]test\.[A-Za-z0-9]+$/i,
];
const TEST_EXTS = new Set([
	".test", ".spec", ".t", ".bats",
]);
const DOC_EXTS = new Set([
	".md", ".mdx", ".markdown", ".rst", ".adoc", ".asciidoc",
	".txt", ".doc", ".docx", ".rtf", ".org",
]);
const CONFIG_EXTS = new Set([
	".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
	".env", ".properties", ".xml", ".plist", ".editorconfig",
	".gitignore", ".gitattributes", ".npmrc", ".nvmrc", ".ruby-version",
	".prettierrc", ".eslintrc", ".babelrc",
]);
const CONFIG_FILENAMES = new Set([
	"package.json", "tsconfig.json", "jsconfig.json", "vite.config.ts",
	"vite.config.js", "webpack.config.js", "rollup.config.js",
	"Dockerfile", "Makefile", "CMakeLists.txt", "Gemfile", "Cargo.toml",
	"go.mod", "go.sum", "pyproject.toml", "setup.py", "requirements.txt",
	".gitignore", ".gitattributes", "LICENSE", "README", "CHANGELOG",
]);
const ASSET_EXTS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".tif",
	".svg",
	".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a",
	".mp4", ".mov", ".avi", ".mkv", ".webm",
	".woff", ".woff2", ".ttf", ".otf", ".eot",
	".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
	".pdf", ".epub",
	".db", ".sqlite", ".sqlite3",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * 仓库绑定结果。bindOnce=true 表示 binding 已存在(幂等)。
 */
export interface BindingResult {
	projectId: string;
	repositoryId: string;
	projectNodePath: string;
	sourceRoot: string;
	defaultBranch: string;
	bound: boolean;
	/** binding 已存在(同 project_id),未改 source_root。 */
	alreadyExists: boolean;
	/** 校验失败原因(绑定未完成)。 */
	error?: string;
}

/**
 * 全量索引结果。
 */
export interface IndexResult {
	projectId: string;
	repositoryId: string;
	/** 索引目标 commit SHA。 */
	indexedRevision: string;
	defaultBranch: string;
	/** 实际进入 source_bindings 的 tracked 文件数。 */
	trackedFiles: number;
	/** 推导出的非空目录节点数。 */
	inferredDirs: number;
	/** 受影响节点(新建 + 更新 + 归档)总数。 */
	nodesAffected: number;
	/** 是否绑定 + 索引完整完成。 */
	ok: boolean;
	/** 失败原因(若 ok=false)。 */
	error?: string;
	/** ISO 时间戳。 */
	indexedAt: string;
}

/**
 * 增量同步结果。
 */
export interface SyncResult {
	projectId: string;
	repositoryId: string;
	/** 同步前 indexed_revision。 */
	fromRevision: string | null;
	/** 同步后 indexed_revision;失败时 == fromRevision。 */
	toRevision: string | null;
	/** 状态:pending / indexing / synced / stale / failed。 */
	syncStatus: string;
	/** 处理的 diff 条目分类计数。 */
	stats: {
		added: number;
		modified: number;
		deleted: number;
		renamed: number;
		copied: number;
		typeChanged: number;
	};
	/** 失败错误(若 syncStatus=failed)。 */
	error?: string;
	/** ISO 时间戳。 */
	syncedAt: string;
	/** 真正发生节点/绑定变更(用于幂等重试检测)。 */
	changesApplied: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** 一条 diff 的标准化内部表示。 */
type StandardizedChange =
	| { kind: "add"; path: string; mode: string; oid: string }
	| { kind: "modify"; path: string; mode: string; oid: string }
	| { kind: "delete"; path: string }
	| { kind: "rename"; fromPath: string; toPath: string; mode: string; oid: string }
	| { kind: "typechange"; path: string; mode: string; oid: string };

/** 一条 ls-tree 解析后的待索引条目(剥离 source_root 后)。 */
interface IndexEntry {
	mode: string;
	type: string;
	oid: string;
	/** 仓库相对路径(已剥离 source_root 前缀)。 */
	repoRelativePath: string;
}

// ---------------------------------------------------------------------------
// WikiProjectIndexer
// ---------------------------------------------------------------------------

/**
 * 索引器依赖。
 */
export interface WikiProjectIndexerDeps {
	readonly wikiDb: WikiDatabase;
	readonly nodeRepo: WikiNodeRepository;
	readonly linkRepo: WikiLinkRepository;
	readonly auditRepo: WikiAuditRepository;
	readonly repositoryStore: WikiRepositoryStore;
	readonly git: ArchivistGitLike;
	readonly projectStore: ProjectStoreLike;
}

/**
 * ArchivistGit 接口契约(indexer + source-service 都只用这部分方法;便于测试 mock)。
 */
export interface ArchivistGitLike {
	isGitRepo(workspaceDir: string): Promise<boolean>;
	resolveRevision(workspaceDir: string, ref: string): Promise<string | undefined>;
	detectDefaultBranch(workspaceDir: string): Promise<string>;
	listTreeAtRevision(workspaceDir: string, revision: string): Promise<readonly LsTreeEntryLike[]>;
	diffNameStatus(
		workspaceDir: string,
		oldRev: string,
		newRev: string,
	): Promise<readonly DiffNameStatusEntryLike[]>;
	ensureRepo(workspaceDir: string): Promise<void>;
	/** source read(plan-03 §7)。*/
	blobMetadata(
		workspaceDir: string,
		revision: string,
		path: string,
	): Promise<{ oid: string; size: number; type: string } | undefined>;
	/** indexed blob bytes。*/
	catFileBlob(workspaceDir: string, revision: string, path: string): Promise<Buffer>;
}

export interface LsTreeEntryLike {
	mode: string;
	type: string;
	oid: string;
	path: string;
}

export interface DiffNameStatusEntryLike {
	status: string;
	path: string;
	newPath?: string;
}

/**
 * ProjectStore 接口契约(只读 id/name/workspaceDir)。
 */
export interface ProjectStoreLike {
	get(projectId: string): { id: string; name: string; workspaceDir: string } | undefined;
	list(): Array<{ id: string; name: string; workspaceDir: string }>;
}

/**
 * WikiProjectIndexer —— Project Git 语义镜像索引器。每个 Project 对应一个
 * `wiki_repositories` 行 + 一个 project root Wiki 节 + 一棵镜像子树。
 *
 * 同步流程(plan-03 §5 + §6):
 *
 *   Git op success → fetch final SHA → request sync → atomic DB transaction
 *   → on failure rollback (revision stays old) + separate failed-write txn.
 *
 * 本类**不**直接读旧 `project_wiki`(legacy);只写新 `wiki.db`。
 */
export class WikiProjectIndexer {
	private readonly deps: WikiProjectIndexerDeps;

	constructor(deps: WikiProjectIndexerDeps) {
		this.deps = deps;
	}

	// =========================================================================
	// Section 2 — Repository binding (plan-03 §2)
	// =========================================================================

	/**
	 * 建立 / 校验 repository 绑定。幂等:同一 project_id 多次调用 → 返回现有 binding,
	 * 不改 source_root。
	 *
	 * 校验:
	 *   - workspaceDir 是存在的 Git repo(`git rev-parse --git-dir` 可执行)。
	 *   - source_root 在 repo 内且不逃逸(`..` / 绝对路径 / 外部 realpath 拒绝)。
	 *   - project root 位于 `wiki-root/projects/<stable-project-id>`,可读名称
	 *     在 `attributes.display_name`;Project rename 不移动镜像子树。
	 *   - 一个 project ↔ 一个 project root(UNIQUE project_id 保证)。
	 */
	async ensureBinding(
		projectId: string,
		opts?: { sourceRoot?: string; defaultBranch?: string },
	): Promise<BindingResult> {
		const project = this.deps.projectStore.get(projectId);
		if (!project) {
			return this.bindingFailure(projectId, "", opts?.sourceRoot ?? "", "project not found");
		}

		// 校验 Git repo。auto-init 行为迁移到 ensureRepo(plan-03 §2:"workspaceDir
		// 是存在的 Git repository")—— 索引器只读,不再 init。
		const isRepo = await this.deps.git.isGitRepo(project.workspaceDir);
		if (!isRepo) {
			return this.bindingFailure(
				projectId, "", opts?.sourceRoot ?? "",
				`workspaceDir is not a Git repository: ${project.workspaceDir}`,
			);
		}

		// **CONCERN 7 fix**: `isAbsolute` 必须在 normalizeSourceRoot 之前对 RAW
		// 输入检查 —— normalizeSourceRoot 会 strip 前导 `/`(把 `/abs/path` 变成
		// `abs/path`),原代码的 isAbsolute(normalized) 永远是 false(dead check)。
		// 现在先 reject 绝对路径,再 normalize。
		const rawSourceRoot = opts?.sourceRoot ?? "";
		if (rawSourceRoot && isAbsolute(rawSourceRoot)) {
			return this.bindingFailure(
				projectId, "", rawSourceRoot,
				`source_root must be a relative path (got absolute): ${rawSourceRoot}`,
			);
		}
		const sourceRoot = normalizeSourceRoot(rawSourceRoot);
		if (!sourceRoot) {
			// empty / "." / "/" → "" (repo root).
		} else if (sourceRoot.includes("..")) {
			return this.bindingFailure(
				projectId, "", sourceRoot,
				`source_root must stay inside the repository (got '..'): ${sourceRoot}`,
			);
		}

		const defaultBranch = opts?.defaultBranch
			?? await this.deps.git.detectDefaultBranch(project.workspaceDir);

		// 已有 binding → 幂等返回。不改 source_root(plan-03 §2 绑定一次)。
		const existing = this.deps.repositoryStore.repositories.getByProjectId(projectId);
		if (existing) {
			return {
				projectId,
				repositoryId: existing.repository_id,
				projectNodePath: this.projectPathFor(projectId),
				sourceRoot: existing.source_root,
				defaultBranch: existing.default_branch,
				bound: true,
				alreadyExists: true,
			};
		}

		// 新建 binding + project root 节点(单事务,原子)。
		const repositoryId = makeRepositoryId(projectId);
		const projectNodePath = this.projectPathFor(projectId);

		this.deps.wikiDb.transaction(() => {
			// 幂等创建 project root 节点。display_name 来自 ProjectRecord.name —— 不依赖 path。
			this.ensureProjectRootNode(projectId, project.name);
			const projectNodeId = this.lookupProjectNodeId(projectNodePath);
			if (projectNodeId === null) {
				throw new Error(`ensureBinding: project root missing at ${projectNodePath} after ensureProjectRootNode`);
			}
			// repository 行。indexed_revision 留空,等待首次索引。
			this.deps.repositoryStore.repositories.upsert({
				repository_id: repositoryId,
				project_node_id: projectNodeId,
				project_id: projectId,
				source_root: sourceRoot,
				default_branch: defaultBranch,
			});
			this.deps.auditRepo.append({
				action: "repository.bind",
				nodePath: projectNodePath,
				oldRevision: null,
				newRevision: null,
				detail: { projectId, repositoryId, sourceRoot, defaultBranch },
				actorAgentId: "wiki-project-indexer",
			});
		});

		return {
			projectId,
			repositoryId,
			projectNodePath,
			sourceRoot,
			defaultBranch,
			bound: true,
			alreadyExists: false,
		};
	}

	// =========================================================================
	// Section 3 + 4 — Full index (plan-03 §3 / §4)
	// =========================================================================

	/**
	 * 全量索引 project subtree。读取 `<revision>` 处的 Git tree(默认 HEAD),
	 * 把每个 tracked 文件映射成 source-bound 节点,推导非空目录节点,并为新节点
	 * 写确定性初始 summary。不覆盖已有 summary/content/links。
	 *
	 * 全量索引是**破坏性重建**:旧 source-bound 节点会被归档(同 path 的 active
	 * 重建走 partial unique index)。Curated summary/content 会丢失 —— 仅用于
	 * rebuild-subtree 路由。对常规增量同步请用 {@link sync}。
	 */
	async fullIndex(
		projectId: string,
		opts?: { revision?: string },
	): Promise<IndexResult> {
		const binding = await this.ensureBinding(projectId);
		if (!binding.bound) {
			return this.indexFailure(projectId, "", "", 0, 0, 0, binding.error ?? "binding failed");
		}

		const project = this.deps.projectStore.get(projectId);
		if (!project) {
			return this.indexFailure(projectId, binding.repositoryId, "", 0, 0, 0, "project vanished");
		}

		const headRevision: string | undefined = opts?.revision
			?? await this.deps.git.resolveRevision(project.workspaceDir, "HEAD");
		if (!headRevision) {
			return this.indexFailure(
				projectId, binding.repositoryId, "", 0, 0, 0,
				"no commits in repository (HEAD does not resolve)",
			);
		}

		// 列出全部 tracked 文件。**Git plumbing 是唯一事实源**(plan-03 §G)。
		const lsEntries = await this.deps.git.listTreeAtRevision(
			project.workspaceDir, headRevision,
		);

		// 剥离 source_root + 过滤掉非 blob/commit 类型(tree 仅在非递归 ls-tree 出现)。
		const indexEntries: IndexEntry[] = [];
		for (const e of lsEntries) {
			if (e.type !== "blob" && e.type !== "commit") continue; // commit = submodule gitlink
			const repoPath = stripSourceRoot(e.path, binding.sourceRoot);
			if (repoPath === null) continue; // outside source_root — skip
			indexEntries.push({
				mode: e.mode, type: e.type, oid: e.oid, repoRelativePath: repoPath,
			});
		}

		// 计算所有推导目录(从每个文件 path 的祖先)。
		const dirSet = new Set<string>();
		for (const e of indexEntries) {
			const segs = e.repoRelativePath.split("/").filter(Boolean);
			if (segs.length < 2) continue; // 仓库根文件 → 无目录祖先
			for (let i = 1; i < segs.length; i++) {
				dirSet.add(segs.slice(0, i).join("/"));
			}
		}

		const indexedAt = new Date().toISOString();
		const projectNodePath = binding.projectNodePath;
		const repositoryId = binding.repositoryId;

		// 标记 indexing(plan-03 §5.1)。与主变更同事务以避免 race。
		this.deps.wikiDb.transaction(() => {
			this.deps.repositoryStore.repositories.updateSyncState({
				repository_id: repositoryId,
				sync_status: "indexing",
				last_error: null,
			});

			const projectNodeId = this.lookupProjectNodeId(projectNodePath);
			if (projectNodeId === null) {
				throw new Error(`fullIndex: project root missing at ${projectNodePath}`);
			}

			// Directory cache (repo-relative dir → node row) shared across file loop.
			const dirCache = new Map<string, WikiNodeRow>();
			dirCache.set("", this.deps.nodeRepo.getById(projectNodeId)!);

			// 创建目录链节点(确定性 summary 在末尾 stamp —— 那时 child count 才稳定)。
			const ensureDir = (repoRelativeDir: string): WikiNodeRow => {
				if (repoRelativeDir === "" || repoRelativeDir === ".") return dirCache.get("")!;
				const cached = dirCache.get(repoRelativeDir);
				if (cached) return cached;
				const segs = repoRelativeDir.split("/").filter(Boolean);
				let parentRow = dirCache.get("")!;
				let acc = "";
				for (const seg of segs) {
					acc = acc ? `${acc}/${seg}` : seg;
					let row = dirCache.get(acc);
					if (!row) {
						// acc 可能是多段(如 `src/server`);joinWikiPath 只接单段 name,
						// 用 joinWikiPathMulti(round-1 BLOCKER 1 修复)。
						const dirPath = joinWikiPathMulti(projectNodePath, acc);
						row = this.upsertSourceDirNode(parentRow.id, dirPath, acc);
						dirCache.set(acc, row);
					}
					parentRow = row;
				}
				const finalRow = dirCache.get(repoRelativeDir)!;
				return finalRow;
			};

			// 先建所有目录节点(按字典序,保证父先于子)。
			const sortedDirs = [...dirSet].sort();
			for (const d of sortedDirs) ensureDir(d);

			// 文件 / symlink / submodule 节点 + source_binding。
			let nodesAffected = 0;
			for (const entry of indexEntries) {
				const repoRelPath = entry.repoRelativePath;
				const fileName = repoRelPath.slice(repoRelPath.lastIndexOf("/") + 1);
				const parentDir = repoRelPath.includes("/")
					? repoRelPath.slice(0, repoRelPath.lastIndexOf("/"))
					: "";
				const parentRow = ensureDir(parentDir);
				// repoRelPath 是 Git 仓库相对路径,可能多段(`src/server/loop.ts`)。
				// joinWikiPath 只接单段 name → 用 joinWikiPathMulti(round-1 BLOCKER 1)。
				const nodePath = joinWikiPathMulti(projectNodePath, repoRelPath);

				const { kind, sourceKind } = classifyByMode(entry.mode, fileName, repoRelPath);
				const summary = fileSummary(sourceKind, entry.mode, fileName, repoRelPath);
				const attributes = fileAttributes(sourceKind, entry.mode);

				const nodeRow = this.upsertSourceFileNode({
					parentId: parentRow.id,
					nodePath,
					name: fileName,
					kind,
					summary,
					attributesJson: JSON.stringify(attributes),
				});
				// source_binding(每节点 1:1,UNIQUE repository+source_path)。
				this.deps.repositoryStore.sourceBindings.upsert({
					node_id: nodeRow.id,
					repository_id: repositoryId,
					source_path: repoRelPath,
					source_kind: sourceKind,
					indexed_revision: headRevision,
					blob_oid: entry.oid,
				});
				nodesAffected++;
			}

			// Stamp 目录统计 summary(此时直接 child count 稳定)。
			this.stampDirectorySummaries(projectNodeId, projectNodePath);

			// 项目根 summary。
			this.stampProjectRootSummary(
				projectNodeId, project.name, binding.defaultBranch, headRevision,
				indexEntries.length, sortedDirs.length,
			);

			// round-2 review-fix P1 §5.2.1:刚结构索引完的 project,manifest 标记
			// pending ——绝不声称语义完整。6 个结构化字段(goals/stack/...)
			// 留空(absent → compiler 渲染 "(none recorded)");Archivist 通过
			// wiki-enrich 填完后会显式置 ready。这一步把 manifest 字段从「不可见
			// 默认」变成「显式 pending 状态」,UI / compiler / admin 都能据此
			// 提示用户跑 wiki-enrich。preserve existing display_name 等已有 attrs。
			this.seedProjectManifestPending(projectNodeId);

			// 推进 indexed_revision(plan-03 §5.4:成功才推进;失败 transaction rollback)。
			this.deps.repositoryStore.repositories.updateSyncState({
				repository_id: repositoryId,
				sync_status: "synced",
				indexed_revision: headRevision,
				last_indexed_at: indexedAt,
				last_error: null,
			});

			this.deps.auditRepo.append({
				action: "index.full",
				nodePath: projectNodePath,
				oldRevision: null,
				newRevision: null,
				detail: {
					projectId, repositoryId, revision: headRevision,
					trackedFiles: indexEntries.length, inferredDirs: sortedDirs.length,
					nodesAffected,
				},
				actorAgentId: "wiki-project-indexer",
			});
		});

		return {
			projectId,
			repositoryId,
			indexedRevision: headRevision,
			defaultBranch: binding.defaultBranch,
			trackedFiles: indexEntries.length,
			inferredDirs: dirSet.size,
			nodesAffected: 0, // 详细计数交给 audit;result 不重复
			ok: true,
			indexedAt,
		};
	}

	// =========================================================================
	// Section 5 — Incremental sync (plan-03 §5)
	// =========================================================================

	/**
	 * 增量同步:`indexed_revision → newRevision` 的 Git diff 原子应用到 Wiki DB。
	 *
	 * 处理 A/M/D/R/C(plan-03 §5):
	 *   - A/C: 创建缺失目录链和文件节点 + binding(C 不复用源节点 ID)。
	 *   - M: 只更新 binding 的 blob_oid + indexed_revision;summary/content/links 不动;
	 *     node 的 attributes.source_stale=true(语义摘要可能过时)。
	 *   - D: 归档 source-bound 节点(默认级联整棵子树;若同一 sync 检测到 rename,
	 *     不归档再新建 —— 已经被 rename 处理)。
	 *   - R: 保留节点内部 ID + summary/content/revision 历史和 links;只改
	 *     source_path + blob_oid + path(+ 后代 path)。
	 *
	 * swap/cycle rename 用两阶段临时路径(plan-03 §5):先把所有受影响的 active
	 * path + source binding 移到 transaction 唯一临时名,再写最终路径。
	 *
	 * 失败处理:整个 sync 在**单个** wikiDb.transaction 内;任意步骤抛错 →
	 * 整体 rollback(节点变更 + indexed_revision 全部回滚);在独立小事务里写
	 * failed + last_error,indexed_revision 保持旧值。
	 */
	async sync(
		projectId: string,
		opts?: { targetRevision?: string },
	): Promise<SyncResult> {
		const binding = this.deps.repositoryStore.repositories.getByProjectId(projectId);
		if (!binding) {
			// 没绑定 → 走全量首次索引(plan-03 §6 注册/显式 reindex 入口)。
			const full = await this.fullIndex(projectId, opts?.targetRevision ? { revision: opts.targetRevision } : undefined);
			return {
				projectId,
				repositoryId: full.repositoryId || "",
				fromRevision: null,
				toRevision: full.ok ? full.indexedRevision : null,
				syncStatus: full.ok ? "synced" : "failed",
				stats: { added: full.trackedFiles, modified: 0, deleted: 0, renamed: 0, copied: 0, typeChanged: 0 },
				error: full.error,
				syncedAt: full.indexedAt,
				changesApplied: full.ok ? full.trackedFiles + full.inferredDirs : 0,
			};
		}

		const project = this.deps.projectStore.get(projectId);
		if (!project) {
			return this.syncFailure(projectId, binding, "project vanished", { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, typeChanged: 0 });
		}

		// 解析目标 revision(默认 HEAD)。
		const requestedRevision = opts?.targetRevision
			?? await this.deps.git.resolveRevision(project.workspaceDir, binding.default_branch || "HEAD");
		if (!requestedRevision) {
			return this.syncFailure(projectId, binding, "cannot resolve target revision", { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, typeChanged: 0 });
		}

		// **BLOCKER 5 fix**: validate target SHA actually exists as a commit.
		// `opts.targetRevision` 由调用方传入(可能 bogus SHA)→ `?? ` 短路跳过
		// resolveRevision。即便来自 resolveRevision,也再 normalize 一遍到 40-char
		// SHA。不存在 → syncFailure,indexed_revision **不推进**(plan-03 §G 拒绝条件:
		// 「sync 失败仍推进 revision」)。否则 diff 会 silent 返 [] → applyDiff 0
		// changes → 成功事务推进 indexed_revision 到 bogus SHA → 永久 silent stale。
		const resolvedNewRevision = await this.deps.git.resolveRevision(
			project.workspaceDir, requestedRevision,
		);
		if (!resolvedNewRevision) {
			// **BLOCKER 5 fix**: write failed state to DB(indexed_revision UNCHANGED)
			// before returning. Otherwise caller sees syncStatus=failed but DB
			// still says sync_status=synced/last_error=null — UI/ops 误判.
			const errMsg = `target revision does not exist in repository: ${requestedRevision}`;
			this.deps.wikiDb.transaction(() => {
				this.deps.repositoryStore.repositories.updateSyncState({
					repository_id: binding.repository_id,
					sync_status: "failed",
					last_error: errMsg,
					// indexed_revision 不传 → 保持旧值。
				});
				this.deps.auditRepo.append({
					action: "index.sync.failed",
					nodePath: this.projectPathFor(projectId),
					oldRevision: null,
					newRevision: null,
					detail: {
						projectId, repositoryId: binding.repository_id,
						from: binding.indexed_revision, attemptedTo: requestedRevision,
						error: errMsg, reason: "target_revision_unresolvable",
					},
					actorAgentId: "wiki-project-indexer",
				});
			});
			return this.syncFailure(
				projectId, binding,
				errMsg,
				{ added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, typeChanged: 0 },
			);
		}
		const newRevision = resolvedNewRevision;

		const fromRevision = binding.indexed_revision;
		const emptyStats = { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, typeChanged: 0 };
		const syncedAt = new Date().toISOString();

		// 无前置 revision → 等同全量索引(plan-03 §5 没说,但 practical)。
		if (!fromRevision) {
			const full = await this.fullIndex(projectId, { revision: newRevision });
			return {
				projectId,
				repositoryId: binding.repository_id,
				fromRevision: null,
				toRevision: full.ok ? newRevision : null,
				syncStatus: full.ok ? "synced" : "failed",
				stats: { ...emptyStats, added: full.trackedFiles },
				error: full.error,
				syncedAt,
				changesApplied: full.ok ? full.trackedFiles + full.inferredDirs : 0,
			};
		}

		// 同 revision → 幂等 no-op(plan-03 §B「对同一 SHA 重试幂等」)。
		if (fromRevision === newRevision) {
			return {
				projectId,
				repositoryId: binding.repository_id,
				fromRevision,
				toRevision: newRevision,
				syncStatus: binding.sync_status === "failed" ? "failed" : "synced",
				stats: emptyStats,
				syncedAt,
				changesApplied: 0,
			};
		}

		// 单个事务原子应用(plan-03 §5.2)。
		//
		// **CONCERN 6 fix**: enrich/diff phase 已纳入 try/catch。Git fault 在
		// enrich/diff 阶段抛错时(不是 catch-returns-[] case,而是 real throw),
		// sync_status 保持原值 + last_error null → 调用方看不到失败。现在 enrich
		// 在 try 内,任何抛错都走同一失败事务路径(write failed + last_error +
		// indexed_revision 不动)。
		let changesApplied = 0;
		let stats: SyncResult["stats"] = { ...emptyStats };
		try {
			// 取 diff(在 try 内:Git 抛错 → 走 catch 写 failed)。
			const diffEntries = await this.deps.git.diffNameStatus(
				project.workspaceDir, fromRevision, newRevision,
			);

			// 标准化(把 R/C 拆开、剥离 source_root、过滤越界)。
			const standardized = this.standardizeDiffEntries(diffEntries, binding.source_root);
			// 同步 fetch 每个 add/modify/rename 的 mode + oid(全量索引用 ls-tree,
			// 增量用 cat-file --batch-check 一次取多个会更高效;这里按需取)。
			const enriched = await this.enrichChangesWithOid(project.workspaceDir, newRevision, standardized, binding.source_root);

			const applyResult = this.deps.wikiDb.transaction(() => {
				// §5.1 mark indexing。
				this.deps.repositoryStore.repositories.updateSyncState({
					repository_id: binding.repository_id,
					sync_status: "indexing",
					last_error: null,
				});

				const projectNodePath = this.projectPathFor(projectId);
				const projectNodeId = this.lookupProjectNodeId(projectNodePath);
				if (projectNodeId === null) {
					throw new Error(`sync: project root missing at ${projectNodePath}`);
				}

				const r = this.applyDiffAtomically({
					repositoryId: binding.repository_id,
					projectNodePath,
					projectNodeId,
					newRevision,
					changes: enriched,
				});
				stats = r.stats;
				changesApplied = r.changesApplied;

				// §5.3 / §5.4 推进 revision + 状态(成功)。
				this.deps.repositoryStore.repositories.updateSyncState({
					repository_id: binding.repository_id,
					sync_status: "synced",
					indexed_revision: newRevision,
					last_indexed_at: syncedAt,
					last_error: null,
				});

				this.stampDirectorySummaries(projectNodeId, projectNodePath);
				this.stampProjectRootSummary(
					projectNodeId, project.name, binding.default_branch, newRevision,
					countActiveFileBindings(this.deps.repositoryStore, binding.repository_id),
					countActiveDirNodes(this.deps.nodeRepo, projectNodeId),
				);

				this.deps.auditRepo.append({
					action: "index.sync",
					nodePath: projectNodePath,
					oldRevision: null,
					newRevision: null,
					detail: {
						projectId, repositoryId: binding.repository_id,
						from: fromRevision, to: newRevision, stats, changesApplied,
					},
					actorAgentId: "wiki-project-indexer",
				});
			});
			void applyResult;
			return {
				projectId,
				repositoryId: binding.repository_id,
				fromRevision,
				toRevision: newRevision,
				syncStatus: "synced",
				stats,
				syncedAt,
				changesApplied,
			};
		} catch (err) {
			// 事务已 rollback。在独立小事务写 failed + last_error(plan-03 §5 失败处理)。
			const errMsg = (err as Error).message ?? String(err);
			this.deps.wikiDb.transaction(() => {
				this.deps.repositoryStore.repositories.updateSyncState({
					repository_id: binding.repository_id,
					sync_status: "failed",
					last_error: errMsg,
					// indexed_revision 不动 —— 保持旧值(§5:failure 不推进 revision)。
				});
				this.deps.auditRepo.append({
					action: "index.sync.failed",
					nodePath: this.projectPathFor(projectId),
					oldRevision: null,
					newRevision: null,
					detail: {
						projectId, repositoryId: binding.repository_id,
						from: fromRevision, attemptedTo: newRevision, error: errMsg,
					},
					actorAgentId: "wiki-project-indexer",
				});
			});
			log.warn("wiki-project-indexer", `sync ${projectId} ${fromRevision?.slice(0,8)}→${newRevision.slice(0,8)} failed: ${errMsg}`);
			return {
				projectId,
				repositoryId: binding.repository_id,
				fromRevision,
				toRevision: fromRevision, // 保持旧值
				syncStatus: "failed",
				stats,
				error: errMsg,
				syncedAt,
				changesApplied: 0,
			};
		}
	}

	/**
	 * 同步到 HEAD 的便捷入口(commit / merge 成功后调用)。
	 * plan-03 §6: Git op success → fetch final SHA → request sync。
	 */
	async syncToHead(projectId: string): Promise<SyncResult> {
		return this.sync(projectId);
	}

	/**
	 * 重建:drop 现有 source-bound 子树 + binding,再走全量索引。
	 * plan-03 §6 rebuild-subtree 路由用。Curated summary/content 会丢失
	 * (rebuild 语义本身如此 —— 与 acceptance C 「显式 full reindex 可从空 project
	 * subtree 重建相同 canonical tree」一致)。
	 */
	async rebuildFromScratch(projectId: string): Promise<IndexResult> {
		const existing = this.deps.repositoryStore.repositories.getByProjectId(projectId);
		if (existing) {
			// 归档整棵 source-bound 子树(保留 audit + 历史)。绑定行也清掉,
			// fullIndex 会重新建。
			this.deps.wikiDb.transaction(() => {
				const projectNodePath = this.projectPathFor(projectId);
				const projectNode = this.deps.nodeRepo.getActiveByPath(projectNodePath);
				if (projectNode) {
					// 归档整棵子树。
					const subtree = this.collectSubtreeRows(projectNode.id);
					for (const row of subtree) {
						if (row.id === projectNode.id) continue; // project root 保留
						this.deps.nodeRepo.archive(row.id);
					}
				}
				// 删 binding + repository 行(CASCADE wiki_source_bindings)。
				this.deps.repositoryStore.repositories.delete(existing.repository_id);
				this.deps.auditRepo.append({
					action: "index.rebuild.preclear",
					nodePath: projectNodePath,
					oldRevision: null,
					newRevision: null,
					detail: { projectId, repositoryId: existing.repository_id },
					actorAgentId: "wiki-project-indexer",
				});
			});
		}
		return this.fullIndex(projectId);
	}

	// =========================================================================
	// Section 6 — Commit/merge orchestration (plan-03 §6)
	// =========================================================================

	/**
	 * Git commit 成功 → 同步 Wiki 到 final SHA。plan-03 §6: 不回滚 Git;
	 * Wiki sync 失败 → 项目显示 stale/failed,可重试到同 SHA。
	 */
	async onGitCommitSuccess(
		projectId: string,
		finalSha: string,
	): Promise<SyncResult> {
		return this.sync(projectId, { targetRevision: finalSha });
	}

	// =========================================================================
	// Internal — diff application (plan-03 §5 失败 atomic + swap two-phase)
	// =========================================================================

	/**
	 * Apply the standardized diff inside an OPEN transaction (caller wraps in
	 * wikiDb.transaction). Throws on any error → caller's transaction rolls back.
	 *
	 * Returns stats + changesApplied. Pure DB writes — Git ops already done.
	 */
	private applyDiffAtomically(input: {
		repositoryId: string;
		projectNodePath: string;
		projectNodeId: number;
		newRevision: string;
		changes: readonly StandardizedChange[];
	}): { stats: SyncResult["stats"]; changesApplied: number } {
		const { repositoryId, projectNodePath, projectNodeId, newRevision, changes } = input;
		const stats: SyncResult["stats"] = {
			added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, typeChanged: 0,
		};
		let changesApplied = 0;

		// ── Pre-pass: rename swap/cycle detection (plan-03 §5 swap/cycle) ──
		// 收集所有 rename 的 (fromPath, toPath)。如果任一 toPath 同时是另一 rename
		// 的 fromPath,必须用两阶段临时路径(否则 UNIQUE(repository, source_path)
		// 在我们处理到一半时 reject)。
		const renames = changes.filter((c): c is Extract<StandardizedChange, { kind: "rename" }> => c.kind === "rename");
		const renameDestPaths = new Set(renames.map((r) => r.toPath));
		const renameSourcePaths = new Set(renames.map((r) => r.fromPath));
		const hasSwap = renames.some((r) => renameSourcePaths.has(r.toPath))
			|| renames.some((r) => renameDestPaths.has(r.fromPath));

		const txId = makeTxId();
		// 收集要先 phase-1 移到临时名的 (binding.node_id, currentSourcePath, currentNodePath):
		// 只有受 swap 影响的 rename 才需要两阶段;非 swap rename 可直接写最终路径。
		if (hasSwap) {
			// Phase 1: 所有 rename 的 from-path 节点先移到 transaction 唯一临时名。
			// 注意:必须先做 phase-1(临时),再做 phase-2(最终)+ 其它 add/modify/delete。
			//
			// 临时改动必须同时改 `path` + `name` —— active sibling UNIQUE 是
			// `(parent_id, name) WHERE archived_at IS NULL`,不含 path。早期实现
			// 只改 path → phase-2 写最终 name 时撞 UNIQUE → transaction rollback
			// (round-1 BLOCKER 3)。临时 name 用 `<txId>+<nodeId>` 保证 transaction
			// 内 + 跨 parent 唯一。
			for (const r of renames) {
				const binding = this.deps.repositoryStore.sourceBindings.getBySourcePath(repositoryId, r.fromPath);
				if (!binding) continue;
				const nodeRow = this.deps.nodeRepo.getById(binding.node_id);
				if (!nodeRow || nodeRow.archived_at !== null) continue;

				const tmpPath = makeSwapTempPath(txId, r.fromPath);
				const tmpName = makeSwapTempName(txId, nodeRow.id);
				const tmpSourcePath = makeSwapTempSource(txId, r.fromPath);
				// 改 path + name(UNIQUE 让位)+ source binding 的 source_path。
				// 不 bump revision(临时移动;phase-2 用 node.revision 走 update 给出
				// 干净的最终 revision bump)。
				this.deps.nodeRepo.updateChildPathAndName(nodeRow.id, tmpPath, tmpName);
				this.deps.repositoryStore.sourceBindings.upsert({
					node_id: binding.node_id,
					repository_id: repositoryId,
					source_path: tmpSourcePath,
					source_kind: binding.source_kind,
					indexed_revision: binding.indexed_revision,
					blob_oid: binding.blob_oid,
				});
			}
		}

		// ── Pass 2: 应用所有 add/modify/delete/rename/typechange/copy 到最终状态 ──
		for (const change of changes) {
			switch (change.kind) {
				case "add":
				case "typechange": {
					// add / typechange: 建 chain + 节点 + binding(typechange 视为 add 新类型)。
					// 幂等:若节点已存在同 source_path 且同 blob_oid → 跳过(不增 noise)。
					const existing = this.deps.repositoryStore.sourceBindings.getBySourcePath(repositoryId, change.path);
					if (existing && existing.blob_oid === change.oid && existing.indexed_revision === newRevision) {
						break; // 幂等
					}
					const parentRow = this.ensureDirChain(projectNodeId, projectNodePath, change.path);
					const fileName = change.path.slice(change.path.lastIndexOf("/") + 1);
					// change.path 可能多段(`config/app.json`)→ joinWikiPathMulti(round-1 BLOCKER 1)。
					const nodePath = joinWikiPathMulti(projectNodePath, change.path);
					const { kind, sourceKind } = classifyByMode(change.mode, fileName, change.path);
					const summary = existing ? undefined : fileSummary(sourceKind, change.mode, fileName, change.path);
					const attributes = fileAttributes(sourceKind, change.mode);

					// 若 binding 已存在(老 type),节点也必存在 —— 复用节点,只改类型。
					if (existing) {
						const existingNode = this.deps.nodeRepo.getById(existing.node_id);
						if (existingNode && existingNode.archived_at === null) {
							// update path / name / kind / binding(blob_oid + revision + source_kind)。
							const newPath = joinWikiPathMulti(projectNodePath, change.path);
							this.deps.nodeRepo.update(existingNode.id, existingNode.revision, {
								parent_id: parentRow.id,
								path: newPath,
								name: fileName,
								kind,
								attributes_json: JSON.stringify(attributes),
							});
							this.deps.repositoryStore.sourceBindings.upsert({
								node_id: existing.node_id,
								repository_id: repositoryId,
								source_path: change.path,
								source_kind: sourceKind,
								indexed_revision: newRevision,
								blob_oid: change.oid,
							});
							changesApplied++;
							if (change.kind === "add") stats.added++;
							else stats.typeChanged++;
							break;
						}
					}

					// 全新节点 —— 走 insert(部分唯一索引允许同 path active 重建)。
					const row = this.upsertSourceFileNode({
						parentId: parentRow.id,
						nodePath,
						name: fileName,
						kind,
						summary: summary ?? "",
						attributesJson: JSON.stringify(attributes),
					});
					this.deps.repositoryStore.sourceBindings.upsert({
						node_id: row.id,
						repository_id: repositoryId,
						source_path: change.path,
						source_kind: sourceKind,
						indexed_revision: newRevision,
						blob_oid: change.oid,
					});
					changesApplied++;
					if (change.kind === "add") stats.added++;
					else stats.typeChanged++;
					break;
				}

				case "modify": {
					// M: 只更新 binding(blob_oid + revision);summary/content/links 不动。
					// attributes.source_stale=true(语义摘要可能过时)。
					const existing = this.deps.repositoryStore.sourceBindings.getBySourcePath(repositoryId, change.path);
					if (!existing) {
						// 文件不在 binding 但 diff 报告 modify —— 可能手动清过 binding。
						// 退化为 add。
						const parentRow = this.ensureDirChain(projectNodeId, projectNodePath, change.path);
						const fileName = change.path.slice(change.path.lastIndexOf("/") + 1);
						// change.path 可能多段(`config/app.json`)→ joinWikiPathMulti(round-1 BLOCKER 1)。
						const nodePath = joinWikiPathMulti(projectNodePath, change.path);
						const { kind, sourceKind } = classifyByMode(change.mode, fileName, change.path);
						const summary = fileSummary(sourceKind, change.mode, fileName, change.path);
						const attributes = fileAttributes(sourceKind, change.mode);
						const row = this.upsertSourceFileNode({
							parentId: parentRow.id, nodePath, name: fileName, kind,
							summary, attributesJson: JSON.stringify(attributes),
						});
						this.deps.repositoryStore.sourceBindings.upsert({
							node_id: row.id, repository_id: repositoryId, source_path: change.path,
							source_kind: sourceKind, indexed_revision: newRevision, blob_oid: change.oid,
						});
						changesApplied++;
						stats.modified++;
						break;
					}
					if (existing.blob_oid === change.oid && existing.indexed_revision === newRevision) {
						break; // 幂等
					}
					this.deps.repositoryStore.sourceBindings.upsert({
						node_id: existing.node_id,
						repository_id: repositoryId,
						source_path: change.path,
						source_kind: existing.source_kind,
						indexed_revision: newRevision,
						blob_oid: change.oid,
					});
					// Mark node's summary as potentially stale(plan-03 §5 + design §6.4)。
					const existingNode = this.deps.nodeRepo.getById(existing.node_id);
					if (existingNode && existingNode.archived_at === null) {
						const attrs = parseAttrs(existingNode.attributes_json);
						attrs.source_stale = true;
						attrs.source_stale_at = new Date().toISOString();
						// 注意:不动 summary/content/links(只改 attributes)。
						this.deps.nodeRepo.update(existingNode.id, existingNode.revision, {
							attributes_json: JSON.stringify(attrs),
						});
					}
					// round-2 review-fix P1 §5.2.3 / §5.3.4:source 文件变了 → 整个
					// project 的 manifest 可能也过时了。若 project root 当前是 ready,
					// 降级为 partial(等 wiki-enrich 重新填字段后再置 ready)。同步事务,
					// 复用 root revision CAS。只在 ready 时降级:pending 不动(本来就
					// 没 ready),partial 不动(已经是部分过时)。首次索引不会进这里
					// (sync 走 fullIndex,fullIndex 直接置 pending)。
					this.demoteManifestIfReady(projectNodeId);
					changesApplied++;
					stats.modified++;
					break;
				}

				case "delete": {
					// D: 归档 source-bound 节点。若同一 diff 内有 rename 把这个 path 当成
					// source,rename 已经把它迁走了 —— 跳过归档(plan-03 §5 末段)。
					if (renameSourcePaths.has(change.path)) {
						break; // 由 rename 处理
					}
					const existing = this.deps.repositoryStore.sourceBindings.getBySourcePath(repositoryId, change.path);
					if (!existing) break; // 幂等:已归档/不存在
					const existingNode = this.deps.nodeRepo.getById(existing.node_id);
					if (!existingNode || existingNode.archived_at !== null) break;
					// 归档整棵子树(虽然文件是叶子,但严格按 §5 「默认归档 source-bound 节点」)。
					const subtree = this.collectSubtreeRows(existingNode.id);
					for (const row of subtree) {
						if (row.archived_at !== null) continue;
						this.deps.nodeRepo.archive(row.id);
					}
					// source_binding 由 node CASCADE 自动删(wiki_source_bindings.node_id
					// ON DELETE CASCADE)。但 archive 不删 node —— 手动删 binding。
					this.deps.repositoryStore.sourceBindings.deleteByNodeId(existingNode.id);
					changesApplied++;
					stats.deleted++;
					break;
				}

				case "rename": {
					// R: 保留节点内部 ID + summary/content/links;改 path + source_path
					// + blob_oid + 后代 path。直接 rename 根 revision+1;后代不动。
					// (plan-03 §5 rename 语义)
					//
					// 注:文件节点是叶子,通常无后代;但 helper 写成通用版,支持目录 rename。
					const existing = this.deps.repositoryStore.sourceBindings.getBySourcePath(
						repositoryId,
						// 若 phase-1 把 source_path 移到了临时名,这里查临时名。
						hasSwap ? makeSwapTempSource(txId, change.fromPath) : change.fromPath,
					);
					if (!existing) {
						// 源 binding 不存在 —— 退化为 add(避免丢文件)。
						const parentRow = this.ensureDirChain(projectNodeId, projectNodePath, change.toPath);
						const fileName = change.toPath.slice(change.toPath.lastIndexOf("/") + 1);
						// change.toPath 可能多段 → joinWikiPathMulti(round-1 BLOCKER 1)。
						const nodePath = joinWikiPathMulti(projectNodePath, change.toPath);
						const { kind, sourceKind } = classifyByMode(change.mode, fileName, change.toPath);
						const summary = fileSummary(sourceKind, change.mode, fileName, change.toPath);
						const attributes = fileAttributes(sourceKind, change.mode);
						const row = this.upsertSourceFileNode({
							parentId: parentRow.id, nodePath, name: fileName, kind,
							summary, attributesJson: JSON.stringify(attributes),
						});
						this.deps.repositoryStore.sourceBindings.upsert({
							node_id: row.id, repository_id: repositoryId, source_path: change.toPath,
							source_kind: sourceKind, indexed_revision: newRevision, blob_oid: change.oid,
						});
						changesApplied++;
						stats.renamed++;
						break;
					}
					const existingNode = this.deps.nodeRepo.getById(existing.node_id);
					if (!existingNode || existingNode.archived_at !== null) break;

					// 查 / 建新 parent 目录链。
					const parentRow = this.ensureDirChain(projectNodeId, projectNodePath, change.toPath);
					const newName = change.toPath.slice(change.toPath.lastIndexOf("/") + 1);
					// change.toPath 可能多段 → joinWikiPathMulti(round-1 BLOCKER 1)。
					const newPath = joinWikiPathMulti(projectNodePath, change.toPath);

					// 计算老 path(可能是临时名)。用于后代 path 重写。
					const oldNodePath = existingNode.path;
					// 根节点 revision+1(plan-03 §5)。
					this.deps.nodeRepo.update(existingNode.id, existingNode.revision, {
						parent_id: parentRow.id,
						path: newPath,
						name: newName,
					});
					// source binding → 新 source_path + blob_oid + revision。
					this.deps.repositoryStore.sourceBindings.upsert({
						node_id: existingNode.id,
						repository_id: repositoryId,
						source_path: change.toPath,
						source_kind: existing.source_kind,
						indexed_revision: newRevision,
						blob_oid: change.oid,
					});

					// 后代 path 重写(文件叶子不会有后代,但通用化处理)。
					if (oldNodePath !== newPath) {
						const descendants = this.collectDescendantRows(existingNode.id, oldNodePath);
						for (const d of descendants) {
							if (!d.path.startsWith(oldNodePath + "/")) continue;
							const suffix = d.path.slice(oldNodePath.length);
							this.deps.nodeRepo.updateChildPathOnly(d.id, newPath + suffix);
						}
					}
					changesApplied++;
					stats.renamed++;
					break;
				}
			}
		}

		// 末尾清理:归档空目录节点(无 active children 的目录,不包含 project root)。
		// 由 Git diff 不直接报目录删除 —— 这里从 file changes 反推。
		this.pruneEmptyDirectories(projectNodeId);

		return { stats, changesApplied };
	}

	// =========================================================================
	// Internal — diff standardization (plan-03 §5 A/M/D/R/C)
	// =========================================================================

	/**
	 * 把 raw diff --name-status entries 标准化:
	 *   - R* → { kind: 'rename', fromPath: path, toPath: newPath }
	 *   - C* → { kind: 'add', path: newPath }(plan-03 §5 copy 按 add 处理)
	 *   - A  → { kind: 'add' }(oid 待 enrich)
	 *   - M  → { kind: 'modify' }
	 *   - D  → { kind: 'delete' }
	 *   - T  → { kind: 'typechange' }
	 *   - 剥离 source_root 前缀;越界 path 返回 null → 整条跳过。
	 *   - U(unmerged) 不应出现在 committed diff;若出现跳过。
	 */
	private standardizeDiffEntries(
		raw: readonly DiffNameStatusEntryLike[],
		sourceRoot: string,
	): StandardizedChange[] {
		const out: StandardizedChange[] = [];
		for (const e of raw) {
			const code = e.status.charAt(0);
			if (code === "U") continue;
			// path / newPath 解析 + source_root 剥离。
			const pathInScope = stripSourceRoot(e.path, sourceRoot);
			if (pathInScope === null) continue;
			if (code === "R") {
				if (!e.newPath) continue;
				const toInScope = stripSourceRoot(e.newPath, sourceRoot);
				if (toInScope === null) continue;
				out.push({
					kind: "rename",
					fromPath: pathInScope,
					toPath: toInScope,
					mode: "", // 待 enrich
					oid: "",
				});
			} else if (code === "C") {
				if (!e.newPath) continue;
				const toInScope = stripSourceRoot(e.newPath, sourceRoot);
				if (toInScope === null) continue;
				out.push({
					kind: "add",
					path: toInScope,
					mode: "", oid: "",
				});
			} else if (code === "A") {
				out.push({ kind: "add", path: pathInScope, mode: "", oid: "" });
			} else if (code === "M") {
				out.push({ kind: "modify", path: pathInScope, mode: "", oid: "" });
			} else if (code === "D") {
				out.push({ kind: "delete", path: pathInScope });
			} else if (code === "T") {
				out.push({ kind: "typechange", path: pathInScope, mode: "", oid: "" });
			}
			// 其它(X / B 等破坏性)忽略 —— committed diff 通常没有。
		}
		return out;
	}

	/**
	 * 给 add/modify/rename/typechange 补 mode + oid(从目标 revision 的 tree 查)。
	 * 单次 ls-tree -r 比多次 cat-file 高效得多。
	 */
	private async enrichChangesWithOid(
		workspaceDir: string,
		revision: string,
		changes: StandardizedChange[],
		_sourceRoot: string,
	): Promise<StandardizedChange[]> {
		// 收集需要 mode+oid 的 path 集合。
		const needLookup = new Set<string>();
		for (const c of changes) {
			if (c.kind === "add" || c.kind === "modify" || c.kind === "rename" || c.kind === "typechange") {
				const p = c.kind === "rename" ? c.toPath : c.path;
				needLookup.add(p);
			}
		}
		if (needLookup.size === 0) return changes;

		// 单次 ls-tree -r 取全部 path 的 mode+oid。比 N 次 cat-file 快。
		const lsEntries = await this.deps.git.listTreeAtRevision(workspaceDir, revision);
		const lookup = new Map<string, { mode: string; oid: string; type: string }>();
		for (const e of lsEntries) lookup.set(e.path, { mode: e.mode, oid: e.oid, type: e.type });

		return changes.map((c) => {
			if (c.kind === "delete") return c;
			const p = c.kind === "rename" ? c.toPath : c.path;
			// lookup 的 key 是仓库相对 path(含 source_root 前缀)。re-hydrate。
			const repoPrefixed = _sourceRoot ? `${_sourceRoot}/${p}` : p;
			const meta = lookup.get(repoPrefixed) ?? lookup.get(p);
			if (!meta) return c; // 找不到 → 保留原(mode="", oid="")→ 后续 add 路径会失败
			return {
				...c,
				mode: meta.mode,
				oid: meta.oid,
			} as StandardizedChange;
		});
	}

	// =========================================================================
	// Internal — node / binding writers
	// =========================================================================

	/**
	 * 创建 / 更新 source-bound 文件节点。同 path active 节点存在 → 复用(更新必要字段);
	 * 不存在 → insert。FTS 同步在 transaction 内完成。
	 */
	private upsertSourceFileNode(input: {
		parentId: number;
		nodePath: string;
		name: string;
		kind: WikiNodeKind;
		summary: string;
		attributesJson: string;
	}): WikiNodeRow {
		const existing = this.deps.nodeRepo.getActiveByPath(input.nodePath);
		if (existing) {
			// 已存在 → 不覆盖 summary/content/links(plan-03 §4「索引器不覆盖 curated 内容」)。
			// 只在 kind/attributes 不同时更新。
			const needsUpdate = existing.kind !== input.kind
				|| existing.parent_id !== input.parentId
				|| existing.attributes_json !== input.attributesJson;
			if (needsUpdate) {
				return this.deps.nodeRepo.update(existing.id, existing.revision, {
					parent_id: input.parentId,
					kind: input.kind,
					attributes_json: input.attributesJson,
				});
			}
			return existing;
		}
		const row = this.deps.nodeRepo.insert({
			parent_id: input.parentId,
			name: input.name,
			path: input.nodePath,
			kind: input.kind,
			summary: input.summary,
			content: "", // 不复制文件正文(plan-03 §4)
			attributes_json: input.attributesJson,
		});
		this.deps.nodeRepo.syncFtsInsert(row.id, row.name, row.summary, row.content);
		return row;
	}

	/** 创建 / 复用 source 目录节点。不写 source_binding(目录无 blob)。 */
	private upsertSourceDirNode(
		parentId: number,
		nodePath: string,
		repoRelativeDir: string,
	): WikiNodeRow {
		const existing = this.deps.nodeRepo.getActiveByPath(nodePath);
		if (existing) return existing;
		const name = repoRelativeDir.slice(repoRelativeDir.lastIndexOf("/") + 1);
		const row = this.deps.nodeRepo.insert({
			parent_id: parentId,
			name,
			path: nodePath,
			kind: "directory",
			summary: "", // 由 stampDirectorySummaries 在末尾 stamp
			content: "",
			attributes_json: null,
		});
		this.deps.nodeRepo.syncFtsInsert(row.id, row.name, row.summary, row.content);
		return row;
	}

	/**
	 * 确保 chain 完整 —— 给 repo 相对 file path 计算所在目录链,返回文件应挂的
	 * 直接父目录节点。空 dir 返回 project root。
	 */
	private ensureDirChain(
		projectNodeId: number,
		projectNodePath: string,
		repoRelativePath: string,
	): WikiNodeRow {
		const slashIdx = repoRelativePath.lastIndexOf("/");
		const parentDir = slashIdx >= 0 ? repoRelativePath.slice(0, slashIdx) : "";
		if (parentDir === "") {
			return this.deps.nodeRepo.getById(projectNodeId)!;
		}
		const segs = parentDir.split("/").filter(Boolean);
		let parentRow = this.deps.nodeRepo.getById(projectNodeId)!;
		let acc = "";
		for (const seg of segs) {
			acc = acc ? `${acc}/${seg}` : seg;
			// acc 可能多段(`src/server`)→ joinWikiPathMulti(round-1 BLOCKER 1)。
			const dirPath = joinWikiPathMulti(projectNodePath, acc);
			let row = this.deps.nodeRepo.getActiveByPath(dirPath);
			if (!row) {
				row = this.upsertSourceDirNode(parentRow.id, dirPath, acc);
			}
			parentRow = row;
		}
		return parentRow;
	}

	/** 给目录节点 stamp 确定性 summary(直接 child 数 + 总后代数)。 */
	private stampDirectorySummaries(projectNodeId: number, projectNodePath: string): void {
		// 只处理 project subtree 内的 directory 节点。
		const escapedPath = projectNodePath.replace(/[%_]/g, (c) => "\\" + c);
		const all = this.deps.nodeRepo.getAllByPathPrefix(escapedPath);
		for (const row of all) {
			if (row.kind !== "directory") continue;
			if (row.archived_at !== null) continue;
			const directChildren = this.deps.nodeRepo.getActiveChildren(row.id);
			const totalDesc = countDescendants(this.deps.nodeRepo, row.id);
			const relDir = row.path === projectNodePath
				? ""
				: row.path.slice(projectNodePath.length + 1);
			const dirSummary = relDir === ""
				? `Project source root: ${directChildren.length} direct children, ${totalDesc} total descendants.`
				: `Directory ${relDir}: ${directChildren.length} direct children, ${totalDesc} total descendants.`;
			// 只在 summary 不同时 update(避免不必要的 revision bump)。
			if (row.summary !== dirSummary) {
				this.deps.nodeRepo.update(row.id, row.revision, { summary: dirSummary });
			}
		}
	}

	/** 给 project root 节点 stamp summary。 */
	private stampProjectRootSummary(
		projectNodeId: number,
		displayName: string,
		branch: string,
		revision: string,
		trackedFiles: number,
		inferredDirs: number,
	): void {
		const projectNode = this.deps.nodeRepo.getById(projectNodeId);
		if (!projectNode) return;
		const shortRev = revision.slice(0, 8);
		const summary = `Project ${displayName}: ${branch}@${shortRev}, ${trackedFiles} tracked files, ${inferredDirs} directories.`;
		if (projectNode.summary !== summary) {
			this.deps.nodeRepo.update(projectNode.id, projectNode.revision, { summary });
		}
	}

	/**
	 * 把 project root 节点的 manifest_status 标成 "pending" + 时间戳(round-2
	 * review-fix P1 §5.2.1)。preserve 已有 attributes(display_name / 老
	 * manifest 字段 / 任意 caller-set attrs)。revision CAS 走 nodeRepo.update。
	 *
	 * 设计取舍:
	 *   - 不删 6 个结构化字段键(goals/stack/...):fullIndex 是结构索引,语义
	 *     字段由 wiki-enrich 维护,fullIndex 不掺合。若 caller 用 rebuildFromScratch
	 *     走完 fullIndex,curated content 已被 archive(那是 rebuild 语义);
	 *     而本字段不主动重置,以便未来 rebuild 策略变更时不会丢字段。
	 *   - manifest_updated_at 总刷新:即便从 pending 再到 pending,语义上是
	 *     「最近一次结构索引」时间戳,有诊断价值。
	 *
	 * 调用方:fullIndex 成功路径(同 transaction)。
	 */
	private seedProjectManifestPending(projectNodeId: number): void {
		const rootRow = this.deps.nodeRepo.getById(projectNodeId);
		if (!rootRow || rootRow.archived_at !== null) return;
		const attrs = parseAttrs(rootRow.attributes_json);
		attrs[MANIFEST_STATUS_ATTR_KEY] = "pending";
		attrs[MANIFEST_UPDATED_AT_ATTR_KEY] = new Date().toISOString();
		this.deps.nodeRepo.update(rootRow.id, rootRow.revision, {
			attributes_json: JSON.stringify(attrs),
		});
	}

	/**
	 * 若 project root 当前 manifest_status === "ready",降级为 "partial" 并刷新
	 * manifest_updated_at(round-2 review-fix P1 §5.2.3 / §5.3.4)。
	 *
	 * 触发场景:Git MODIFY change(indexer 处理 modify 文件时调用)。source 变了,
	 * 已 enrich 的 manifest 字段可能也过时 —— 显式降级让 compiler / UI 提示用户
	 * 重跑 wiki-enrich。Archivist 重新跑 wiki-enrich 后会把 ready 写回。
	 *
	 * 只降 ready → partial;pending / partial 不动(避免无谓 revision bump +
	 * 覆盖 Archivist 已经在做的 enrich)。revision CAS 走 nodeRepo.update。
	 *
	 * 调用方:applyDiffAtomically 的 modify 分支(同 transaction)。
	 */
	private demoteManifestIfReady(projectNodeId: number): void {
		const rootRow = this.deps.nodeRepo.getById(projectNodeId);
		if (!rootRow || rootRow.archived_at !== null) return;
		const attrs = parseAttrs(rootRow.attributes_json);
		if (attrs[MANIFEST_STATUS_ATTR_KEY] !== "ready") return;
		attrs[MANIFEST_STATUS_ATTR_KEY] = "partial";
		attrs[MANIFEST_UPDATED_AT_ATTR_KEY] = new Date().toISOString();
		this.deps.nodeRepo.update(rootRow.id, rootRow.revision, {
			attributes_json: JSON.stringify(attrs),
		});
	}

	/** 归档空目录节点(无 active children 的 directory)。project root 不动。 */
	private pruneEmptyDirectories(projectNodeId: number): void {
		const projectNode = this.deps.nodeRepo.getById(projectNodeId);
		if (!projectNode) return;
		const escapedPath = projectNode.path.replace(/[%_]/g, (c) => "\\" + c);
		const all = this.deps.nodeRepo.getAllByPathPrefix(escapedPath);
		for (const row of all) {
			if (row.id === projectNodeId) continue;
			if (row.kind !== "directory") continue;
			if (row.archived_at !== null) continue;
			const children = this.deps.nodeRepo.getActiveChildren(row.id);
			if (children.length === 0) {
				this.deps.nodeRepo.archive(row.id);
			}
		}
	}

	/** 收集子树(active + archived),含 root。 */
	private collectSubtreeRows(rootId: number): WikiNodeRow[] {
		const root = this.deps.nodeRepo.getById(rootId);
		if (!root) return [];
		const out: WikiNodeRow[] = [root];
		const escaped = root.path.replace(/[%_]/g, (c) => "\\" + c);
		for (const r of this.deps.nodeRepo.getAllByPathPrefix(escaped)) {
			if (r.id === rootId) continue;
			out.push(r);
		}
		return out;
	}

	/** 收集严格后代(active + archived),不含 root。按 path LIKE。 */
	private collectDescendantRows(rootId: number, rootPath: string): WikiNodeRow[] {
		const escaped = rootPath.replace(/[%_]/g, (c) => "\\" + c);
		const all = this.deps.nodeRepo.getAllByPathPrefix(escaped);
		return all.filter((r) => r.id !== rootId);
	}

	/** 创建(幂等)project root 节点。 */
	private ensureProjectRootNode(projectId: string, displayName: string): void {
		const projectNodePath = this.projectPathFor(projectId);
		const existing = this.deps.nodeRepo.getActiveByPath(projectNodePath);
		if (existing) {
			// Project rename 不移动镜像子树(plan-03 §2):只更新 display_name。
			const attrs = parseAttrs(existing.attributes_json);
			if (attrs.display_name !== displayName) {
				const nextAttrs = { ...attrs, display_name: displayName };
				this.deps.nodeRepo.update(existing.id, existing.revision, {
					attributes_json: JSON.stringify(nextAttrs),
				});
			}
			return;
		}
		// 父节点 wiki-root/projects 必须存在(WikiDatabase bootstrapFixedRoots 已建)。
		const parentPath = PROJECTS_NAMESPACE_PATH;
		const parent = this.deps.nodeRepo.getActiveByPath(parentPath);
		if (!parent) {
			throw new Error(`ensureProjectRootNode: missing namespace root ${parentPath}`);
		}
		const row = this.deps.nodeRepo.insert({
			parent_id: parent.id,
			name: projectId,
			path: projectNodePath,
			kind: "project",
			summary: `Project ${displayName}.`,
			content: "",
			attributes_json: JSON.stringify({ display_name: displayName }),
		});
		this.deps.nodeRepo.syncFtsInsert(row.id, row.name, row.summary, row.content);
	}

	/** project root 节点 id(按 path 查)。不存在返回 null。 */
	private lookupProjectNodeId(projectNodePath: string): number | null {
		const row = this.deps.nodeRepo.getActiveByPath(projectNodePath);
		return row ? row.id : null;
	}

	/** `wiki-root/projects/<projectId>` 规范路径。 */
	private projectPathFor(projectId: string): string {
		// projectId 由 ProjectStore 生成,与 validateWikiName 兼容(slugified)。
		// 若 projectId 含非法字符,这里抛出 —— 不静默跳过。
		validateWikiName(projectId);
		return joinWikiPath(PROJECTS_NAMESPACE_PATH, projectId);
	}

	// =========================================================================
	// Internal — failure helpers
	// =========================================================================

	private bindingFailure(
		projectId: string,
		repositoryId: string,
		sourceRoot: string,
		error: string,
	): BindingResult {
		return {
			projectId,
			repositoryId,
			projectNodePath: "",
			sourceRoot,
			defaultBranch: DEFAULT_BRANCH_FALLBACK,
			bound: false,
			alreadyExists: false,
			error,
		};
	}

	private indexFailure(
		projectId: string,
		repositoryId: string,
		indexedRevision: string,
		trackedFiles: number,
		inferredDirs: number,
		nodesAffected: number,
		error: string,
	): IndexResult {
		return {
			projectId, repositoryId, indexedRevision,
			defaultBranch: DEFAULT_BRANCH_FALLBACK,
			trackedFiles, inferredDirs, nodesAffected,
			ok: false, error, indexedAt: new Date().toISOString(),
		};
	}

	private syncFailure(
		projectId: string,
		binding: WikiRepositoryRow,
		error: string,
		stats: SyncResult["stats"],
	): SyncResult {
		return {
			projectId,
			repositoryId: binding.repository_id,
			fromRevision: binding.indexed_revision,
			toRevision: binding.indexed_revision,
			syncStatus: "failed",
			stats,
			error,
			syncedAt: new Date().toISOString(),
			changesApplied: 0,
		};
	}
}

// ---------------------------------------------------------------------------
// Free helpers — classification, summaries, source_root utilities
// ---------------------------------------------------------------------------

/**
 * 按 Git mode + 文件名 + 仓库相对 path 推导 Wiki kind + source_kind。
 * plan-03 §3 Git mode handling。
 *
 * - `120000` symlink → kind=source_symlink, source_kind=symlink
 * - `160000` gitlink (submodule) → kind=source_submodule, source_kind=submodule
 * - `100755` executable blob → kind=source_file, source_kind=executable_<ext>
 * - `100644` regular blob → kind=source_file, source_kind by ext/position:
 *   test/document/config/asset/source_file
 */
export function classifyByMode(
	mode: string,
	fileName: string,
	repoRelativePath: string,
): { kind: WikiNodeKind; sourceKind: string } {
	if (mode === "120000") return { kind: "source_symlink", sourceKind: "symlink" };
	if (mode === "160000") return { kind: "source_submodule", sourceKind: "submodule" };
	// Regular / executable blob。
	const ext = extOf(fileName).toLowerCase();
	const lower = repoRelativePath.toLowerCase();
	const baseName = fileName.toLowerCase();

	// Order matters: TEST first(wins over generic source).
	if (TEST_EXTS.has(ext)) return sourceKindOf(mode, "test", ext);
	for (const pat of TEST_FILENAME_PATTERNS) {
		if (pat.test(fileName)) return sourceKindOf(mode, "test", ext);
	}
	if (TEST_PATH_HINTS.some((h) => lower.includes(h))) return sourceKindOf(mode, "test", ext);

	if (CONFIG_FILENAMES.has(baseName)) return sourceKindOf(mode, "config", ext);
	if (CONFIG_EXTS.has(ext)) return sourceKindOf(mode, "config", ext);
	if (DOC_EXTS.has(ext)) return sourceKindOf(mode, "document", ext);
	if (ASSET_EXTS.has(ext)) return sourceKindOf(mode, "asset", ext);

	return sourceKindOf(mode, "source_file", ext);
}

function sourceKindOf(mode: string, base: string, ext: string): { kind: WikiNodeKind; sourceKind: string } {
	const kind: WikiNodeKind = "source_file";
	if (mode === "100755") {
		return { kind, sourceKind: base === "source_file" ? `executable_${ext || "noext"}` : `executable_${base}` };
	}
	return { kind, sourceKind: base };
}

function extOf(fileName: string): string {
	const i = fileName.lastIndexOf(".");
	return i >= 0 ? fileName.slice(i) : "";
}

/**
 * 文件节点确定性初始 summary(plan-03 §4)。**不**含文件正文。
 * 格式:`<source_kind> (<ext>) — <repoRelativePath>`
 */
function fileSummary(
	sourceKind: string,
	mode: string,
	fileName: string,
	repoRelativePath: string,
): string {
	const ext = extOf(fileName) || "noext";
	if (mode === "120000") return `symlink — ${repoRelativePath}`;
	if (mode === "160000") return `submodule — ${repoRelativePath}`;
	return `${sourceKind} (${ext}) — ${repoRelativePath}`;
}

/** 文件节点 attributes(source_kind + executable / symlink 标记)。 */
function fileAttributes(sourceKind: string, mode: string): Record<string, unknown> {
	const attrs: Record<string, unknown> = { source_kind: sourceKind };
	if (mode === "100755") attrs.executable = true;
	if (mode === "120000") attrs.is_symlink = true;
	if (mode === "160000") attrs.is_submodule = true;
	return attrs;
}

/**
 * 规范化 source_root:trim、统一 `/` 分隔、去除 `./`、空 / "." / "/" 视为 ""。
 * 调用方仍需校验 `..` / 绝对路径(ensureBinding 已做)。
 */
function normalizeSourceRoot(input: string): string {
	const trimmed = (input ?? "").trim();
	if (!trimmed || trimmed === "." || trimmed === "/" || trimmed === "./") return "";
	// 去除前后 `/` 与 `./`。
	const stripped = trimmed.replace(/^\.?\/+/, "").replace(/\/+$/, "");
	return stripped.split(/[\\/]+/).join("/");
}

/**
 * 剥离 source_root 前缀。返回仓库相对 path(不含 source_root 前缀)。
 * path 在 source_root 外(不在其子树下)→ 返回 null(调用方跳过)。
 *
 * 严格段基匹配:source_root=`foo` 时,`foo/bar` → `bar`,`foobar/baz` → null。
 */
function stripSourceRoot(repoPath: string, sourceRoot: string): string | null {
	if (!sourceRoot) return repoPath;
	const rootSegs = sourceRoot.split("/").filter(Boolean);
	const pathSegs = repoPath.split("/").filter(Boolean);
	if (pathSegs.length < rootSegs.length) return null;
	for (let i = 0; i < rootSegs.length; i++) {
		if (pathSegs[i] !== rootSegs[i]) return null;
	}
	return pathSegs.slice(rootSegs.length).join("/");
}

/** 安全 JSON parse attributes(失败 → 空对象)。 */
function parseAttrs(json: string | null): Record<string, unknown> {
	if (!json) return {};
	try {
		const parsed = JSON.parse(json);
		return (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** 统计 repository 下 active file bindings 数量。 */
function countActiveFileBindings(
	store: WikiRepositoryStore,
	repositoryId: string,
): number {
	return store.sourceBindings.listByRepository(repositoryId).length;
}

/** 统计 projectNodeId 子树下 active directory 节点数量。 */
function countActiveDirNodes(
	repo: WikiNodeRepository,
	projectNodeId: number,
): number {
	const projectNode = repo.getById(projectNodeId);
	if (!projectNode) return 0;
	const escaped = projectNode.path.replace(/[%_]/g, (c) => "\\" + c);
	return repo.getAllByPathPrefix(escaped).filter(
		(r) => r.kind === "directory" && r.archived_at === null,
	).length;
}

/** BFS 统计后代总数(active only)。 */
function countDescendants(repo: WikiNodeRepository, rootId: number): number {
	let count = 0;
	const queue: number[] = [rootId];
	while (queue.length > 0) {
		const id = queue.shift()!;
		const children = repo.getActiveChildren(id);
		count += children.length;
		for (const c of children) queue.push(c.id);
	}
	return count;
}

/** Repository ID 派生自 projectId(稳定,便于幂等)。 */
function makeRepositoryId(projectId: string): string {
	// 保持简单:同 projectId → 同 repositoryId。
	return `repo-${projectId}`;
}

/** Transaction 唯一 ID,用于 swap 临时路径。 */
function makeTxId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 临时 wiki path 段(用于 swap phase-1)。 */
function makeSwapTempPath(txId: string, originalRepoPath: string): string {
	// 挂在 `wiki-root/__swap_tmp_<txId>/...` 下 —— 此 path 不在任何 project subtree,
	// 永不与真实路径冲突;transaction 成功后 phase-2 会把它写为最终路径。
	const safeTx = txId.replace(/[^a-z0-9-]/gi, "-");
	const segs = originalRepoPath.split("/").filter(Boolean);
	return ["wiki-root", `__swap_tmp_${safeTx}`, ...segs].join("/");
}

/**
 * 临时 name(单段,validateWikiName 合法)用于 swap phase-1。
 *
 * 必须改 name,不能只改 path:active sibling UNIQUE 是 `(parent_id, name) WHERE
 * archived_at IS NULL`,不含 path。phase-1 若只改 path,phase-2 写最终 name 时
 * 撞 UNIQUE(round-1 BLOCKER 3)。`<txId>+<nodeId>` 保证 transaction 内唯一 +
 * 跨 parent 不冲突(node_id 全局唯一)。
 */
function makeSwapTempName(txId: string, nodeId: number): string {
	const safeTx = txId.replace(/[^a-z0-9-]/gi, "-");
	return `__swap_tmp_${safeTx}_n${nodeId}`;
}

/** 临时 source_path,用于 swap phase-1。 */
function makeSwapTempSource(txId: string, originalSourcePath: string): string {
	const safeTx = txId.replace(/[^a-z0-9-]/gi, "-");
	const segs = originalSourcePath.split("/").filter(Boolean);
	return [`__swap_tmp_${safeTx}`, ...segs].join("/");
}
