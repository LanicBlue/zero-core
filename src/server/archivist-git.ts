// Archivist Git 管理 (v0.8 M2)
//
// # 文件说明书
//
// ## 核心功能
// archivist 管 main 分支 git 的操作集合(RFC §2.15):
//   - ensureRepo:非 repo 自动 `git init`(workspace 必须 git repo)
//   - commitRequirementDoc:统一 commit PM 写的需求文档到 main(PM 不碰 git)
//   - getCurrentMainRef:读 main 分支当前 commit sha(扫描游标用)
//   - changesSince:跑 `git log/diff <last>..main` 给 archivist 增量重读
//   - mergeFeatureToMain:verify accept 后把 feature 合并回 main + 清理 worktree
//   - cleanupWorktree:清理 feature worktree 目录
//
// 所有方法安全失败:git 不可用时返回安全默认值,不抛异常。archivist 自己的
// wiki 产出在数据库,不经 git(决策 27 N1)。
//
// ## 输入
// - workspaceDir(project workspace 路径)
// - requirementId / 标题 / 文件路径
//
// ## 输出
// - 操作结果(成功/失败 + 简短信息)
//
// ## 定位
// 服务层 git 工具,被 archivist-service 使用。与 lead-service 用的
// git-integration.ts(GitIntegration)分开 —— 后者是 lead 管 feature 分支的;
// 本类只管 main,符合「按分支划分 git 责任」(决策 27)。
//
// ## 依赖
// - child_process (exec)
// - ../core/logger
//
// ## 维护规则
// - NEVER throw — 全部方法返回安全默认值
// - 所有 shell 操作必须带 timeout
// - 只动 main 分支 + worktree 清理;feature 分支 WIP 不进 wiki(决策 26)
//

import { exec } from "child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../core/logger.js";
import { ZERO_CORE_DIR } from "../core/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function execAsync(cmd: string, options: { cwd: string; timeout?: number }): Promise<string> {
	return new Promise((resolve, reject) => {
		exec(
			cmd,
			{ cwd: options.cwd, timeout: options.timeout ?? 15000, encoding: "utf-8" },
			(err, stdout, stderr) => {
				if (err) return reject(err);
				resolve(stdout);
			},
		);
	});
}

function shortId(id: string): string {
	return id.substring(0, 8);
}

/**
 * Slugify a project id/name into a filesystem-safe folder segment. Mirrors
 * git-integration.slugify so the lead (createFeatureWorktree) and archivist
 * (mergeFeatureToMain / cleanupWorktree) compute the SAME central path.
 */
function projectSlug(projectId: string): string {
	return (projectId ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.substring(0, 40) || "project";
}

/**
 * project-flow §4.2: feature worktrees live under a CENTRAL root, not beside
 * the workspace (`{workspace}.worktrees/...` was the old convention — prone to
 * accidental edits + scattered cleanup). New convention:
 *   `{ZERO_CORE_DIR}/projects/{projectSlug}/{req-shortId}/`
 * `workspaceDir` is kept for back-compat with in-flight worktrees created
 * before centralization: if the central path does not exist but the legacy
 * `{workspaceDir}.worktrees/req-{shortId}` does, the legacy path is returned
 * so an in-flight requirement keeps its worktree through verify→merge.
 */
export function featureWorktreePath(
	workspaceDir: string,
	requirementId: string,
	projectId?: string,
): string {
	const sid = shortId(requirementId);
	if (projectId) {
		const central = join(ZERO_CORE_DIR, "projects", projectSlug(projectId), `req-${sid}`);
		if (existsSync(central)) return central;
		// Fall through to legacy if the central dir isn't there yet (e.g. an
		// in-flight requirement whose worktree was created under the old path).
	}
	const legacy = join(workspaceDir + ".worktrees", `req-${sid}`);
	return legacy;
}

/**
 * project-flow §4.2: the CENTRAL feature worktree path for a requirement.
 * Use this when creating a NEW worktree (lead / Flow.plan) so it lands under
 * `~/.zero-core/projects/{project}/{req-shortId}/`. `featureWorktreePath`
 * above resolves to the central path when it already exists; this helper is
 * the authoritative creator-side path (no legacy fallback).
 */
export function centralFeatureWorktreePath(projectId: string, requirementId: string): string {
	return join(ZERO_CORE_DIR, "projects", projectSlug(projectId), `req-${shortId(requirementId)}`);
}

/** Convention: feature branch name for a requirement (RFC §2.15). */
export function featureBranchName(requirementId: string): string {
	return `req-${shortId(requirementId)}`;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GitChangeSet {
	/** main commit sha at the time of this change set (the new lastScannedRef). */
	ref: string;
	/** Files changed between the previous cursor and this ref (name-only). */
	files: string[];
	/** Commit subjects in the range (one per line). */
	commitLog: string;
	/** True if this is the initial scan (no previous cursor). */
	isInitial: boolean;
}

export interface MergeResult {
	ok: boolean;
	mergedToRef?: string;
	conflicts?: string[];
	error?: string;
}

// ---------------------------------------------------------------------------
// ArchivistGit
// ---------------------------------------------------------------------------

export class ArchivistGit {
	/** True if workspaceDir is inside a git repo. */
	async isRepo(workspaceDir: string): Promise<boolean> {
		try {
			await execAsync("git rev-parse --is-inside-work-tree", { cwd: workspaceDir });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Ensure workspaceDir is a git repo. If not, `git init` it. RFC §2.15:
	 * "workspace 必须是 git repo:非 repo 时 archivist 自动 git init".
	 */
	async ensureRepo(workspaceDir: string): Promise<void> {
		if (await this.isRepo(workspaceDir)) return;
		try {
			await execAsync("git init -b main", { cwd: workspaceDir });
			// Initial commit so main exists (allows subsequent diff/log).
			try {
				await execAsync("git add -A", { cwd: workspaceDir });
				await execAsync('git commit -m "chore: initialize workspace (archivist)" --allow-empty', {
					cwd: workspaceDir,
				});
			} catch (err) {
				// Empty workspace or no git identity — main branch may not have a
				// commit yet; that's OK, getCurrentMainRef will return undefined.
				log.debug("archivist-git", `initial commit skipped: ${(err as Error).message}`);
			}
			log.agent("Archivist: initialized git repo at " + workspaceDir);
		} catch (err) {
			log.error("archivist-git", `git init failed: ${(err as Error).message}`);
		}
	}

	/** Read main's current HEAD commit sha. Returns undefined if no commits yet. */
	async getCurrentMainRef(workspaceDir: string): Promise<string | undefined> {
		try {
			const out = await execAsync("git rev-parse --verify HEAD", { cwd: workspaceDir });
			return out.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Compute the change set between the previous scan cursor (lastScannedRef)
	 * and main's current HEAD. RFC §2.13 / §2.15:
	 *   - merge-driven: feature→main merge advances main → archivist re-reads.
	 *   - feature WIP never appears here (it lives on feature branches).
	 *
	 * Returns isInitial=true when there is no previous cursor (first scan).
	 */
	async changesSince(
		workspaceDir: string,
		lastScannedRef: string | undefined,
	): Promise<GitChangeSet> {
		const ref = await this.getCurrentMainRef(workspaceDir);

		// No commits yet — empty repo state.
		if (!ref) {
			return { ref: "", files: [], commitLog: "", isInitial: !lastScannedRef };
		}

		// Initial scan — caller (archivist-service) decides whether to do a
		// full scan; here we still surface the current HEAD + all tracked files
		// as the "change set" so the first scan has something to chew on.
		if (!lastScannedRef) {
			const files = await this.listTrackedFiles(workspaceDir);
			const commitLog = await this.safeLog(workspaceDir, "-n", "50");
			return { ref, files, commitLog, isInitial: true };
		}

		// Cursor ahead of HEAD (e.g. history rewrite) → treat as no-op.
		if (lastScannedRef === ref) {
			return { ref, files: [], commitLog: "", isInitial: false };
		}

		// Diff range — name-only files changed.
		let files: string[] = [];
		let commitLog = "";
		try {
			const diff = await execAsync(
				`git diff --name-only ${lastScannedRef}..${ref}`,
				{ cwd: workspaceDir, timeout: 30000 },
			);
			files = diff.trim().split("\n").filter(Boolean);
		} catch (err) {
			log.debug("archivist-git", `diff ${lastScannedRef}..${ref} failed: ${(err as Error).message}`);
		}
		try {
			commitLog = await this.safeLog(workspaceDir, `${lastScannedRef}..${ref}`);
		} catch {
			// ignore
		}
		return { ref, files, commitLog, isInitial: false };
	}

	/**
	 * Commit PM-written requirement docs to main. RFC §2.15:
	 * "PM 写需求文档,由 archivist 统一 commit 到 main(PM 不碰 git)".
	 *
	 * Pass an explicit list of paths so we only commit doc files (PM's writes),
	 * never code or unrelated changes.
	 *
	 * Path safety: paths are passed through `git add -- <pathspec>` form. We
	 * reject paths containing shell metacharacters instead of trying to
	 * shell-escape them — git pathspecs don't take shell quotes, and rejecting
	 * keeps the surface tight across Windows (cmd) and POSIX.
	 */
	async commitRequirementDoc(
		workspaceDir: string,
		requirementId: string,
		title: string,
		docPaths: string[],
	): Promise<{ ok: boolean; ref?: string; error?: string }> {
		if (docPaths.length === 0) return { ok: false, error: "no doc paths" };
		for (const p of docPaths) {
			if (!isSafePathspec(p)) {
				return { ok: false, error: `unsafe doc path: ${p}` };
			}
		}
		if (!isSafeCommitSubject(title)) {
			return { ok: false, error: `unsafe title (no quotes/newlines allowed): ${title}` };
		}
		try {
			// Reset any pre-staged changes so we commit ONLY the named doc paths.
			// (PM's writes should be the only thing in this commit; anything else
			// already staged belongs to a different step.)
			try {
				await execAsync("git reset HEAD --", { cwd: workspaceDir });
			} catch {
				// No HEAD yet (brand-new repo) — nothing to reset, fine.
			}
			// Stage only the named doc paths.
			const addArgs = docPaths.map((p) => `-- "${p}"`).join(" ");
			await execAsync(`git add ${addArgs}`, { cwd: workspaceDir });
			// Check there's anything staged (file may be unchanged).
			const status = await execAsync("git diff --cached --name-only", { cwd: workspaceDir });
			if (!status.trim()) {
				const ref = await this.getCurrentMainRef(workspaceDir);
				return { ok: true, ref };
			}
			const subject = `docs(req): ${title} [${shortId(requirementId)}]`;
			await execAsync(`git commit -m "${subject}"`, { cwd: workspaceDir });
			const ref = await this.getCurrentMainRef(workspaceDir);
			log.agent(`Archivist: committed requirement doc ${requirementId} → ${ref}`);
			return { ok: true, ref };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/**
	 * Merge a verified feature branch back to main, then clean up its worktree.
	 * RFC §2.15:
	 *   "PM verify accept 后,archivist 把 feature 分支合并回 main + 清理 feature
	 *    worktree → 需求 closed".
	 *
	 * Performs a no-ff merge to preserve the feature-branch topology. On
	 * conflict, returns ok=false with conflict list and leaves main untouched.
	 */
	async mergeFeatureToMain(
		workspaceDir: string,
		requirementId: string,
		projectId?: string,
	): Promise<MergeResult> {
		const branch = featureBranchName(requirementId);
		const worktree = featureWorktreePath(workspaceDir, requirementId, projectId);

		try {
			// Make sure we're on main in the primary worktree.
			await execAsync("git checkout main", { cwd: workspaceDir });

			// Does the feature branch exist?
			try {
				await execAsync(`git rev-parse --verify ${branch}`, { cwd: workspaceDir });
			} catch {
				return { ok: false, error: `feature branch not found: ${branch}` };
			}

			// Attempt merge. Use --no-ff to keep feature topology.
			try {
				await execAsync(
					`git merge --no-ff -m "merge: ${branch} (archivist)" ${branch}`,
					{ cwd: workspaceDir, timeout: 30000 },
				);
			} catch (err) {
				const stderr = (err as any)?.stderr ? String((err as any).stderr) : "";
				const conflicts = await this.listConflictedFiles(workspaceDir);
				// Abort the in-progress merge so main is left clean.
				try { await execAsync("git merge --abort", { cwd: workspaceDir }); } catch {}
				return {
					ok: false,
					conflicts,
					error: `merge conflict: ${stderr || (err as Error).message}`,
				};
			}

			const ref = await this.getCurrentMainRef(workspaceDir);

			// Clean up the feature worktree + branch.
			await this.cleanupWorktree(workspaceDir, requirementId, projectId);

			log.agent(`Archivist: merged ${branch} → main (${ref})`);
			return { ok: true, mergedToRef: ref };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/**
	 * Remove a feature worktree and delete its branch. RFC §2.15:
	 * "清理 feature worktree". Safe to call multiple times.
	 */
	async cleanupWorktree(workspaceDir: string, requirementId: string, projectId?: string): Promise<void> {
		const branch = featureBranchName(requirementId);
		const worktree = featureWorktreePath(workspaceDir, requirementId, projectId);

		// Remove the worktree if it exists.
		if (existsSync(worktree)) {
			try {
				if (!isSafePathspec(worktree)) {
					log.warn("archivist-git", `refusing unsafe worktree path: ${worktree}`);
				} else {
					await execAsync(`git worktree remove --force "${worktree}"`, {
						cwd: workspaceDir,
					});
				}
			} catch (err) {
				log.debug("archivist-git", `worktree remove failed: ${(err as Error).message}`);
				// Fallback: force-remove the directory if `git worktree remove`
				// refused (Windows file locks / locks dir). Then prune metadata.
				try {
					const { rmSync } = await import("node:fs");
					rmSync(worktree, { recursive: true, force: true });
				} catch (e) {
					log.debug("archivist-git", `worktree rmSync fallback failed: ${(e as Error).message}`);
				}
			}
		}
		// Prune worktree metadata (also removes worktrees whose dirs we just
		// force-deleted via the fallback above).
		try {
			await execAsync("git worktree prune", { cwd: workspaceDir });
		} catch {}

		// Delete the feature branch.
		try {
			await execAsync(`git branch -D ${branch}`, { cwd: workspaceDir });
		} catch (err) {
			log.debug("archivist-git", `branch delete ${branch} failed: ${(err as Error).message}`);
		}
	}

	// ─── Private helpers ──────────────────────────────────────────────

	private async listTrackedFiles(workspaceDir: string): Promise<string[]> {
		try {
			const out = await execAsync("git ls-files", { cwd: workspaceDir, timeout: 30000 });
			return out.trim().split("\n").filter(Boolean);
		} catch {
			return [];
		}
	}

	private async safeLog(workspaceDir: string, ...args: string[]): Promise<string> {
		try {
			// args come from internal callers (git rev range / -n N) — no user
			// strings here, but still reject metacharacters defensively.
			const safe = args.filter(isSafePathspec);
			const cmd = "git log --oneline " + safe.join(" ");
			return await execAsync(cmd, { cwd: workspaceDir, timeout: 15000 });
		} catch {
			return "";
		}
	}

	private async listConflictedFiles(workspaceDir: string): Promise<string[]> {
		try {
			const out = await execAsync("git diff --name-only --diff-filter=U", { cwd: workspaceDir });
			return out.trim().split("\n").filter(Boolean);
		} catch {
			return [];
		}
	}
}

// ---------------------------------------------------------------------------
// Path / subject safety — cross-platform (Windows cmd + POSIX).
//
// We do NOT shell-escape and embed user strings into git commands; git's own
// quoting is incompatible with cmd.exe's quoting (single quotes are literal
// chars on Windows, double quotes are stripped on POSIX in subtle ways).
// Instead we *reject* any string containing shell metacharacters, so the
// safe remainder can be interpolated into the command line directly. Caller
// (archivist-service) only ever passes workspace-relative paths it derived
// from `git ls-files` / `git diff --name-only`, which never contain these.
// ---------------------------------------------------------------------------

/** Reject paths with shell metacharacters / line breaks. */
function isSafePathspec(p: string): boolean {
	if (!p || typeof p !== "string") return false;
	// Allow alphanumerics, _, -, ., /, \, :, and spaces (paths can have spaces).
	return !/[`$"'><;&|*?()\n\r]/.test(p);
}

/** Reject commit subjects with quotes / newlines (everything else is safe). */
function isSafeCommitSubject(s: string): boolean {
	if (!s || typeof s !== "string") return false;
	return !/[`$\n\r"]/.test(s);
}
