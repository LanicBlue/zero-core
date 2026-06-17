// Requirement 文档存储 (v0.8 M4 — discuss as document, RFC §2.10 / §4.5)
//
// # 文件说明书
//
// ## 核心功能
// 把每个 RequirementRecord 的完整内容 + 讨论沉淀写成一份 markdown 文件,
// 落到 repo 内 `{workspace}/.zero/requirements/{projectId}/{requirementId}.md`,
// 跟 repo 走、跨设备可恢复 (决策 12)。无 session 隔离 —— 状态在文档里,PM
// 用文件工具现读 (决策 13)。
//
// docPath 指向 repo 内的相对路径 (相对 workspaceDir),与 RequirementRecord
// 同步落库;同时它是 wiki 树的一个意图叶子节点 (archivist 建节点 + 关系,
// PM 写内容,决策 14)。
//
// ## 写隔离 (决策 7/13/18)
// - PM cron:只 buildNewRequirementDoc(创建新文档),不改已有文档
// - PM discuss / 用户:可 updateRequirementDoc(改文档内容)
// - 本存储不做角色 scope 强制 (那是 prompt + 工具能力层的事),只提供原语
//
// ## 输入
// - workspaceDir / projectId / requirementId
// - 文档正文 (markdown)
//
// ## 输出
// - RequirementDocStore 类
//
// ## 定位
// 服务层文件存储,被 pm-service / IPC doc handler 使用。
//
// ## 依赖
// - node:fs / node:path
// - ../shared/types (RequirementRecord)
//
// ## 维护规则
// - 路径约定:{workspace}/.zero/requirements/{projectId}/{requirementId}.md
// - 写前确保目录存在;读不存在返回 undefined (不抛)
//

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { RequirementRecord } from "../shared/types.js";

/** Subdirectory under a workspace where requirement docs live (decision 12). */
export const REQUIREMENTS_DIR_NAME = ".zero/requirements";

/**
 * Compute the repo-relative docPath for a requirement (POSIX-style, forward
 * slashes — stable across devices/OSes). The on-disk file lives at
 * `{workspace}/{REQUIREMENTS_DIR_NAME}/{projectId}/{requirementId}.md`.
 */
export function requirementDocRelPath(projectId: string, requirementId: string): string {
	// Use forward slashes so the docPath is OS-independent in the DB.
	return `${REQUIREMENTS_DIR_NAME}/${projectId}/${requirementId}.md`;
}

/** Absolute filesystem path for a requirement doc. */
export function requirementDocAbsPath(workspaceDir: string, projectId: string, requirementId: string): string {
	return join(workspaceDir, REQUIREMENTS_DIR_NAME, projectId, `${requirementId}.md`);
}

export interface RequirementDocStoreDeps {
	/** Resolver workspaceDir for a project. */
	getWorkspaceDir: (projectId: string) => string | undefined;
}

export class RequirementDocStore {
	private deps: RequirementDocStoreDeps;

	constructor(deps: RequirementDocStoreDeps) {
		this.deps = deps;
	}

	/**
	 * Create a NEW requirement doc. Used by PM cron discovery (decision 7 —
	 * cron 只建新需求). If the doc already exists, this is a no-op and returns
	 * the existing docPath (idempotent — PM cron may re-scan the same project).
	 *
	 * Returns the repo-relative docPath written.
	 */
	buildNewRequirementDoc(
		projectId: string,
		requirementId: string,
		content: string,
	): string {
		const workspaceDir = this.deps.getWorkspaceDir(projectId);
		if (!workspaceDir) {
			throw new Error(`Workspace not found for project: ${projectId}`);
		}
		const abs = requirementDocAbsPath(workspaceDir, projectId, requirementId);
		if (existsSync(abs)) {
			// Idempotent: don't overwrite an existing doc from cron.
			return requirementDocRelPath(projectId, requirementId);
		}
		mkdirSync(join(workspaceDir, REQUIREMENTS_DIR_NAME, projectId), { recursive: true });
		writeFileSync(abs, content, "utf-8");
		return requirementDocRelPath(projectId, requirementId);
	}

	/**
	 * Overwrite/append an existing requirement doc (PM discuss / user edits).
	 * Creates the file if missing. Returns the repo-relative docPath.
	 */
	updateRequirementDoc(
		projectId: string,
		requirementId: string,
		content: string,
	): string {
		const workspaceDir = this.deps.getWorkspaceDir(projectId);
		if (!workspaceDir) {
			throw new Error(`Workspace not found for project: ${projectId}`);
		}
		const abs = requirementDocAbsPath(workspaceDir, projectId, requirementId);
		mkdirSync(join(workspaceDir, REQUIREMENTS_DIR_NAME, projectId), { recursive: true });
		writeFileSync(abs, content, "utf-8");
		return requirementDocRelPath(projectId, requirementId);
	}

	/** Append a discussion turn / status note to an existing doc (decision 13). */
	appendToRequirementDoc(
		projectId: string,
		requirementId: string,
		section: string,
	): string | undefined {
		const workspaceDir = this.deps.getWorkspaceDir(projectId);
		if (!workspaceDir) return undefined;
		const abs = requirementDocAbsPath(workspaceDir, projectId, requirementId);
		if (!existsSync(abs)) return undefined;
		const existing = readFileSync(abs, "utf-8");
		writeFileSync(abs, `${existing}\n\n${section}`, "utf-8");
		return requirementDocRelPath(projectId, requirementId);
	}

	/** Read a requirement doc; returns undefined if missing. */
	readRequirementDoc(projectId: string, requirementId: string): string | undefined {
		const workspaceDir = this.deps.getWorkspaceDir(projectId);
		if (!workspaceDir) return undefined;
		const abs = requirementDocAbsPath(workspaceDir, projectId, requirementId);
		if (!existsSync(abs)) return undefined;
		return readFileSync(abs, "utf-8");
	}

	/** Convenience: read by the docPath stored on the record. */
	readRequirementDocByPath(docPath: string, workspaceDir: string): string | undefined {
		const abs = join(workspaceDir, docPath.split("/").join(sep));
		if (!existsSync(abs)) return undefined;
		return readFileSync(abs, "utf-8");
	}

	/**
	 * List all requirement docs for a project (returns repo-relative docPaths).
	 * Used by the PM session doc panel to show every requirement doc in one
	 * place (decision 13/14 — cross-cron, cross-date in one view).
	 */
	listRequirementDocs(projectId: string): string[] {
		const workspaceDir = this.deps.getWorkspaceDir(projectId);
		if (!workspaceDir) return [];
		const dir = join(workspaceDir, REQUIREMENTS_DIR_NAME, projectId);
		if (!existsSync(dir)) return [];
		const { readdirSync } = require("node:fs");
		const rel = relative(workspaceDir, dir);
		return readdirSync(dir)
			.filter((f: string) => f.endsWith(".md"))
			.map((f: string) => `${rel.split(sep).join("/")}/${f}`);
	}
}
