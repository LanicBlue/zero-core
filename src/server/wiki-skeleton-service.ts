// WikiSkeletonService — 兼容 shim(委托给 WikiProjectIndexer)
//
// v0.8 plan-03 重构:本类的扫描职责已迁移到 `src/server/wiki/wiki-project-indexer.ts`。
// 旧的 readdir 扫描 + `header:/intent:/structure:` provenance + 磁盘 cursor
// (wiki_scan_cursors)全部移除。本文件保留为 **委托 shim**:
//
//   - 旧调用方(management-service.createProject / archivist REST 路由 / wiki-router
//     ensureSummary)无需改 API —— 它们看到的还是 WikiSkeletonService。
//   - 实际写路径全部走 WikiProjectIndexer(plan-03 §6 acceptance C「旧
//     WikiSkeletonService 不存在可达写路径」)。
//
// # 文件说明书
//
// ## 核心功能
// 把旧 API(buildSkeleton / rescanProjectFull / rebuildProjectSubtree /
// commitRequirementDoc / mergeFeatureToMain / cleanupWorktree / ensureSummary /
// detectDivergence)映射到新 indexer 接口 + ArchivistGit:
//
//   - `buildSkeleton` → `indexer.sync(projectId)`(增量到 HEAD)
//   - `rescanProjectFull` → `indexer.fullIndex(projectId)`(全量)
//   - `rebuildProjectSubtree` → `indexer.rebuildFromScratch(projectId)`(wipe + 重建)
//   - `commitRequirementDoc` → `git.commitRequirementDoc` → `indexer.onGitCommitSuccess(sha)`
//   - `mergeFeatureToMain` → `git.mergeFeatureToMain` → `indexer.onGitCommitSuccess(mergedToRef)`
//   - `cleanupWorktree` → `git.cleanupWorktree`(不触发 wiki sync)
//   - `ensureSummary` → 返回现有 summary(索引器在扫描时已写确定性 summary;
//     不再 lazy read 工作区文件 —— 那个机制属于 readdir 时代,违反 §G)
//   - `detectDivergence` → 返回空 report(legacy RFC §2.16 概念,plan-03 不实现)
//
// ## 关键不变量
//   - 本类**不**直接读旧 `project_wiki`(plan-00 已停用)。
//   - 本类**不**直接调 WikiStore/wiki-node-store(plan-03 不写 legacy 树)。
//   - 本类**不**持有 wiki_scan_cursor_store(已删除)。
//   - 所有结构写都通过 WikiProjectIndexer → wiki.db(独立数据库)。
//   - Git ops 委托 ArchivistGit;返回 final SHA 后调 indexer.onGitCommitSuccess。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-03-project-git-mirror.md §6
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

export interface DivergenceReport {
	projectId: string;
	unimplementedRequirements: Array<{ requirementId: string; title: string; intentNodeId: string }>;
	uncoveredCode: Array<{ nodeId: string; path: string; docPointer: string }>;
}

// ---------------------------------------------------------------------------
// WikiSkeletonService(委托 shim)
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

	// ─── 兼容 API(plan-03 后已无操作)─────────────────────────────────

	/**
	 * 旧 lazy summary materialization 已移除:plan-03 索引器在扫描时已写
	 * 确定性 summary;expand/read 路径直接读 wiki_nodes.summary。
	 * 本方法保留以维持 wiki-router 调用面 —— 直接返回 undefined,让 router
	 * fallback 到节点的现有 summary。
	 */
	ensureSummary(_nodeId: string): string | undefined {
		return undefined;
	}

	/**
	 * Legacy 意图↔结构分歧检测(RFC §2.16)。plan-03 不实现 —— 返回空 report。
	 * 旧调用方按 empty report 处理(不抛错,保持 API 兼容)。
	 */
	async detectDivergence(projectId: string): Promise<DivergenceReport> {
		return {
			projectId,
			unimplementedRequirements: [],
			uncoveredCode: [],
		};
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

// ---------------------------------------------------------------------------
// Legacy exports —— 保留以避免 import 路径破坏(无实际语义)
// ---------------------------------------------------------------------------

/**
 * @deprecated plan-03 重构后无意义 —— 索引器使用 `wiki-root/projects/<projectId>`
 * 规范路径;不再需要合成 root ID。仅为向后兼容 re-export。
 */
export function projectSubtreeRootId(projectId: string): string {
	return `project:${projectId}`;
}

/**
 * @deprecated readdir-based fallback —— plan-03 §G 明确禁止用文件系统扫描
 * 替代 Git tree。保留空 stub 仅为链接兼容;不再实现。
 */
export function walkWorkspace(_rootDir: string, _accumulator: string[] = [], _prefix = ""): string[] {
	return [];
}
