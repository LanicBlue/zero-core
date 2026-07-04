// Git 集成
//
// # 文件说明书
//
// ## 核心功能
// 封装 Git 操作，供 Lead 服务和 Analyst 服务调用。
// 所有方法安全失败：git 不可用时返回空默认值，不抛异常。
//
// ## 输入
// - projectPath — 项目目录路径
// - requirementId / title — 需求信息
//
// ## 输出
// - GitIntegration 类（分支创建、diff、提交、PR）
//
// ## 定位
// 服务层工具，被 lead-service 和 analyst-service 使用。
//
// ## 依赖
// - child_process (exec)
//
// ## 维护规则
// - NEVER throw — 所有方法返回安全默认值
// - 所有 shell 操作必须带 timeout
//

import { exec } from "child_process";
import { log } from "../core/logger.js";
import { centralFeatureWorktreePath } from "./archivist-git.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function execAsync(cmd: string, options: { cwd: string; timeout?: number }): Promise<string> {
	return new Promise((resolve, reject) => {
		exec(cmd, { cwd: options.cwd, timeout: options.timeout ?? 15000, encoding: "utf-8" }, (err, stdout) => {
			if (err) return reject(err);
			resolve(stdout);
		});
	});
}

/**
 * 将标题转换为 URL-safe slug。
 */
function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.substring(0, 30);
}

// ---------------------------------------------------------------------------
// GitIntegration
// ---------------------------------------------------------------------------

export class GitIntegration {

	/**
	 * 创建需求分支。
	 * 分支名格式：workflow/{requirementId前8位}-{slug(title)}
	 *
	 * NOTE: 旧的 branch-only 流程(M5)。M3 起 lead 改用 createFeatureWorktree
	 * 建独立 worktree(RFC §2.15)。本方法保留供旧路径调用。
	 */
	async createRequirementBranch(
		projectPath: string,
		requirementId: string,
		title: string,
	): Promise<string> {
		const slug = slugify(title);
		const shortId = requirementId.substring(0, 8);
		const branchName = `workflow/${shortId}-${slug || "req"}`;

		try {
			await execAsync(`git checkout -b ${branchName}`, { cwd: projectPath });
			log.debug("git", `Created branch: ${branchName}`);
			return branchName;
		} catch (err) {
			log.error("git", `Failed to create branch: ${(err as Error).message}`);
			return branchName;  // Return name even if creation failed
		}
	}

	/**
	 * v0.8 (M3): 创建 feature worktree(决策 25/28)。lead 进 build 时建独立
	 * 目录,分支 `req-{shortId}` —— 与 archivist-git 的
	 * featureWorktreePath/featureBranchName 约定完全一致,archivist
	 * mergeFeatureToMain 直接能找到 + 清理。本方法 safe-fail(与其他 git
	 * 方法一样),git 不可用时只 log 不抛。
	 *
	 * project-flow §4.2 (F3): worktree 路径集中化到
	 * `~/.zero-core/projects/{project}/{req-shortId}/`(避免 workspace 旁误改 +
	 * 散落清理)。当 projectId 传入时用 centralFeatureWorktreePath;否则回退到
	 * 旧的 `{workspace}.worktrees/req-{shortId}`(back-compat)。
	 *
	 * 返回 worktree 路径;失败时返回 fallback = projectPath(在主 worktree 跑)。
	 */
	async createFeatureWorktree(
		projectPath: string,
		requirementId: string,
		projectId?: string,
	): Promise<{ worktreePath: string; branch: string; ok: boolean }> {
		const shortId = requirementId.substring(0, 8);
		const branch = `req-${shortId}`;
		const worktreePath = projectId
			? centralFeatureWorktreePath(projectId, requirementId)
			: `${projectPath}.worktrees/req-${shortId}`;

		try {
			// Create the branch (from current HEAD) and a linked worktree at the
			// convention path. -b creates the branch if it doesn't exist; if it
			// already exists we fall back to checking out the existing branch
			// in the worktree.
			try {
				await execAsync(
					`git worktree add -b ${branch} "${worktreePath}"`,
					{ cwd: projectPath, timeout: 30000 },
				);
			} catch (err) {
				// Branch may already exist — try without -b.
				try {
					await execAsync(
						`git worktree add "${worktreePath}" ${branch}`,
						{ cwd: projectPath, timeout: 30000 },
					);
				} catch {
					// Worktree path may already exist too — fine, reuse it.
					log.debug("git", `worktree add ${branch} failed (likely exists): ${(err as Error).message}`);
				}
			}
			log.agent(`git: feature worktree ${branch} at ${worktreePath}`);
			return { worktreePath, branch, ok: true };
		} catch (err) {
			log.error("git", `Failed to create feature worktree: ${(err as Error).message}`);
			return { worktreePath: projectPath, branch, ok: false };
		}
	}

	/**
	 * v0.8 (M3): 在 feature worktree 提交一步,commit message 引用 requirementId
	 * 喂 traceability(决策 21)。格式约定 `feat: <step> [req-<shortId>]`。
	 */
	async commitStep(
		worktreePath: string,
		requirementId: string,
		message: string,
	): Promise<{ ok: boolean; ref?: string; error?: string }> {
		const shortId = requirementId.substring(0, 8);
		// Strip any user-supplied square brackets / newlines to keep the
		// reference block well-formed.
		const cleanMsg = message.replace(/[\[\]\n\r]/g, " ").trim();
		const subject = `${cleanMsg} [req-${shortId}]`;
		try {
			await execAsync("git add -A", { cwd: worktreePath });
			// Check if there's anything staged (skip empty commits).
			const status = await execAsync("git diff --cached --name-only", { cwd: worktreePath });
			if (!status.trim()) {
				return { ok: true };
			}
			const safeSubject = subject.replace(/"/g, "");
			await execAsync(`git commit -m "${safeSubject}"`, { cwd: worktreePath });
			const ref = (await execAsync("git rev-parse --verify HEAD", { cwd: worktreePath })).trim();
			log.debug("git", `Committed step: ${subject} → ${ref}`);
			return { ok: true, ref };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	/**
	 * 获取自某时间以来的 diff（增量分析用）。
	 */
	async getDiffSince(projectPath: string, sinceDate: string): Promise<string> {
		try {
			const logOutput = await execAsync(
				`git log --since="${sinceDate}" --oneline -n 50`,
				{ cwd: projectPath },
			);
			if (!logOutput.trim()) return "";

			const count = Math.min(logOutput.split("\n").length, 20);
			const diff = await execAsync(
				`git diff HEAD~${count} --stat`,
				{ cwd: projectPath, timeout: 30000 },
			);
			return diff;
		} catch {
			return "";  // No changes or git unavailable
		}
	}

	/**
	 * 获取变更文件列表（验证用）。
	 */
	async getChangedFiles(projectPath: string, baseBranch?: string): Promise<string[]> {
		try {
			const branch = baseBranch || "main";
			const stdout = await execAsync(
				`git diff --name-only ${branch}..HEAD`,
				{ cwd: projectPath },
			);
			return stdout.trim().split("\n").filter(Boolean);
		} catch {
			return [];
		}
	}

	/**
	 * 提交变更（步骤完成后可选）。
	 */
	async commitChanges(projectPath: string, message: string): Promise<void> {
		try {
			await execAsync("git add -A", { cwd: projectPath });
			// Escape quotes in message
			const safeMsg = message.replace(/"/g, '\\"');
			await execAsync(`git commit -m "${safeMsg}"`, { cwd: projectPath });
			log.debug("git", `Committed changes: ${message.substring(0, 50)}`);
		} catch (err) {
			log.error("git", `Commit failed: ${(err as Error).message}`);
			// Nothing to commit is fine
		}
	}

	/**
	 * 创建 PR（如果配置了远端）。
	 * 尝试 push + gh pr create；如果 gh 不可用，只 push 并返回分支名。
	 */
	async createPullRequest(
		projectPath: string,
		requirementId: string,
		title: string,
		body: string,
	): Promise<{ url?: string; branch: string }> {
		let branch = "";
		try {
			branch = (await execAsync("git branch --show-current", { cwd: projectPath })).trim();
		} catch {
			return { branch: branch || "unknown" };
		}

		// Push
		try {
			await execAsync(`git push -u origin ${branch}`, { cwd: projectPath, timeout: 30000 });
		} catch {
			// Push may fail (no remote), continue
		}

		// Create PR via gh CLI
		try {
			const safeTitle = title.replace(/"/g, '\\"');
			const safeBody = body.replace(/"/g, '\\"').substring(0, 500);
			const stdout = await execAsync(
				`gh pr create --title "${safeTitle}" --body "${safeBody}" --base main`,
				{ cwd: projectPath, timeout: 30000 },
			);
			const urlMatch = stdout.match(/https:\/\/github\.com\/\S+/);
			return { url: urlMatch?.[0], branch };
		} catch {
			// gh CLI not available
			return { branch };
		}
	}
}
