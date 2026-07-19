// WikiSkeletonService — Archivist 项目编排器(Git + Indexer)
//
// # 文件说明书
//
// ## 核心职责
// PM/archivist REST 路由的高层编排入口:把"commit 需求文档 / 合并 feature /
// 重建 wiki / rescan"等用例协调成 ArchivistGit 操作 + WikiProjectIndexer 同步,
// 并把新 indexer 的结果形状(SyncResult / IndexResult)翻译成调用方期望的
// 旧 `ScanResult` 形状。本类**保留**是因为这份编排本身有价值:Git 成功而
// Wiki 同步失败时不回滚 Git(项目显示 stale/failed),这套语义在此处落地。
//
// ## 历史命名
// 类名沿用了 readdir 时代的 `WikiSkeletonService`。v0.8 plan-03 之后它已不再
// 是 "skeleton/readdir shim" —— 旧的目录扫描职责被迁到
// `src/server/wiki/wiki-project-indexer.ts`,旧的 lazy summary / divergence
// / walkWorkspace / projectSubtreeRootId 等 vestigial API 在 P1-6 已删除。
// 重命名会牵动 3 个生产 import + 多个测试断言,成本高于收益,故保留类名;
// 读这段注释时请把它理解为"Archivist Project Orchestrator"。
//
// ## 保留的编排方法(均有真实调用方 — archivist REST 路由)
//   - `buildSkeleton` → `indexer.syncToHead(projectId)`(增量到 HEAD)
//   - `rescanProjectFull` → `indexer.fullIndex(projectId)`(全量)
//   - `rebuildProjectSubtree` → `indexer.rebuildFromScratch(projectId)`(wipe + 重建)
//   - `commitRequirementDoc` → `git.commitRequirementDoc` → `indexer.onGitCommitSuccess(sha)`
//   - `mergeFeatureToMain` → `git.mergeFeatureToMain` → `indexer.onGitCommitSuccess(mergedToRef)`
//   - `cleanupWorktree` → `git.cleanupWorktree`(不触发 wiki sync)
//
// ## 关键不变量
//   - 本类**不**直接读旧 `project_wiki`(plan-00 已停用)。
//   - 本类**不**直接调 WikiStore/wiki-node-store(plan-03 不写 legacy 树)。
//   - 本类**不**持有 wiki_scan_cursor_store(已删除)。
//   - 所有结构写都通过 WikiProjectIndexer → wiki.db(独立数据库)。
//   - Git ops 委托 ArchivistGit;返回 final SHA 后调 indexer.onGitCommitSuccess。
//
// ## 已删除的 vestigial API(P1-6 cutover)
//   - `ensureSummary(nodeId)` — readdir 时代的 lazy summary,plan-03 索引器在
//     扫描时已写确定性 summary;返回 undefined 的 stub 已删除。
//   - `detectDivergence(projectId)` — legacy RFC §2.16 概念,plan-03 不实现;
//     archivist REST 路由 `/api/archivist/:projectId/divergence` 直接返回
//     501 NOT_IMPLEMENTED,不再有 false-success 空 report。
//   - `projectSubtreeRootId(projectId)` / `walkWorkspace(...)` — 旧 readdir
//     fallback helper,无调用方,已删除。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-03-project-git-mirror.md §6
//   - src/server/wiki/wiki-project-indexer.ts(新 indexer)

import type { WikiProjectIndexer, IndexResult, SyncResult } from "./wiki/wiki-project-indexer.js";
import type { ArchivistGit } from "./archivist-git.js";
import type { ProjectStore } from "./project-store.js";
import type { RequirementStore } from "./requirement-store.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Public types(向后兼容 —— 旧 callers 看到的形状不变)
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

// ---------------------------------------------------------------------------
// WikiSkeletonService — Archivist 项目编排器
// ---------------------------------------------------------------------------

/**
 * 依赖。注意:`wikiStore` / `cursorStore` 字段已删除(plan-03 重构)。仍保留
 * `requirementStore` 是为了 API 兼容(构造签名),但本类不再使用它。
 */
export interface WikiSkeletonServiceDeps {
	/** 新 indexer(plan-03 实际写路径)。 */
	indexer: WikiProjectIndexer;
	/** Git ops 委托对象。 */
	git: ArchivistGit;
	/** ProjectStore(workspaceDir lookup)。 */
	projectStore: ProjectStore;
	/** 保留用于构造签名兼容(plan-03 不再使用)。 */
	requirementStore?: RequirementStore;
	/** 保留 archivistId 字段用于 audit 上下文兼容(实际 indexer 用自身 actor)。 */
	archivistId?: string;
}

export class WikiSkeletonService {
	private readonly deps: WikiSkeletonServiceDeps;

	constructor(deps: WikiSkeletonServiceDeps) {
		this.deps = deps;
	}

	// ─── 扫描入口(全部委托 indexer)──────────────────────────────────

	/**
	 * 增量扫描:同步 wiki 到 HEAD(plan-03 §6: commit/merge 成功后调用)。
	 * 旧语义保留:返回 ScanResult 形状,内部从 SyncResult 转。
	 */
	async buildSkeleton(projectId: string): Promise<ScanResult> {
		try {
			const r = await this.deps.indexer.syncToHead(projectId);
			return syncToScanResult(r);
		} catch (err) {
			log.warn("wiki-skeleton", `buildSkeleton ${projectId} failed: ${(err as Error).message}`);
			return emptyScanResult(projectId, (err as Error).message);
		}
	}

	/**
	 * 全量 rescan(周期 drift 兜底)。
	 */
	async rescanProjectFull(projectId: string): Promise<ScanResult> {
		try {
			const r = await this.deps.indexer.fullIndex(projectId);
			return indexToScanResult(r);
		} catch (err) {
			log.warn("wiki-skeleton", `rescanProjectFull ${projectId} failed: ${(err as Error).message}`);
			return emptyScanResult(projectId, (err as Error).message);
		}
	}

	/**
	 * 干净重建:drop 子树 + 全量索引。
	 */
	async rebuildProjectSubtree(projectId: string): Promise<ScanResult> {
		try {
			const r = await this.deps.indexer.rebuildFromScratch(projectId);
			return indexToScanResult(r);
		} catch (err) {
			log.warn("wiki-skeleton", `rebuildProjectSubtree ${projectId} failed: ${(err as Error).message}`);
			return emptyScanResult(projectId, (err as Error).message);
		}
	}

	// ─── Git 管理(RFC §2.15 → plan-03 §6)─────────────────────────────

	/**
	 * Commit PM 写的需求文档到 main,然后 sync wiki 到 final SHA。
	 * plan-03 §6: Git 成功、Wiki 失败时不回滚 Git;项目显示 stale/failed。
	 */
	async commitRequirementDoc(
		projectId: string,
		requirementId: string,
		title: string,
		docPaths: string[],
	): Promise<{ ok: boolean; ref?: string; error?: string; sync?: SyncResult }> {
		const project = this.deps.projectStore.get(projectId);
		if (!project) return { ok: false, error: "project not found" };
		await this.deps.git.ensureRepo(project.workspaceDir);
		const r = await this.deps.git.commitRequirementDoc(
			project.workspaceDir, requirementId, title, docPaths,
		);
		if (!r.ok || !r.ref) return r;
		// commit 成功 → 同步 Wiki 到 final SHA。失败不回滚 Git(plan-03 §6)。
		let sync: SyncResult | undefined;
		try {
			sync = await this.deps.indexer.onGitCommitSuccess(projectId, r.ref);
		} catch (err) {
			log.warn("wiki-skeleton", `post-commit sync ${projectId} failed: ${(err as Error).message}`);
		}
		return { ...r, sync };
	}

	/**
	 * Verify accept 后把 feature 合并回 main,然后 sync wiki 到 mergedToRef。
	 */
	async mergeFeatureToMain(
		projectId: string,
		requirementId: string,
	): Promise<{ ok: boolean; mergedToRef?: string; conflicts?: string[]; error?: string; sync?: SyncResult }> {
		const project = this.deps.projectStore.get(projectId);
		if (!project) return { ok: false, error: "project not found" };
		await this.deps.git.ensureRepo(project.workspaceDir);
		const r = await this.deps.git.mergeFeatureToMain(
			project.workspaceDir, requirementId, projectId,
		);
		if (!r.ok || !r.mergedToRef) return r;
		let sync: SyncResult | undefined;
		try {
			sync = await this.deps.indexer.onGitCommitSuccess(projectId, r.mergedToRef);
		} catch (err) {
			log.warn("wiki-skeleton", `post-merge sync ${projectId} failed: ${(err as Error).message}`);
		}
		return { ...r, sync };
	}

	/**
	 * 清理 feature worktree。不触发 wiki sync(worktree 不是 main 改动)。
	 */
	async cleanupWorktree(projectId: string, requirementId: string): Promise<void> {
		const project = this.deps.projectStore.get(projectId);
		if (!project) return;
		await this.deps.git.cleanupWorktree(project.workspaceDir, requirementId, projectId);
	}
}

// ---------------------------------------------------------------------------
// Helpers — result shape conversion
// ---------------------------------------------------------------------------

function emptyScanResult(projectId: string, note: string): ScanResult {
	return {
		projectId, scannedRef: "", isInitial: false,
		filesScanned: 0, nodesUpserted: 0, flagsRaised: 0,
		notes: [note],
	};
}

function syncToScanResult(r: SyncResult): ScanResult {
	return {
		projectId: r.projectId,
		scannedRef: r.toRevision ?? "",
		isInitial: r.fromRevision === null,
		filesScanned: r.stats.added + r.stats.modified + r.stats.renamed + r.stats.copied,
		nodesUpserted: r.changesApplied,
		flagsRaised: 0,
		notes: r.error ? [`sync failed: ${r.error}`] : (r.changesApplied === 0 ? ["no changes"] : []),
	};
}

function indexToScanResult(r: IndexResult): ScanResult {
	return {
		projectId: r.projectId,
		scannedRef: r.indexedRevision,
		isInitial: true,
		filesScanned: r.trackedFiles,
		nodesUpserted: r.nodesAffected || r.trackedFiles + r.inferredDirs,
		flagsRaised: 0,
		notes: r.ok
			? [`full index: ${r.trackedFiles} files, ${r.inferredDirs} dirs`]
			: [`full index failed: ${r.error ?? "unknown"}`],
	};
}
