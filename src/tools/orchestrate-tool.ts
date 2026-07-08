// Orchestrate 编排器工具 (v0.8 M3 / tool-decoupling sub-4 迁新签名)
//
// # 文件说明书
//
// ## 核心功能
// Orchestrate 是**系统工具**(决策 48):按 lead 提交的 DSL flow 编排多个
// agent-tool 执行。lead 是 DSL 作者(指定各节点用哪个 agent);本工具是执行
// 引擎,不是 DSL 作者(决策 11/48)。
//
// 节点类型(决策 48;最小子集 = task/parallel/pipeline/verify,if/for/barrier
// 作为节点存在但 M3 仅 stub 条件/迭代语义):
//   - task       派一个 agent-tool 执行一段任务
//   - parallel   并发跑子节点,等全部完成
//   - pipeline   串行跑子节点,前一个的输出灌进下一个的输入
//   - if         条件分支(M3 stub:仅评估 then 分支)
//   - for        迭代(M3 stub:跑一次 body)
//   - barrier    同步点(M3 no-op marker)
//   - verify     验收节点:跑命令 + 派审查 agent,产出 manifest(决策 34)
//
// ## confirm 门状态机(验收硬指标 —— 「停住不占资源」)
// lead 提交 flow(mode="confirm") → 工具 execute 内:
//   1. 把 plan 落到 OrchestratePlanStore(state="pending");
//   2. 在 ConfirmRegistry 注册一个未 resolve 的 Promise(返回句柄存内存);
//   3. `await thatPromise`。
//
// await 时工具未返回 → loop 已 await 这个工具结果,自然停在这里,不发下一
// 次 LLM call、不轮询、不占 CPU。真正的挂起,不是忙等。
//
// 外部 IPC confirm/reject 路径调用 ConfirmRegistry.confirm(planId) /
// .reject(planId) → Promise resolve(true/false) → 工具 execute 返回。
//
//   pending(等确认) → confirmed(run)/ rejected(返回 false + 理由)
//
// ## 输入
// - flow: lead 撰写的 OrchestrateFlow
// - mode: "confirm"(默认,需要用户确认才执行)/ "run"(直接执行,用于驳回
//   回路里 lead 自重提交时不再需要确认)
//
// ## 输出
// - confirm 模式被 rejected → "false: <reason>"
// - confirm 模式被 confirmed / run 模式 → 执行后摘要 + manifest 概览
//   形态:ToolResult{data:{text, planId?, manifestId?}};format(r) = r.data.text
//
// ## 定位
// 中立工具层(src/tools/),被 Lead Agent 调用。sub-agent dispatch 走 delegateFns +
// toolPolicy(继承 caller bundle)。
//
// ## 依赖
// - zod
// - ./tool-factory
// - ../../server/orchestrate-store (plan + manifest + confirm registry)
// - ../shared/types (OrchestrateNode/Flow/...)
// - callerCtx.delegateFns(delegateTask / setToolCallTaskId)
// - callerCtx.agentResolvers(subagents / resolveSubagentTarget)
// - callerCtx.orchestratePlanStore / orchestrateManifestStore / gitIntegration
// - callerCtx.workingDir / contextBundle / projectId / activeRequirementId /
//   agentId / sessionId / toolCallId
//
// ## 维护规则
// - confirm 门绝不退化成轮询/忙等/长连接占资源
// - 节点 dispatch 走 delegateFns(继承 caller bundle + toolPolicy)
// - manifest 落库(决策 34) → PM 覆盖判断 + archivist traceability
// - tool-decoupling sub-4(G1 + 决策 2/3):所有 session 状态经 callerCtx;
//   UI 无 loop 状态 → 返默认/示例;execute 返 ToolResult JSON;format 文本与
//   sub-4 前逐字一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";
import type {
	OrchestrateFlow,
	OrchestrateNode,
	OrchestrateTaskNode,
	OrchestrateParallelNode,
	OrchestratePipelineNode,
	OrchestrateIfNode,
	OrchestrateForNode,
	OrchestrateBarrierNode,
	OrchestrateVerifyNode,
	OrchestrateManifestRecord,
} from "../shared/types.js";
import {
	OrchestratePlanStore,
	OrchestrateManifestStore,
	ConfirmRegistry,
} from "../server/orchestrate-store.js";
import { log } from "../core/logger.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Flow schema (zod) — accepts the DSL authored by lead
// ---------------------------------------------------------------------------

/**
 * Recursive zod schema for an OrchestrateNode. zod 4 supports lazy recursion;
 * we declare task/parallel/pipeline/if/for/barrier/verify node shapes.
 */
const taskNodeSchema = z.object({
	kind: z.literal("task"),
	id: z.string(),
	agentTool: z.string(),
	task: z.string(),
	wikiNodes: z.array(z.string()).optional(),
	relatedFiles: z.array(z.string()).optional(),
});

type LazyNode = z.ZodType<OrchestrateNode>;

const nodeSchema: LazyNode = z.lazy(() => z.union([
	taskNodeSchema,
	z.object({
		kind: z.literal("parallel"),
		id: z.string(),
		children: z.array(nodeSchema),
	}),
	z.object({
		kind: z.literal("pipeline"),
		id: z.string(),
		children: z.array(nodeSchema),
	}),
	z.object({
		kind: z.literal("if"),
		id: z.string(),
		condition: z.string(),
		then: z.array(nodeSchema),
		else: z.array(nodeSchema).optional(),
	}),
	z.object({
		kind: z.literal("for"),
		id: z.string(),
		over: z.string(),
		as: z.string(),
		body: z.array(nodeSchema),
	}),
	z.object({
		kind: z.literal("barrier"),
		id: z.string(),
	}),
	z.object({
		kind: z.literal("verify"),
		id: z.string(),
		commands: z.array(z.string()).optional(),
		reviewerAgentTool: z.string().optional(),
	}),
])) as LazyNode;

const flowSchema = z.object({
	requirementId: z.string(),
	title: z.string(),
	root: nodeSchema,
}) satisfies z.ZodType<OrchestrateFlow>;

// ---------------------------------------------------------------------------
// Execution result accumulator (manifest building blocks)
// ---------------------------------------------------------------------------

interface ExecResult {
	/** Text summary returned to the lead for this node. */
	summary: string;
	/** Files reported touched by sub-agent dispatches (best-effort, parsed from output). */
	touchedFiles: string[];
	/** Test runs collected from verify nodes. */
	tests: Array<{ command: string; ok: boolean; output?: string }>;
	/** Review verdicts collected from verify nodes. */
	review?: { verdict: "approved" | "rejected"; comment?: string };
	/** Failure flag for short-circuit semantics in pipeline. */
	failed?: boolean;
}

function emptyResult(summary = ""): ExecResult {
	return { summary, touchedFiles: [], tests: [] };
}

function mergeResults(parts: ExecResult[]): ExecResult {
	const merged = emptyResult();
	for (const p of parts) {
		if (p.summary) merged.summary += (merged.summary ? "\n---\n" : "") + p.summary;
		merged.touchedFiles.push(...p.touchedFiles);
		merged.tests.push(...p.tests);
		if (p.review && !merged.review) merged.review = p.review;
		if (p.failed) merged.failed = true;
	}
	merged.touchedFiles = Array.from(new Set(merged.touchedFiles));
	return merged;
}

// Parse touched files from a sub-agent output ("Files changed: a.ts, b.ts").
const FILES_RE = /(?:Files changed|Changed files|Touched files)[:\-]?\s*([^\n]+)/i;
function parseTouchedFiles(text: string): string[] {
	const m = text.match(FILES_RE);
	if (!m) return [];
	const raw = m[1];
	return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface EngineDeps {
	callerCtx: CallerCtx;
	flow: OrchestrateFlow;
	planId: string;
	manifestStore?: OrchestrateManifestStore;
}

async function dispatchAgentTool(
	callerCtx: CallerCtx,
	agentToolName: string,
	task: string,
): Promise<string> {
	const fns = callerCtx.delegateFns;
	if (!fns?.delegateTask) {
		return `Error: delegateTask not available — cannot dispatch ${agentToolName}`;
	}

	// v0.8 (P2 §11.5): resolve the agentTool name → target agent via this
	// session's subagents list (AgentRecord.subagents, surfaced via
	// callerCtx.agentResolvers.subagents). Each entry's user-facing name (or
	// agentId) is matched against agentToolName; identity comes from
	// callerCtx.agentResolvers.resolveSubagentTarget. The legacy getAgentToolEntries
	// path is retired.
	const resolvers = callerCtx.agentResolvers;
	const subagents = resolvers?.subagents;
	const resolveTarget = resolvers?.resolveSubagentTarget;

	let targetAgentId: string | undefined;
	let systemPrompt: string | undefined;
	let model: string | undefined;
	let toolPolicy: any;

	const entry = subagents?.find(
		(s) => (s.name && s.name === agentToolName) || s.agentId === agentToolName,
	);
	if (entry?.agentId) {
		targetAgentId = entry.agentId;
		const target = resolveTarget?.(entry.agentId);
		if (target) {
			systemPrompt = target.systemPrompt;
			model = target.model;
			toolPolicy = target.toolPolicy;
		}
	}

	if (!targetAgentId) {
		// Fallback: convention target id `role:<name>` (matches orchestrate-tool
		// M0 convention). toolPolicy unknown — pass minimal role config.
		targetAgentId = `role:${agentToolName}`;
	}

	try {
		// Step 2E: stamp the parent tool-call id (this Orchestrate tool-call)
		// onto the delegated task so the parent resume path can resolve a
		// dangling dispatch → its task. The Orchestrate tool runs a whole flow
		// under a single tool-call id; each task node shares that id (the link
		// is best-effort — multiple nodes under one Orchestrate call all map to
		// the same parent tool-call, which is fine for resume lookup).
		const parentToolCallId = callerCtx.toolCallId;
		const result = await fns.delegateTask(task, {
			targetAgentId,
			systemPrompt,
			model,
			toolPolicy,
			workspaceDir: callerCtx.contextBundle?.workspaceDir ?? callerCtx.workingDir,
			parentToolCallId,
			onDispatched: parentToolCallId && fns.setToolCallTaskId
				? (id: string) => fns.setToolCallTaskId!(parentToolCallId, id)
				: undefined,
		});
		return result || "(no output)";
	} catch (err: any) {
		return `Error dispatching ${agentToolName}: ${err.message}`;
	}
}

async function runNode(node: OrchestrateNode, deps: EngineDeps): Promise<ExecResult> {
	switch (node.kind) {
		case "task":
			return runTaskNode(node, deps);
		case "parallel":
			return runParallelNode(node, deps);
		case "pipeline":
			return runPipelineNode(node, deps);
		case "if":
			return runIfNode(node, deps);
		case "for":
			return runForNode(node, deps);
		case "barrier":
			return runBarrierNode(node);
		case "verify":
			return runVerifyNode(node, deps);
	}
}

async function runTaskNode(node: OrchestrateTaskNode, deps: EngineDeps): Promise<ExecResult> {
	log.agent(`Orchestrate task: ${node.id} → ${node.agentTool}`);
	const output = await dispatchAgentTool(deps.callerCtx, node.agentTool, node.task);
	const touched = parseTouchedFiles(output);

	// v0.8 (M3): commit this step on the feature worktree with the [req-<short>]
	// reference (decision 21 — feed traceability). The lead's working dir is
	// the feature worktree path (set by LeadService.pickupRequirement), so we
	// reuse it. safe-fail: git unavailable / no worktree → silent no-op.
	commitStepOnWorktree(deps, node, touched);

	return {
		summary: `[${node.id}] ${node.agentTool}:\n${output}`,
		touchedFiles: touched,
		tests: [],
	};
}

/**
 * v0.8 (M3): commit one Orchestrate task step on the feature worktree, with
 * the requirementId reference (decision 21 / RFC §2.15). Best-effort — git
 * unavailable / no worktree / no staged changes → silent no-op.
 *
 * The worktree path is the lead's working dir, which LeadService.pickupRequirement
 * already set to `{workspace}.worktrees/req-{shortId}/` (or fell back to the
 * main workspace). GitIntegration.commitStep short-circuits on empty index.
 */
function commitStepOnWorktree(
	deps: EngineDeps,
	node: OrchestrateTaskNode,
	_touchedFiles: string[],
): void {
	const worktreePath = deps.callerCtx.contextBundle?.workspaceDir ?? deps.callerCtx.workingDir;
	if (!worktreePath) return;
	const gitIntegration = deps.callerCtx.gitIntegration as
		| { commitStep: (worktree: string, reqId: string, msg: string) => Promise<{ ok: boolean; ref?: string; error?: string }> }
		| undefined;
	if (!gitIntegration?.commitStep) return;
	const reqId = deps.flow.requirementId;
	const msg = `${node.agentTool}/${node.id}: ${node.task.split("\n")[0].slice(0, 60)}`;
	// Fire and forget — commits must not block the engine; log on failure.
	gitIntegration
		.commitStep(worktreePath, reqId, msg)
		.then((r) => {
			if (!r.ok) log.debug("orchestrate", `commitStep ${node.id} failed: ${r.error ?? "(unknown)"}`);
		})
		.catch(() => { /* git unavailable — best-effort */ });
}

async function runParallelNode(node: OrchestrateParallelNode, deps: EngineDeps): Promise<ExecResult> {
	log.agent(`Orchestrate parallel: ${node.id} (${node.children.length} children)`);
	const results = await Promise.all(node.children.map((c) => runNode(c, deps)));
	return mergeResults(results);
}

async function runPipelineNode(node: OrchestratePipelineNode, deps: EngineDeps): Promise<ExecResult> {
	log.agent(`Orchestrate pipeline: ${node.id} (${node.children.length} children)`);
	const acc: ExecResult[] = [];
	let prevOutput = "";
	for (const child of node.children) {
		// If child is a task, pipe previous output into its task text.
		if (child.kind === "task" && prevOutput) {
			const augmented: OrchestrateTaskNode = {
				...child,
				task: `${child.task}\n\n--- previous step output ---\n${prevOutput}`,
			};
			const r = await runNode(augmented, deps);
			acc.push(r);
			prevOutput = r.summary;
			if (r.failed) break; // short-circuit on failure
		} else {
			const r = await runNode(child, deps);
			acc.push(r);
			prevOutput = r.summary;
			if (r.failed) break;
		}
	}
	return mergeResults(acc);
}

async function runIfNode(node: OrchestrateIfNode, deps: EngineDeps): Promise<ExecResult> {
	// M3 stub: we have no predicate evaluator. We run the then-branch and skip
	// else — leads author flows that work with this conservative default.
	log.agent(`Orchestrate if: ${node.id} (M3 stub — running then-branch)`);
	const results = await Promise.all(node.then.map((c) => runNode(c, deps)));
	return mergeResults(results);
}

async function runForNode(node: OrchestrateForNode, deps: EngineDeps): Promise<ExecResult> {
	// M3 stub: we have no iterator. We run the body once.
	log.agent(`Orchestrate for: ${node.id} (M3 stub — running body once)`);
	const results = await Promise.all(node.body.map((c) => runNode(c, deps)));
	return mergeResults(results);
}

async function runBarrierNode(node: OrchestrateBarrierNode): Promise<ExecResult> {
	// Barrier is a no-op marker in the in-process engine; Promise.all on the
	// parent already provides the synchronization point.
	log.agent(`Orchestrate barrier: ${node.id} (no-op in-process)`);
	return emptyResult(`[barrier ${node.id}]`);
}

async function runVerifyNode(node: OrchestrateVerifyNode, deps: EngineDeps): Promise<ExecResult> {
	log.agent(`Orchestrate verify: ${node.id}`);
	const tests: Array<{ command: string; ok: boolean; output?: string }> = [];
	const cwd = deps.callerCtx.contextBundle?.workspaceDir ?? deps.callerCtx.workingDir;

	for (const cmd of node.commands ?? []) {
		try {
			const { stdout } = await execAsync(cmd, { cwd, timeout: 120000 });
			tests.push({ command: cmd, ok: true, output: stdout.slice(0, 4000) });
		} catch (err: any) {
			const out = (err.stdout || "") + (err.stderr ? "\n[stderr] " + err.stderr : "");
			tests.push({ command: cmd, ok: false, output: (out as string).slice(0, 4000) });
		}
	}

	let review: ExecResult["review"];
	if (node.reviewerAgentTool) {
		const reviewTask = `Review the changes for requirement ${deps.flow.requirementId}. Output verdict: APPROVED or REJECTED with brief justification.`;
		const reviewOut = await dispatchAgentTool(deps.callerCtx, node.reviewerAgentTool, reviewTask);
		const approved = /APPROVED/i.test(reviewOut);
		review = {
			verdict: approved ? "approved" : "rejected",
			comment: reviewOut.slice(0, 2000),
		};
	}

	return {
		summary: `[verify ${node.id}] ${tests.length} test(s), review=${review?.verdict ?? "n/a"}`,
		touchedFiles: [],
		tests,
		review,
		failed: review?.verdict === "rejected" || tests.some((t) => !t.ok),
	};
}

/**
 * Build the manifest record from a completed run and persist it.
 * Caller passes the merged ExecResult of the whole flow.
 */
function persistManifest(
	deps: EngineDeps,
	merged: ExecResult,
): OrchestrateManifestRecord | undefined {
	if (!deps.manifestStore) return undefined;
	const projectId = deps.callerCtx.projectId ?? "";
	const passed = !merged.failed;
	const summary =
		`Requirement ${deps.flow.requirementId} — ${deps.flow.title}\n` +
		`Tests: ${merged.tests.length} (${merged.tests.filter((t) => t.ok).length} ok)\n` +
		`Review: ${merged.review?.verdict ?? "n/a"}\n` +
		`Touched files (${merged.touchedFiles.length}): ${merged.touchedFiles.slice(0, 20).join(", ")}\n` +
		`Overall: ${passed ? "PASS" : "FAIL"}`;

	return deps.manifestStore.create({
		requirementId: deps.flow.requirementId,
		planId: deps.planId,
		projectId,
		touchedFiles: merged.touchedFiles,
		tests: merged.tests,
		review: merged.review,
		summary,
	});
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

interface OrchestrateData {
	/** LLM-facing text: post-run summary + manifest line (or rejection reason). */
	text: string;
	/** Persisted plan id (for UI dispatcher traceability). */
	planId?: string;
	/** Persisted manifest id (PM coverage judgement + archivist traceability). */
	manifestId?: string;
}

export const orchestrateTool = buildTool({
	name: "Orchestrate",
	description: "Submit and run an Orchestrate DSL flow authored by the lead. Confirms with the user before executing unless mode=run.",
	prompt: "Submit an Orchestrate DSL flow (parallel/pipeline/if/for/barrier/verify) to orchestrate sub-agent execution.\n\n" +
		"Each task node references an agent-tool you have enabled via toolPolicy (decision 48 — you are the DSL author, Orchestrate is the engine).\n\n" +
		"Inputs:\n" +
		"- flow (required) — { requirementId, title, root: OrchestrateNode }\n" +
		"- mode (optional) — 'confirm' (default) pauses execution and waits for the user to confirm the plan; 'run' executes immediately (use after a rejection-loop fix)\n\n" +
		"Confirm semantics: when mode='confirm', this tool stops and waits — it does not return, does not time out, and does not issue another LLM call until the user confirms or rejects via the kanban plan-pending entry. On reject, returns `false: <reason>`.\n\n" +
		"Verify nodes run unit tests / smoke / reviewer dispatch automatically and produce a manifest (changed files + tests + review verdict).",
	meta: {
		category: "agent",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
		exposable: false,
	},

	inputSchema: z.object({
		flow: flowSchema.describe("The Orchestrate flow to submit"),
		mode: z.enum(["confirm", "run"]).optional()
			.describe("'confirm' (default) waits for user; 'run' executes immediately"),
	}),

	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult<OrchestrateData>> => {
		const fns = callerCtx.delegateFns;
		// 1. Validate context
		if (!fns?.delegateTask) {
			// G1:UI/external host without a loop → benign preview.
			return {
				ok: true,
				data: {
					text: "(preview) Orchestrate unavailable — callerCtx has no delegateFns (not running inside an agent loop).",
				},
			};
		}
		if (!callerCtx.activeRequirementId) {
			return { ok: false, error: "Orchestrate not available in this context (no activeRequirementId)" };
		}
		if (!callerCtx.projectId) {
			return { ok: false, error: "Orchestrate not available in this context (no projectId)" };
		}

		const planStore = callerCtx.orchestratePlanStore as OrchestratePlanStore | undefined;
		const manifestStore = callerCtx.orchestrateManifestStore as OrchestrateManifestStore | undefined;
		const mode = input.mode ?? "confirm";
		const flow = input.flow as OrchestrateFlow;

		// 2. Persist the plan with state=pending
		let planId = "";
		if (planStore) {
			const plan = planStore.create({
				requirementId: flow.requirementId,
				projectId: callerCtx.projectId,
				// CallerCtx.agentId is optional (UI/MCP may have none); lead runs
				// always have one. Coalesce to empty for the persisted record.
				leadAgentId: callerCtx.agentId ?? "",
				leadSessionId: callerCtx.sessionId ?? "",
				flow: JSON.stringify(flow),
				state: "pending",
			});
			planId = plan.id;
			log.agent(`Orchestrate: plan ${planId} submitted (mode=${mode})`);
		} else {
			planId = `oplan-${Date.now()}`;
		}

		// 3. confirm gate — true suspend via ConfirmRegistry
		if (mode === "confirm") {
			const registry = ConfirmRegistry.getInstance();
			const confirmed = await registry.register(planId);
			if (!confirmed) {
				// Rejected. Persist the state and return false + reason.
				if (planStore) {
					const reason = planStore.get(planId)?.rejectionReason ?? "(no reason given)";
					planStore.setState(planId, "rejected", { rejectionReason: reason });
					return { ok: true, data: { text: `false: plan rejected — ${reason}`, planId } };
				}
				return { ok: true, data: { text: "false: plan rejected", planId } };
			}
			// Confirmed → run.
			if (planStore) planStore.setState(planId, "confirmed");
		}

		// 4. Execute the flow.
		if (planStore) planStore.setState(planId, "running");
		const engineDeps: EngineDeps = { callerCtx, flow, planId, manifestStore };
		try {
			const merged = await runNode(flow.root, engineDeps);

			// 5. Build + persist manifest.
			const manifest = persistManifest(engineDeps, merged);
			if (manifest && planStore) {
				planStore.setState(planId, merged.failed ? "failed" : "completed", {
					manifestId: manifest.id,
				});
			} else if (planStore) {
				planStore.setState(planId, merged.failed ? "failed" : "completed");
			}

			const overall = merged.failed ? "FAIL" : "PASS";
			const manifestLine = manifest ? `\n\nManifest id: ${manifest.id} (PM reads this for coverage judgement)` : "";
			return {
				ok: true,
				data: {
					text: `Orchestrate ${overall}. ${merged.tests.length} test(s), review=${merged.review?.verdict ?? "n/a"}.\n${merged.summary}${manifestLine}`,
					planId,
					manifestId: manifest?.id,
				},
			};
		} catch (err: any) {
			if (planStore) planStore.setState(planId, "failed");
			// Preserve pre-sub-4 behavior: orchestrate failures threw (the loop's
			// catch handled them as a tool failure). Migrated ok:false → buildTool
			// throws → unified failure side. Same outcome; error message preserved
			// verbatim (the loop's PostToolUseFailure hooks see the same text).
			return { ok: false, error: err?.message ?? "Orchestrate run failed." };
		}
	},
	format: (result: ToolResult): string => {
		if (!result.ok) {
			return result.error ?? "Orchestrate failed.";
		}
		return (result.data as OrchestrateData)?.text ?? "";
	},
});
