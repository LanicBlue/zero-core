// WikiSourceSearch — 源码搜索 ripgrep 封装(plan-03 §8 / design.md §8.5)
//
// # 文件说明书
//
// ## 核心功能
// 给 Wiki 工具的 search action 提供 `target=source/both` 的源码搜索能力。
// 封装 ripgrep(`rg`)子进程:
//
//   - cwd 由 repository binding + host 决定(plan-03 §8 + memory: 不能让模型
//     自报绝对 cwd)。
//   - scope 转换为允许的 source 相对根。
//   - 支持 exact / substring / glob / regex + case sensitivity。
//   - limit / cursor 或稳定截断。
//   - regex pattern ≤ 2048 UTF-8 bytes;ripgrep timeout 2 s;output 2 MiB;
//     results 200。超限 / 超时 → REGEX_LIMIT_EXCEEDED / REGEX_TIMEOUT。
//
// ## 关键不变量(plan-03 §8 / acceptance-03 §D)
//   - **cwd 不来自模型**: 永远从 wiki_repositories + ProjectStore.workspaceDir 派生。
//   - **scope 限定**: 只在 binding 允许的 source_root 子树内 grep。
//   - **结果映射回 canonical path**: 每条 hit 映射到 source-bound Wiki node path。
//   - **限制稳定**: pattern / timeout / output / results 超限给闭集错误码。
//   - workspace 搜索(非 indexed revision)→ 标 workspace/dirty。
//
// ## 不做
//   - 不直接搜 Wiki 正文(FTS 在 wiki-service / plan-04)。
//   - 不实现 embedding / hybrid ranking(plan-04 / 后续)。
//   - 不暴露 ripgrep 原始输出。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-03-project-git-mirror.md §8
//   - docs/archive/wiki-system-redesign/design.md §8.5 mode=regex/source

import { execFile } from "child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import type { WikiNodeRepository } from "./wiki-node-repository.js";
import type { WikiRepositoryStore, WikiRepositoryRow, WikiSourceBindingRow } from "./wiki-repository-store.js";
import { ZERO_CORE_DIR } from "../../core/config.js";
import { log } from "../../core/logger.js";

// ---------------------------------------------------------------------------
// Ripgrep binary resolver (CONCERN 9)
// ---------------------------------------------------------------------------

/**
 * Resolve the ripgrep binary path. Production rg is **not** guaranteed to be on
 * the default Windows PATH (round-1 tests only located it via a VS Code
 * extension). The resolver tries, in order:
 *
 *   1. `ZERO_CORE_RIPGREP_PATH` env var (explicit operator override).
 *   2. Bundled location `{ZERO_CORE_DIR}/bin/rg(.exe)`(sub-08 packaging scope
 *      drops the binary here in packaged builds; dev installs may also place it).
 *   3. VS Code extension rg —— round-3 FIX 3 broadened from a single
 *      hard-coded extension(`ms-vscode.cpptools`)to:
 *        a. A curated list of known rg-shipping extensions, each probed at a
 *           small set of known on-disk layouts(canonical
 *           `node_modules/@vscode/ripgrep/bin/`,platform-specific
 *           `bin/<platform>/`,root `bin/`). This catches the case observed
 *           on the round-3 Windows box:`ms-vscode.cpptools` is NOT installed
 *           but `openai.chatgpt` IS, shipping `rg.exe` at
 *           `bin/windows-x86_64/rg.exe`(not the canonical @vscode/ripgrep
 *           path).
 *        b. A `readdir` fallback that scans `.vscode/extensions` siblings
 *           for any extension with rg at one of the known layouts. Not relied
 *           on in production.
 *   4. Bare `"rg"`(trust PATH;POSIX or systems with rg installed).
 *
 * Returns the resolved path if a file exists at step 1/2/3, otherwise returns
 * `"rg"` and lets execFile fail at call time(the caller maps ENOENT to
 * SOURCE_UNAVAILABLE). This keeps the resolver **pure / cheap** — no exec probe
 * per call.
 */
function resolveRipgrepBinary(): string {
	// 1. Explicit env override.
	const envPath = process.env.ZERO_CORE_RIPGREP_PATH;
	if (envPath && existsSync(envPath)) return envPath;

	const isWin = platform === "win32";
	const exe = isWin ? "rg.exe" : "rg";

	// 2. Bundled under ZERO_CORE_DIR/bin.
	const bundled = join(ZERO_CORE_DIR, "bin", exe);
	if (existsSync(bundled)) return bundled;

	// 3. VS Code extension binary (best-effort; dev-only). Round-3 FIX 3.
	try {
		const vscodeExt = join(homedir(), ".vscode", "extensions");
		if (existsSync(vscodeExt)) {
			// Platform sub-directory used by extensions that ship per-OS rg
			// binaries (observed: openai.chatgpt's `bin/windows-x86_64/rg.exe`).
			const platformDir = isWin
				? "windows-x86_64"
				: (platform === "darwin"
					? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x86_64")
					: "linux-x86_64");

			// Layouts an extension might ship rg under, ordered by likelihood.
			const tryLayouts = (extRoot: string): string | null => {
				const layouts = [
					// Canonical @vscode/ripgrep layout (most common).
					join(extRoot, "node_modules", "@vscode", "ripgrep", "bin", exe),
					// Per-OS subdir (observed for openai.chatgpt).
					join(extRoot, "bin", platformDir, exe),
					// Flat bin/ (some extensions skip the platform subdir).
					join(extRoot, "bin", exe),
					// Top-level (rare, but cheap to check).
					join(extRoot, exe),
				];
				for (const p of layouts) {
					if (existsSync(p)) return p;
				}
				return null;
			};

			// 3a. Curated list of known rg-shipping extensions. Order = rough
			//     popularity guess. The extension dir name may be suffixed
			//     with `-<version>-<platform>`(e.g.`openai.chatgpt-26.707.
			//     91948-win32-x64`),so we match by prefix.
			const knownRgExtensionPrefixes = [
				"ms-vscode.cpptools",
				"openai.chatgpt",
				"GitHub.copilot",
				"GitHub.copilot-chat",
				"ms-vscode-remote.remote-ssh",
				"ms-vscode.git",
				"vscode.git",
			];
			// 3b. single readdir pass — collect extension dir names once, then:
			//     (i)  check each curated prefix's first matching dir,
			//     (ii) fall back to scanning all extension dirs for any rg at
			//          a known layout. Bounded:readdir + at most 4
			//          existsSync per dir.
			let entries: string[] = [];
			try {
				entries = readdirSync(vscodeExt, { encoding: "utf-8", withFileTypes: false });
			} catch {
				entries = [];
			}
			const extDirs = entries.filter((n) => !n.startsWith("."));
			// (i) curated prefixes first.
			for (const prefix of knownRgExtensionPrefixes) {
				// Multiple installed versions sort lexicographically; pick the
				// last (most recent semver-ish) first.
				const matches = extDirs.filter((n) => n === prefix || n.startsWith(prefix + "-"));
				for (let i = matches.length - 1; i >= 0; i--) {
					const hit = tryLayouts(join(vscodeExt, matches[i]));
					if (hit) return hit;
				}
			}
			// (ii) any extension shipping rg under a known layout.
			for (const extName of extDirs) {
				const hit = tryLayouts(join(vscodeExt, extName));
				if (hit) return hit;
			}
		}
	} catch {
		// ignore — homedir() can throw in unusual environments.
	}

	// 4. Bare rg on PATH.
	return "rg";
}

/** Cached resolution — env/filesystem won't change during a process lifetime. */
let cachedRipgrepBinary: string | null = null;
function getCachedRipgrepBinary(): string {
	if (cachedRipgrepBinary === null) {
		cachedRipgrepBinary = resolveRipgrepBinary();
		if (cachedRipgrepBinary !== "rg") {
			log.debug("wiki-source-search", `ripgrep resolved to ${cachedRipgrepBinary}`);
		}
	}
	return cachedRipgrepBinary;
}

// ---------------------------------------------------------------------------
// Constants — limits (plan-03 §8)
// ---------------------------------------------------------------------------

/** regex pattern 上限(UTF-8 bytes)。超 → REGEX_LIMIT_EXCEEDED。 */
export const SOURCE_SEARCH_MAX_PATTERN_BYTES = 2048;

/** ripgrep 子进程默认超时。超 → REGEX_TIMEOUT。 */
export const SOURCE_SEARCH_TIMEOUT_MS = 2000;

/** ripgrep 输出字节上限。超 → REGEX_LIMIT_EXCEEDED。 */
export const SOURCE_SEARCH_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** 默认返回结果数上限。 */
export const SOURCE_SEARCH_MAX_RESULTS = 200;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** 搜索模式(plan-03 §8)。 */
export type SourceSearchMode = "exact" | "substring" | "glob" | "regex";

/**
 * 源码搜索请求。**不含 cwd** —— host 由 binding 派生(plan-03 §8)。
 */
export interface SourceSearchRequest {
	/** Project / repository 维度。projectId 优先;二者至少一个。 */
	projectId?: string;
	repositoryId?: string;
	/** 搜索模式(默认 substring)。 */
	mode?: SourceSearchMode;
	/** pattern(exact/substring = 字面量;glob = ripgrep glob;regex = PCRE/V8)。 */
	pattern: string;
	/** case-sensitive(默认 false)。 */
	caseSensitive?: boolean;
	/** scope(相对 source_root 的子树;"." 或 "" 表示全 source_root)。 */
	scope?: string;
	/** 返回上限(默认 200;最大 200)。 */
	limit?: number;
	/** 上一页 cursor;首次 null。 */
	cursor?: string | null;
	/** 搜工作区版本(默认 false = indexed HEAD)。 */
	workspace?: boolean;
	/** 仅在指定 source_kind 的文件搜(默认不限)。 */
	sourceKinds?: string[];
	/** glob 文件过滤(ripgrep `--glob`);默认不限。 */
	fileGlobs?: string[];
}

/** 一条搜索结果 hit。 */
export interface SourceSearchHit {
	/** Wiki canonical path(从 binding.source_path 反推)。 */
	nodePath: string;
	/** 仓库相对 path。 */
	sourcePath: string;
	/** 1-based 行号。 */
	line: number;
	/** 匹配行文本(已 trim 超长;非全文)。 */
	text: string;
	/** 列起始(0-based)。 */
	columnStart: number;
	/** 列结束(0-based;exclusive)。 */
	columnEnd: number;
	/** 来源: indexed = HEAD 的 git tree;workspace = dirty 工作区。 */
	origin: "indexed" | "workspace";
	/** 是否属于未提交版本(workspace mode 必 true)。 */
	dirty: boolean;
	/** source_kind(从 binding 读)。 */
	sourceKind: string | null;
	/** blob_oid(indexed 模式从 binding 读;workspace 模式 null)。 */
	blobOid: string | null;
	/** indexed_revision(从 binding / repository 读)。 */
	indexedRevision: string | null;
}

/** 搜索结果。 */
export interface SourceSearchResult {
	/** 实际返回的 hits。 */
	hits: SourceSearchHit[];
	/** 下一页 cursor;null = 末尾。 */
	cursor: string | null;
	/** 是否还有更多。 */
	hasMore: boolean;
	/** 实际生效的限制(供 UI 显示)。 */
	limits: {
		patternBytes: number;
		timeoutMs: number;
		outputBytes: number;
		maxResults: number;
	};
	/** 搜索来源(workspace/indexed)。 */
	origin: "indexed" | "workspace";
	/** 仓库稳定 ID。 */
	repositoryId: string;
	/** 搜索的 scope(实际生效的相对 root)。 */
	effectiveScope: string;
}

/**
 * 失败结果(error 与 result 分开;返回 throw 不利于 caller 区分 timeout/limit/normal)。
 */
export type SourceSearchOutcome =
	| { ok: true; result: SourceSearchResult }
	| { ok: false; code: "REGEX_INVALID" | "REGEX_LIMIT_EXCEEDED" | "REGEX_TIMEOUT" | "NOT_FOUND" | "SOURCE_UNAVAILABLE"; message: string };

// ---------------------------------------------------------------------------
// WikiSourceSearch
// ---------------------------------------------------------------------------

/**
 * 依赖。
 */
export interface WikiSourceSearchDeps {
	readonly nodeRepo: WikiNodeRepository;
	readonly repositoryStore: WikiRepositoryStore;
	/** projectId → workspaceDir(从 ProjectStore 派生)。 */
	readonly resolveWorkspace: (projectId: string) => string | undefined;
	/**
	 * 可选:用于覆盖 ripgrep binary 路径(测试 mock)。生产用 PATH 解析。
	 */
	readonly ripgrepBinary?: string;
}

/**
 * WikiSourceSearch —— 源码搜索 ripgrep 封装。每次 search 走一次 rg 子进程。
 *
 * cwd-by-binding(plan-03 §8):**不接受 caller 提供 cwd**。host 从 binding +
 * workspaceDir 派生;scope 转 `-g`/path 限定。
 */
export class WikiSourceSearch {
	private readonly deps: WikiSourceSearchDeps;

	constructor(deps: WikiSourceSearchDeps) {
		this.deps = deps;
	}

	async search(req: SourceSearchRequest): Promise<SourceSearchOutcome> {
		// 1. 解析 repository + workspace。
		const repo = this.lookupRepository(req);
		if (!repo) {
			return { ok: false, code: "NOT_FOUND", message: "repository binding not found" };
		}
		const workspace = this.deps.resolveWorkspace(repo.project_id);
		if (!workspace) {
			return { ok: false, code: "SOURCE_UNAVAILABLE", message: "workspace directory unavailable" };
		}

		// 2. 计算 effectiveScope = source_root + req.scope(必须不能逃逸)。
		const effectiveScope = computeEffectiveScope(repo.source_root, req.scope ?? "");
		if (effectiveScope === null) {
			return { ok: false, code: "REGEX_INVALID", message: `scope escapes source_root: ${req.scope}` };
		}

		// 3. 校验 pattern size。
		const patternBytes = Buffer.byteLength(req.pattern, "utf-8");
		if (req.mode === "regex" && patternBytes > SOURCE_SEARCH_MAX_PATTERN_BYTES) {
			return {
				ok: false,
				code: "REGEX_LIMIT_EXCEEDED",
				message: `regex pattern too long: ${patternBytes} > ${SOURCE_SEARCH_MAX_PATTERN_BYTES} bytes`,
			};
		}
		// 4. 构造 ripgrep argv(no shell; literal argv vector)。
		const mode = req.mode ?? "substring";
		const argv = buildRipgrepArgv({
			mode,
			pattern: req.pattern,
			caseSensitive: req.caseSensitive ?? false,
			effectiveScope,
			fileGlobs: req.fileGlobs,
		});
		// 起始 cwd = workspace(plan-03 §8:不能由模型提供)。
		// Binary 选择:caller 显式注入 > 缓存 resolver(env/bundle/VSCode/PATH)。
		// CONCERN 9:rg 不在 PATH 时(Windows 默认)reolver 找 bundled 或 env。
		argv.unshift(this.deps.ripgrepBinary ?? getCachedRipgrepBinary());

		// 5. 跑子进程 + capture stdout/stderr/exit。
		const limit = clamp(req.limit ?? SOURCE_SEARCH_MAX_RESULTS, 1, SOURCE_SEARCH_MAX_RESULTS);
		let raw: Buffer;
		try {
			raw = await runSubprocess(argv, workspace, SOURCE_SEARCH_TIMEOUT_MS, SOURCE_SEARCH_MAX_OUTPUT_BYTES);
		} catch (err) {
			const e = err as Error & { code?: string | number; signal?: string; stderr?: string };
			// ripgrep exit codes: 0 = 有匹配;1 = 无匹配;2 = error。
			// ENOENT(二进制不存在)/ EACCES / EISDIR → SOURCE_UNAVAILABLE
			// (CONCERN 9:不 crash;caller 看到 SOURCE_UNAVAILABLE 可降级)。
			if (typeof e.code === "string" && (e.code === "ENOENT" || e.code === "EACCES" || e.code === "EISDIR")) {
				return {
					ok: false,
					code: "SOURCE_UNAVAILABLE",
					message: `ripgrep binary unavailable (code=${e.code}): ${argv[0]}`,
				};
			}
			// 我们用 timeout / maxBuffer 区分。
			if (e.signal === "SIGTERM" || e.message.includes("maxBuffer")) {
				const code = e.message.includes("maxBuffer")
					? "REGEX_LIMIT_EXCEEDED"
					: "REGEX_TIMEOUT";
				return {
					ok: false,
					code,
					message: `ripgrep exceeded ${code === "REGEX_TIMEOUT" ? "timeout" : "output limit"}`,
				};
			}
			return {
				ok: false,
				code: "REGEX_INVALID",
				message: `ripgrep failed: ${e.message ?? "(no message)"}`,
			};
		}

		// 6. 解析 output(ripgrep `--column --line-number --no-heading --color never` + NUL 分隔,
		// 不走 JSON(避免 json 解析开销 + 字段裁剪简单))。每行 `path:line:col:content`。
		const text = raw.toString("utf-8");
		const lines = text.split(/\r?\n/).filter(Boolean);
		const origin: "indexed" | "workspace" = req.workspace ? "workspace" : "indexed";

		// 预取 repository 全部 binding(source_path → row + node_id → node path),
		// 一次性 load 避免每条 hit 一次 SQL(plan-03 §8 results→canonical path)。
		const bindingByPath = new Map<string, WikiSourceBindingRow>();
		const nodePathById = new Map<number, string>();
		for (const b of this.deps.repositoryStore.sourceBindings.listByRepository(repo.repository_id)) {
			bindingByPath.set(b.source_path, b);
		}
		// 只对 hit 出现的 node_id 查 nodeRepo path(懒)。
		const parsedAll = lines.map((line) => parseHitLine(line, repo, origin, bindingByPath, this.deps.nodeRepo, nodePathById)).filter((h): h is SourceSearchHit => h !== null);

		// 7. cursor 解析(简化:用 hit index 做 cursor;有 loss 但稳定)。
		const cursorIdx = parseCursor(req.cursor ?? null);
		const startIdx = cursorIdx;
		const endIdx = Math.min(startIdx + limit, parsedAll.length);
		const hits = parsedAll.slice(startIdx, endIdx);
		const hasMore = endIdx < parsedAll.length;
		const nextCursor = hasMore ? encodeCursor(endIdx) : null;

		return {
			ok: true,
			result: {
				hits,
				cursor: nextCursor,
				hasMore,
				limits: {
					patternBytes: SOURCE_SEARCH_MAX_PATTERN_BYTES,
					timeoutMs: SOURCE_SEARCH_TIMEOUT_MS,
					outputBytes: SOURCE_SEARCH_MAX_OUTPUT_BYTES,
					maxResults: SOURCE_SEARCH_MAX_RESULTS,
				},
				origin,
				repositoryId: repo.repository_id,
				effectiveScope,
			},
		};
	}

	private lookupRepository(req: SourceSearchRequest): WikiRepositoryRow | undefined {
		if (req.repositoryId) {
			return this.deps.repositoryStore.repositories.getById(req.repositoryId);
		}
		if (req.projectId) {
			return this.deps.repositoryStore.repositories.getByProjectId(req.projectId);
		}
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/**
 * 构造 ripgrep argv(no shell)。所有 user input 走字面 argv,不经 shell 拼接。
 */
function buildRipgrepArgv(input: {
	mode: SourceSearchMode;
	pattern: string;
	caseSensitive: boolean;
	effectiveScope: string;
	fileGlobs?: string[];
}): string[] {
	const argv: string[] = [];
	// 行号 + 列号 + 不着色 + 不聚合 heading + NUL 分隔可选。
	argv.push("--line-number", "--column", "--color", "never", "--no-heading");
	// case sensitive(默认 ripgrep smart-case;-i 关 smart-case)。
	if (!input.caseSensitive) argv.push("-i"); else argv.push("-S");
	// 模式 → ripgrep flag。
	//   exact:   `-w --fixed-words`?ripgrep 无 --fixed-words;用 `-F -w`(whole word fixed)。
	//   substring: `-F`(fixed strings)。多 token 用 `\n` join → ripgrep 视为多个固定模式(OR)。
	//   glob:    `-g <pattern>`(ripgrep 把 glob 当 path filter,不是 regex)。把 pattern 作 path filter。
	//   regex:   默认 PCRE2 (V8) —— ripgrep 默认是 rust regex;`-P` 启用 PCRE2。
	// 这里我们对 exact/substring 用 -F;对 regex 用默认 rust regex(安全 + 足够);
	// glob 把 pattern 作为附加 -g 路径过滤 + substring 默认模式。
	switch (input.mode) {
		case "exact":
			argv.push("-F", "-w", input.pattern);
			break;
		case "substring":
			argv.push("-F", input.pattern);
			break;
		case "glob":
			// glob 模式:pattern 是 path glob;ripgrep 把它放 -g,主 pattern 用 `""`(match any)。
			// 实际:用户想"找文件名匹配 X 的文件 → 列所有"。本处返回 path-only hit。
			argv.push("-g", input.pattern);
			argv.push(""); // match any
			break;
		case "regex":
			argv.push(input.pattern);
			break;
	}
	// file globs 过滤(附加)。
	if (input.fileGlobs) {
		for (const g of input.fileGlobs) argv.push("-g", g);
	}
	// scope path(放在最后;作用是 ripgrep 的搜索 root)。
	argv.push(input.effectiveScope || ".");
	return argv;
}

/**
 * 跑子进程 + maxBuffer / timeout。SIGTERM on timeout;maxBuffer 触发 ENOBUFS error。
 */
function runSubprocess(
	argv: string[],
	cwd: string,
	timeoutMs: number,
	maxBytes: number,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = execFile(argv[0], argv.slice(1), {
			cwd,
			timeout: timeoutMs,
			maxBuffer: maxBytes,
			encoding: null, // Buffer
			windowsHide: true,
		}, (err, stdout, _stderr) => {
			if (err) {
				// ripgrep 退出码 1 = 无匹配 → 视为空结果(不是错误)。
				if ("code" in err && (err as { code?: number }).code === 1) {
					resolve(Buffer.alloc(0));
					return;
				}
				reject(err);
				return;
			}
			resolve(stdout as unknown as Buffer);
		});
		// 防止 zombie。
		child.on("error", (e) => reject(e));
	});
}

/**
 * 解析 ripgrep 输出行 `<path>:<line>:<col>:<content>` → SourceSearchHit。
 * 路径含 `:` 时会被 ripgrep 处理(WINDOWS 下 `C:\foo\bar` → ripgrep 自身处理)。
 * 这里按"最后一个 `:` 在前 3 个之后"启发:先 split 限 4 段。
 */
function parseHitLine(
	rawLine: string,
	repo: WikiRepositoryRow,
	origin: "indexed" | "workspace",
	bindingByPath: Map<string, WikiSourceBindingRow>,
	nodeRepo: WikiNodeRepository,
	nodePathCache: Map<number, string>,
): SourceSearchHit | null {
	// path : line : col : content(ripgrep --column --line-number 格式)。
	const m = rawLine.match(/^(.*?):(\d+):(\d+):(.*)$/s);
	if (!m) return null;
	const [, pathPartRaw, lineStr, colStr, content] = m;
	const line = parseInt(lineStr, 10);
	const col = parseInt(colStr, 10);

	// **CONCERN 8 fix (round-3 FIX 2 reordered)**: ripgrep 对 cwd 根下的文件
	// 输出 `./file.ts`(对子目录输出 `./sub/file.ts`),但 wiki_source_bindings
	// .source_path 不带 `./` 前缀。binding 查找会失败 → hit.sourcePath/nodePath
	// 错。统一 strip 前缀。
	//
	// **Order matters (round-3 FIX 2, BLOCKER Windows)**: on Windows ripgrep
	// emits paths with backslash separators(`.\file.ts`,`.\sub\file.ts`)for
	// repo-root scope. round-2 stripped `./` BEFORE normalizing backslashes ——
	// the strip missed `.\`, then later `stripSourceRootPrefix` turned `.\file.ts`
	// into `./file.ts`, which survived into the binding lookup and FAILED
	// (bindings store `file.ts`). Every repo-root-scope Windows hit was broken.
	//
	// Fix: normalize `\` → `/` FIRST, then strip leading `./`. After this the
	// path matches the bindings' forward-slash form regardless of OS.
	const pathPartNormalized = pathPartRaw.replace(/\\/g, "/");
	const pathPart = pathPartNormalized.startsWith("./")
		? pathPartNormalized.slice(2)
		: pathPartNormalized;

	// 把 path(workspace 相对)转 source_root 剥离后的 repo 相对 path。
	const repoRelative = stripSourceRootPrefix(pathPart, repo.source_root);
	const binding = bindingByPath.get(repoRelative);
	const sourcePath = binding?.source_path ?? repoRelative;

	// Wiki canonical path:从 binding.node_id → nodeRepo 节点 path(带 cache)。
	let nodePath = "";
	if (binding) {
		nodePath = nodePathCache.get(binding.node_id) ?? "";
		if (!nodePath) {
			const nodeRow = nodeRepo.getById(binding.node_id);
			if (nodeRow) {
				nodePath = nodeRow.path;
				nodePathCache.set(binding.node_id, nodePath);
			}
		}
	}

	return {
		nodePath: nodePath || `wiki-root/projects/${repo.project_id}/${repoRelative}`,
		sourcePath,
		line,
		text: content.length > 500 ? content.slice(0, 500) + "…" : content,
		columnStart: col - 1,
		columnEnd: col - 1 + (content.length > 0 ? 1 : 0),
		origin,
		dirty: origin === "workspace",
		sourceKind: binding?.source_kind ?? null,
		blobOid: origin === "indexed" ? (binding?.blob_oid ?? null) : null,
		indexedRevision: origin === "indexed" ? (binding?.indexed_revision ?? repo.indexed_revision) : null,
	};
}

/**
 * 剥离 source_root 前缀(若 source_root 非空且 path 以其开头)。
 * 不严格段基匹配(只是 prefix-strip);精确性由 binding 查找兜底。
 */
function stripSourceRootPrefix(path: string, sourceRoot: string): string {
	if (!sourceRoot) return path.replace(/\\/g, "/");
	const normalizedPath = path.replace(/\\/g, "/");
	const normalizedRoot = sourceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	if (normalizedPath.startsWith(normalizedRoot + "/")) {
		return normalizedPath.slice(normalizedRoot.length + 1);
	}
	return normalizedPath;
}

/**
 * scope = source_root + req.scope。返回 ripgrep 接受的 path(workspace 相对)。
 * 越界(scope 含 `..` 或绝对路径)→ null。
 */
function computeEffectiveScope(sourceRoot: string, reqScope: string): string | null {
	const root = normalizeScopeSeg(sourceRoot);
	const scope = normalizeScopeSeg(reqScope);
	if (scope === null) return null;
	if (root === null) return null;
	// 段基拼接。
	const rootSegs = root ? root.split("/").filter(Boolean) : [];
	const scopeSegs = scope ? scope.split("/").filter(Boolean) : [];
	const combined = [...rootSegs, ...scopeSegs];
	return combined.length === 0 ? "." : combined.join("/");
}

function normalizeScopeSeg(s: string): string | null {
	const trimmed = (s ?? "").trim();
	if (!trimmed || trimmed === "." || trimmed === "/") return "";
	// 拒绝 `..` 段、绝对路径、反斜线。
	if (/^[\\/]/.test(trimmed)) return null;
	if (trimmed.includes("\\")) return null;
	for (const seg of trimmed.split("/")) {
		if (seg === ".." || seg === ".") {
			if (seg === "..") return null;
			continue;
		}
	}
	return trimmed.replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function encodeCursor(idx: number): string {
	return Buffer.from(JSON.stringify({ i: idx }), "utf-8").toString("base64");
}

function parseCursor(c: string | null): number {
	if (!c) return 0;
	try {
		const j = Buffer.from(c, "base64").toString("utf-8");
		const parsed = JSON.parse(j);
		if (typeof parsed?.i === "number" && parsed.i >= 0) return parsed.i;
	} catch {
		// 非法 cursor → 从头开始。
	}
	return 0;
}

// 未使用 import 警告抑制(join 用于 argv 拼接 fallback)。
void join;
void log;
