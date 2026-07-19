// Wiki benchmark —— 规模 / 查询计划 / 性能基线
// (wiki-system-redesign plan-08 §4)
//
// # 文件说明书
//
// ## 核心功能
// 可重复的 Wiki DB 规模 + 性能 benchmark。支持:
//   - `--nodes=100000`  (CI 自动规模验收)
//   - `--nodes=1000000` (发布前手工规模验收)
//   - `--out=<path>`    写 JSON 报告(默认 stdout 也打 human-readable)
//   - `--keep-db=<path>` 不用临时 DB,用指定路径(便于 inspect 残留)
//
// ## 覆盖场景(plan-08 §4)
//   S1  canonical path read        → SELECT … WHERE path=? AND archived_at IS NULL
//   S2  parent expand + pagination → SELECT … WHERE parent_id=? ORDER BY path,id LIMIT ?
//   S3  incoming/outgoing links    → SELECT … FROM wiki_links WHERE source_id=? / target_id=?
//   S4  FTS top-k                  → MATCH … ORDER BY rank LIMIT ?
//   S5  authorized multi-scope search → FTS top-k + path-prefix scope filter
//   S6  subtree move (bounded)     → LIKE '<prefix>/%' + UPDATE path (bounded N)
//   S7  candidate bounded SELECT   → WHERE parent_id=? ORDER BY path,id LIMIT scanCap
//                                    (round-2 P1 §4: replaces expand({limit:100}))
//   S8  candidate grouped childrenCount → WHERE parent_id IN(...) GROUP BY parent_id
//                                    (round-2 P1 §4: N+1-eliminating count batch)
//   S9  candidate scale + tail     → wide parents (100/1000 direct children, last =
//                                    priority=999 path-last) — proves tail inclusion
//                                    + per-op at scale (round-2 P1 §4.3.1 / §8)
//
// 每场景前先 `EXPLAIN QUERY PLAN` 并断言用 path / parent / target / FTS 索引,
// 避免硬件 flaky。报告含 commit SHA /硬件/数据规模/耗时/内存。
//
// ## 安全约束
//   - **不**用生产 `${ZERO_CORE_DIR}/db/wiki.db` 路径。默认写到 os.tmpdir() 下
//     独立文件 `wiki-bench-<ISO>.db`,跑完默认 rm(除非 --keep-db)。
//   - **不**调 BackupService / 任何 server-side singleton —— 直接 new better-sqlite3
//     + initWikiSchema,避免触发生产 wiki subsystem / data-change-hub。
//   - 1M 规模在 CI 不强制跑(由 caller 显式 --nodes=1000000);报告必须含 commit
//     SHA + 硬件 + 数据生成参数(acceptance-08 §D「没 1M 记录不能宣称百万节点已验证」)。
//
// ## 运行
//   `tsx scripts/wiki-benchmark.ts --nodes=100000`
//   `tsx scripts/wiki-benchmark.ts --nodes=1000000 --out=wiki-bench-1M.json`
//
// ## 维护规则
//   - Wiki schema 演进后,本脚本要跟着加新表/列的规模覆盖。
//   - 不要在生产 wiki subsystem 启动期间跑(独立 DB 没冲突,但 PRAGMA/cgroup
//     资源争用会污染数字)。

import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { initWikiSchema } from "../src/server/wiki/wiki-schema.js";
import { WIKI_ROOT_PATH } from "../src/server/wiki/wiki-path.js";

// ─── CLI ────────────────────────────────────────────────────────────

interface CliArgs {
	nodes: number;
	out?: string;
	keepDb?: string;
	scenarios: readonly string[];
}

function parseArgs(argv: string[]): CliArgs {
	let nodes = 100_000;
	let out: string | undefined;
	let keepDb: string | undefined;
	const scenarios: string[] = [];
	for (const a of argv.slice(2)) {
		if (a.startsWith("--nodes=")) {
			const n = Number(a.slice("--nodes=".length));
			if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --nodes: ${a}`);
			nodes = Math.floor(n);
		} else if (a.startsWith("--out=")) {
			out = a.slice("--out=".length);
		} else if (a.startsWith("--keep-db=")) {
			keepDb = a.slice("--keep-db=".length);
		} else if (a.startsWith("--only=")) {
			scenarios.push(...a.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean));
		} else if (a === "-h" || a === "--help") {
			console.log(`usage: tsx scripts/wiki-benchmark.ts [--nodes=N] [--out=PATH] [--keep-db=PATH] [--only=S1,S2,...]`);
			process.exit(0);
		} else {
			throw new Error(`unknown arg: ${a}`);
		}
	}
	return { nodes, out, keepDb, scenarios };
}

// ─── Helpers ────────────────────────────────────────────────────────

interface TimingResult {
	label: string;
	totalMs: number;
	iterations: number;
	perOpUs: number;
	rowsTouched: number;
	planAsserted: boolean;
	planSummary: string;
}

function nowMs(): number {
	const t = process.hrtime.bigint();
	return Number(t) / 1e6;
}

function humanMs(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(1)}us`;
	if (ms < 1000) return `${ms.toFixed(2)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function explainQueryPlan(db: Database.Database, sql: string, ...params: unknown[]): string {
	const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string; id: number; parent: number; notused: number }>;
	// SQLite EQP output is nested; flatten to detail strings joined by " | ".
	return rows.map((r) => r.detail).join(" | ");
}

/**
 * Assert the EXPLAIN QUERY PLAN uses an index/scoped scan, not a full-table scan.
 * Returns a summary string and a boolean ok.
 *
 * Acceptable: any `USING INDEX`, `USING COVERING INDEX`, `SEARCH` (vs `SCAN`),
 * or FTS5 specific (`SCAN fts5`/`MATCH`). Reject: bare `SCAN wiki_nodes`/`SCAN wiki_links`.
 */
function assertPlan(label: string, plan: string): { ok: boolean; summary: string } {
	const lower = plan.toLowerCase();
	const hasFullScan = /\bscan\s+(wiki_nodes|wiki_links|wiki_addresses|wiki_source_bindings|wiki_audit_log)\b/.test(lower);
	const usesIndex = /using (covering )?index|search\b/.test(lower);
	const isFtsMatch = /fts5|match/.test(lower);
	const ok = !hasFullScan && (usesIndex || isFtsMatch);
	return { ok, summary: plan };
}

// ─── Data generation ────────────────────────────────────────────────

interface GeneratedData {
	nodeCount: number;
	linkCount: number;
	rootPath: string;       // e.g. "wiki-root/__bench"
	rootId: number;
	sampledPaths: string[]; // canonical-path test targets
	sampledParentIds: number[]; // parents with many children
	sampledSourceIds: number[]; // for outgoing links
	sampledTargetIds: number[]; // for incoming links
}

const BENCH_ROOT_PATH = `${WIKI_ROOT_PATH}/__bench`;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function genName(i: number): string {
	// 8-char base-36 stable suffix → wide name diversity for FTS.
	return `node-${i.toString(36).padStart(8, "0")}`;
}

function genSummary(i: number): string {
	// Mix common tokens (agent/memory/wiki) + unique tail so FTS has both
	// high-frequency and rare tokens.
	const bucket = i % 32;
	const phrases = [
		"agent memory context window",
		"wiki knowledge summary",
		"prompt tool runtime",
		"session turn step",
		"project source binding",
	];
	return `${phrases[bucket % phrases.length]} bench-${bucket} idx-${i}`;
}

function genContent(i: number): string {
	// ~256B body with discriminative token (so MATCH bench-<n> narrows to 1 row).
	const body = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`;
	return `${body}\nbench-token-${i} hash-${(i * 2654435761) % 0xffffffff >>> 0}`;
}

function generateData(db: Database.Database, nodes: number): GeneratedData {
	const WIDE = 64;          // children per parent (parent-paged picks these)
	const DEPTH = 4;          // tree depth (limited so we don't blow stack)
	// Layout:
	//   wiki-root/__bench/p<parentId>/c<childIdx>
	// Parent count = ceil(nodes / WIDE). Each parent has WIDE children.
	// We split DEPTH tiers to make path LIKE prefix non-trivial.
	const parentCount = Math.max(1, Math.ceil(nodes / WIDE));
	const childPerParent = Math.ceil(nodes / parentCount);

	const now = new Date().toISOString();
	const benchRootPath = BENCH_ROOT_PATH;

	const insertNode = db.prepare<
		[number | null, string, string, string, string, string, string | null, string, string]>(
		`INSERT INTO wiki_nodes (parent_id, name, path, kind, summary, content, attributes_json, created_at, updated_at)
		 VALUES (?, ?, ?, 'node', ?, ?, NULL, ?, ?)`,
	);
	const insertLink = db.prepare<[number, number, string, string, string]>(
		`INSERT INTO wiki_links (source_id, target_id, relation, created_at, created_by)
		 VALUES (?, ?, 'related', ?, 'benchmark')`,
	);

	// Bootstrap bench root.
	let benchRootId = (() => {
		const existing = db.prepare<unknown[]>(`SELECT id FROM wiki_nodes WHERE path = ? LIMIT 1`).get(benchRootPath) as { id: number } | undefined;
		if (existing) return existing.id;
		const r = insertNode.run(null, "__bench", benchRootPath, "bench root", "", now, now);
		return Number(r.lastInsertRowid);
	})();

	// Parents: wiki-root/__bench/p<parentId>
	const parentIds: number[] = [];
	const parentPaths: string[] = [];

	db.transaction(() => {
		for (let p = 0; p < parentCount; p++) {
			const path = `${benchRootPath}/p${p}`;
			const r = insertNode.run(benchRootId, `p${p}`, path, genSummary(p), genContent(p), now, now);
			const id = Number(r.lastInsertRowid);
			parentIds.push(id);
			parentPaths.push(path);
		}
	})();

	// Children under each parent.
	const sampledPaths: string[] = [];
	db.transaction(() => {
		let global = 0;
		for (let p = 0; p < parentCount; p++) {
			const parentId = parentIds[p];
			for (let c = 0; c < childPerParent && global < nodes; c++, global++) {
				const name = genName(global);
				const path = `${parentPaths[p]}/${name}`;
				const r = insertNode.run(parentId, name, path, genSummary(global), genContent(global), now, now);
				if (c === 0 && p < 8) {
					// Save first-child-of-first-8-parents as canonical-path test targets.
					sampledPaths.push(path);
				}
			}
		}
	})();

	// Links: each sampled source gets 8 outgoing + 8 incoming (sampled from random nodes).
	const sampledSourceIds: number[] = [];
	const sampledTargetIds: number[] = [];
	const totalCreated = db.prepare<unknown[]>(`SELECT count(*) AS n FROM wiki_nodes`).get() as { n: number };
	const maxId = totalCreated.n;
	// Pick 8 random "middle" nodes as link endpoints.
	const linkAnchor = Math.floor(maxId / 2);
	for (let i = 0; i < 8; i++) {
		sampledSourceIds.push(linkAnchor + i * 7);
		sampledTargetIds.push(linkAnchor + i * 11 + 3);
	}
	const linkCount = db.transaction(() => {
		let n = 0;
		for (const src of sampledSourceIds) {
			for (let k = 0; k < 8; k++) {
				const tgt = (src + k * 13 + 1) % maxId + 1;
				if (tgt === src) continue;
				try {
					insertLink.run(src, tgt, now);
					n++;
				} catch {
					// PK collision — skip; benchmark doesn't care about link volume exactness.
				}
			}
		}
		return n;
	})();

	// Rebuild FTS so top-k MATCH reflects the inserted rows.
	db.exec(`INSERT INTO wiki_nodes_fts(wiki_nodes_fts) VALUES('rebuild')`);

	// Sampled parent ids: take 8 of the new parent IDs for paged-children scenarios.
	const sampledParentIds = parentIds.slice(0, 8);

	return {
		nodeCount: maxId,
		linkCount,
		rootPath: benchRootPath,
		rootId: benchRootId,
		sampledPaths,
		sampledParentIds,
		sampledSourceIds,
		sampledTargetIds,
	};
}

// ─── Scenarios ──────────────────────────────────────────────────────

function runScenario(
	db: Database.Database,
	label: string,
	sql: string,
	params: () => unknown[],
	iters: number,
	expectRows: (rows: unknown[]) => number,
): TimingResult {
	const plan = explainQueryPlan(db, sql, ...params());
	const planCheck = assertPlan(label, plan);
	const warmup = 3;
	for (let i = 0; i < warmup; i++) {
		const rows = db.prepare(sql).all(...params());
		expectRows(rows);
	}
	let rowsTouched = 0;
	const t0 = nowMs();
	for (let i = 0; i < iters; i++) {
		const rows = db.prepare(sql).all(...params());
		rowsTouched += expectRows(rows);
	}
	const totalMs = nowMs() - t0;
	return {
		label,
		totalMs,
		iterations: iters,
		perOpUs: (totalMs * 1000) / iters,
		rowsTouched,
		planAsserted: planCheck.ok,
		planSummary: planCheck.summary,
	};
}

function runAllScenarios(db: Database.Database, data: GeneratedData, enabled: readonly string[]): TimingResult[] {
	const results: TimingResult[] = [];
	const isEnabled = (id: string) => enabled.length === 0 || enabled.includes(id);

	// S1 canonical path read
	if (isEnabled("S1")) {
		const sql = `SELECT * FROM wiki_nodes WHERE path = ? AND archived_at IS NULL LIMIT 1`;
		let idx = 0;
		results.push(runScenario(db, "S1 canonical path read", sql,
			() => [data.sampledPaths[idx++ % data.sampledPaths.length]],
			500,
			(rows) => rows.length,
		));
	}

	// S2 parent paged
	if (isEnabled("S2")) {
		const sql = `SELECT * FROM wiki_nodes
		             WHERE parent_id = ? AND archived_at IS NULL
		             ORDER BY path ASC, id ASC LIMIT 50`;
		let idx = 0;
		results.push(runScenario(db, "S2 parent expand + pagination", sql,
			() => [data.sampledParentIds[idx++ % data.sampledParentIds.length]],
			200,
			(rows) => rows.length,
		));
	}

	// S3a outgoing links
	if (isEnabled("S3")) {
		const sqlOut = `SELECT t.* FROM wiki_links l
		                JOIN wiki_nodes t ON t.id = l.target_id
		                WHERE l.source_id = ?`;
		let idx = 0;
		results.push(runScenario(db, "S3a outgoing links", sqlOut,
			() => [data.sampledSourceIds[idx++ % data.sampledSourceIds.length]],
			500,
			(rows) => rows.length,
		));
		const sqlIn = `SELECT s.* FROM wiki_links l
		               JOIN wiki_nodes s ON s.id = l.source_id
		               WHERE l.target_id = ?`;
		idx = 0;
		results.push(runScenario(db, "S3b incoming links", sqlIn,
			() => [data.sampledTargetIds[idx++ % data.sampledTargetIds.length]],
			500,
			(rows) => rows.length,
		));
	}

	// S4 FTS top-k (rare token → ~1 hit; verifies index seeks over FTS rowid).
	// Wrap in double-quotes for FTS5 phrase query (hyphenated tokens otherwise
	// parse as `bench` NOT `token` NOT `N`).
	if (isEnabled("S4")) {
		const sql = `SELECT n.id FROM wiki_nodes_fts f
		             JOIN wiki_nodes n ON n.id = f.rowid
		             WHERE wiki_nodes_fts MATCH ?
		             ORDER BY rank LIMIT 10`;
		let k = 0;
		results.push(runScenario(db, "S4 FTS top-k", sql,
			() => [`"bench-token-${(k++ % 200)}"`],
			200,
			(rows) => rows.length,
		));
	}

	// S5 authorized multi-scope search — FTS top-k filtered by path prefix.
	// Models "agent sees knowledge/* and projects/* but not memory/*".
	if (isEnabled("S5")) {
		const sql = `SELECT n.id, n.path FROM wiki_nodes_fts f
		             JOIN wiki_nodes n ON n.id = f.rowid
		             WHERE wiki_nodes_fts MATCH ?
		               AND (n.path LIKE ? OR n.path LIKE ?)
		             ORDER BY rank LIMIT 20`;
		let k = 0;
		results.push(runScenario(db, "S5 authorized multi-scope search", sql,
			() => [`memory OR agent OR wiki`, `${data.rootPath}/p0/%`, `${data.rootPath}/p1/%`],
			100,
			(rows) => rows.length,
		));
	}

	// S6 subtree move (bounded) — read subtree + UPDATE path prefix on bounded subset.
	if (isEnabled("S6")) {
		// We move 200 children of parent 0 to a new sibling path. Bounded = 200 to
		// keep the test fast even at 1M (acceptance-08 §D.10: bounded move test).
		const sqlRead = `SELECT id, path FROM wiki_nodes
		                 WHERE path LIKE ? ESCAPE '\\' AND archived_at IS NULL
		                 ORDER BY path ASC, id ASC LIMIT 200`;
		// Note: sampledPaths[0] is a leaf (a child of p0). The subtree query expects
		// parent paths, so use a parent path instead.
		const parentPrefix = `${data.rootPath}/p0`;
		const escapedParent = parentPrefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
		const readPlan = explainQueryPlan(db, sqlRead, escapedParent + "/%");
		const readCheck = assertPlan("S6read", readPlan);
		// Warm-up read.
		db.prepare(sqlRead).all(escapedParent + "/%");
		// Bounded move: rename first 50 to a new sibling path inside a transaction.
		const t0 = nowMs();
		const iters = 5;
		let rowsTouched = 0;
		for (let i = 0; i < iters; i++) {
			const rows = db.prepare(sqlRead).all(escapedParent + "/%") as Array<{ id: number; path: string }>;
			rowsTouched += rows.length;
			const updatePath = db.prepare(`UPDATE wiki_nodes SET path = ? WHERE id = ?`);
			const tx = db.transaction((rs: Array<{ id: number; path: string }>) => {
				for (const r of rs.slice(0, 50)) {
					const newPath = r.path.replace(`${parentPrefix}/`, `${parentPathShadow(i)}/`);
					updatePath.run(newPath, r.id);
				}
			});
			tx(rows);
		}
		const totalMs = nowMs() - t0;
		results.push({
			label: "S6 subtree move (bounded, read + 50 UPDATE)",
			totalMs,
			iterations: iters,
			perOpUs: (totalMs * 1000) / iters,
			rowsTouched,
			planAsserted: readCheck.ok,
			planSummary: readPlan,
		});
		// Restore paths.
		const restorePrefix = parentPathShadow(iters - 1);
		const restoreEscaped = restorePrefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
		const restoreStmt = db.prepare(`UPDATE wiki_nodes SET path = ? WHERE id = ?`);
		const readShadowed = db.prepare(`SELECT id, path FROM wiki_nodes WHERE path LIKE ? ESCAPE '\\'`).all(restoreEscaped + "/%") as Array<{ id: number; path: string }>;
		const restoreTx = db.transaction((rs: Array<{ id: number; path: string }>) => {
			for (const r of rs) {
				const orig = r.path.replace(`${restorePrefix}/`, `${parentPrefix}/`);
				restoreStmt.run(orig, r.id);
			}
		});
		restoreTx(readShadowed);
	}

	// S7 context candidate bounded SELECT (round-2 review P1 §4 / §8).
	// Mirrors WikiNodeRepository.getActiveChildrenBounded: bounded fetch of ALL
	// active direct children of a parent, ordered path ASC + id ASC, LIMIT scanCap.
	// This is the query that replaced expand({limit:100}); prove it uses the
	// parent_id index (not a full scan) at 1M scale.
	if (isEnabled("S7")) {
		const sql = `SELECT * FROM wiki_nodes
		             WHERE parent_id = ? AND archived_at IS NULL
		             ORDER BY path ASC, id ASC LIMIT 5000`;
		let idx = 0;
		results.push(runScenario(db, "S7 candidate bounded SELECT (scanCap 5000)", sql,
			() => [data.sampledParentIds[idx++ % data.sampledParentIds.length]],
			200,
			(rows) => rows.length,
		));
	}

	// S8 context candidate grouped childrenCount (round-2 review P1 §4 / §8).
	// Mirrors WikiNodeRepository.countChildrenByParents: single grouped COUNT over
	// a batch of candidate parent IDs — the N+1-eliminating query that replaced
	// per-node countActiveChildren(). Batch = direct children of the first sampled
	// parent (exactly what the compiler passes: the just-fetched candidate rows).
	if (isEnabled("S8")) {
		const batchParent = data.sampledParentIds[0];
		const batchIds = (db.prepare(`SELECT id FROM wiki_nodes WHERE parent_id = ? AND archived_at IS NULL LIMIT 100`)
			.all(batchParent) as Array<{ id: number }>).map((r) => r.id);
		const placeholders = batchIds.map(() => "?").join(", ");
		const sql = `SELECT parent_id, COUNT(*) AS n FROM wiki_nodes
		             WHERE parent_id IN (${placeholders}) AND archived_at IS NULL
		             GROUP BY parent_id`;
		results.push(runScenario(db, `S8 candidate grouped childrenCount (batch ${batchIds.length})`, sql,
			() => [...batchIds],
			200,
			(rows) => rows.length,
		));
	}

	// S9 context candidate scaling + tail-priority inclusion (round-2 review P1
	// §4.3.1 / §8). Creates dedicated wide parents (100 + 1000 direct children)
	// where the LAST child (path-sorts last, `zzz-critical`) carries priority=999.
	// Runs the candidate bounded SELECT (LIMIT 5000) and asserts the tail
	// high-priority child is in the fetched set every iteration — the OLD
	// expand({limit:100}) would have EXCLUDED it (position 100 / 1000). Reports
	// per-op at each width.
	if (isEnabled("S9")) {
		const candRootPath = `${BENCH_ROOT_PATH}/__cand`;
		const ts = new Date().toISOString();
		let candRootRow = db.prepare(`SELECT id FROM wiki_nodes WHERE path = ? LIMIT 1`).get(candRootPath) as { id: number } | undefined;
		if (!candRootRow) {
			const r = db.prepare(`INSERT INTO wiki_nodes (parent_id, name, path, kind, summary, content, attributes_json, created_at, updated_at) VALUES (NULL, ?, ?, 'node', '', '', NULL, ?, ?)`)
				.run("__cand", candRootPath, ts, ts);
			candRootRow = { id: Number(r.lastInsertRowid) };
		}
		const sql = `SELECT * FROM wiki_nodes WHERE parent_id = ? AND archived_at IS NULL ORDER BY path ASC, id ASC LIMIT 5000`;
		for (const width of [100, 1000]) {
			const parentPath = `${candRootPath}/w${width}`;
			let parentId: number;
			const existPar = db.prepare(`SELECT id FROM wiki_nodes WHERE path = ? LIMIT 1`).get(parentPath) as { id: number } | undefined;
			if (existPar) {
				parentId = existPar.id;
			} else {
				const r = db.prepare(`INSERT INTO wiki_nodes (parent_id, name, path, kind, summary, content, attributes_json, created_at, updated_at) VALUES (?, ?, ?, 'node', '', '', NULL, ?, ?)`)
					.run(candRootRow!.id, `w${width}`, parentPath, ts, ts);
				parentId = Number(r.lastInsertRowid);
				const insChild = db.prepare(`INSERT INTO wiki_nodes (parent_id, name, path, kind, summary, content, attributes_json, created_at, updated_at) VALUES (?, ?, ?, 'node', ?, ?, ?, ?, ?)`);
				const tx = db.transaction(() => {
					for (let i = 0; i < width; i++) {
						const isTail = i === width - 1;
						const name = isTail ? "zzz-critical" : `kid-${String(i).padStart(4, "0")}`;
						const attrs = isTail
							? JSON.stringify({ priority: 999, durability: "permanent" })
							: JSON.stringify({ priority: 1 });
						insChild.run(parentId, name, `${parentPath}/${name}`, genSummary(i), "", attrs, ts, ts);
					}
				});
				tx();
			}
			const plan = explainQueryPlan(db, sql, parentId);
			const planCheck = assertPlan(`S9-${width}`, plan);
			// warmup
			db.prepare(sql).all(parentId);
			const iters = 50;
			const t0 = nowMs();
			let tailHit = 0;
			for (let i = 0; i < iters; i++) {
				const rows = db.prepare(sql).all(parentId) as Array<{ path: string }>;
				if (rows.some((r) => r.path.endsWith("/zzz-critical"))) tailHit++;
			}
			const totalMs = nowMs() - t0;
			results.push({
				label: `S9 candidate scale width=${width} (tail zzz-critical priority=999 fetched ${tailHit}/${iters})`,
				totalMs,
				iterations: iters,
				perOpUs: (totalMs * 1000) / iters,
				rowsTouched: tailHit,
				// plan-ok AND tail must be fetched every iter (old expand({limit:100})
				// excluded it; new bounded SELECT includes it).
				planAsserted: planCheck.ok && tailHit === iters,
				planSummary: plan,
			});
		}
	}

	return results;
}

function parentPathShadow(iter: number): string {
	// Each S6 iter shadows the parent into a uniquely-named sibling to avoid
	// (parent_id, name) UNIQUE collisions during the bounded move test.
	return `${BENCH_ROOT_PATH}/shadow-${iter}`;
}

// ─── Main ───────────────────────────────────────────────────────────

interface HardwareInfo {
	platform: string;
	arch: string;
	cpus: string;
	cpuCount: number;
	totalMemMB: number;
	nodeVersion: string;
}

function getHardwareSync(): HardwareInfo {
	const cpuList = cpus();
	return {
		platform: process.platform,
		arch: process.arch,
		cpus: cpuList[0]?.model ?? "unknown",
		cpuCount: cpuList.length,
		totalMemMB: Math.floor(totalmem() / (1024 * 1024)),
		nodeVersion: process.versions.node,
	};
}

function getCommitSha(): string {
	try {
		return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
	} catch {
		return "(unknown — not a git repo)";
	}
}

function getBranch(): string {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
	} catch {
		return "(unknown)";
	}
}

function main() {
	const args = parseArgs(process.argv);
	console.log(`[wiki-benchmark] nodes=${args.nodes.toLocaleString()} scenarios=${args.scenarios.length ? args.scenarios.join(",") : "(all)"}`);

	const tmpRoot = mkdtempSync(join(tmpdir(), "wiki-bench-"));
	const dbPath = args.keepDb ?? join(tmpRoot, `wiki-bench-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
	console.log(`[wiki-benchmark] db=${dbPath}`);

	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	initWikiSchema(db);

	const t0gen = nowMs();
	const data = generateData(db, args.nodes);
	const genMs = nowMs() - t0gen;
	console.log(`[wiki-benchmark] generated ${data.nodeCount.toLocaleString()} nodes + ${data.linkCount.toLocaleString()} links in ${humanMs(genMs)}`);

	const memBefore = process.memoryUsage().rss;
	const t0run = nowMs();
	const results = runAllScenarios(db, data, args.scenarios);
	const runMs = nowMs() - t0run;
	const memAfter = process.memoryUsage().rss;

	// ─── Report ───
	console.log("");
	console.log("─".repeat(80));
	console.log("Scenario                               | per/op       | total        | iters | plan-ok | rows");
	console.log("─".repeat(80));
	for (const r of results) {
		const label = r.label.padEnd(38);
		const perOp = `${r.perOpUs.toFixed(1)}us`.padStart(12);
		const total = humanMs(r.totalMs).padStart(12);
		const iters = String(r.iterations).padStart(5);
		const planOk = (r.planAsserted ? "yes" : "NO").padStart(7);
		const rows = String(r.rowsTouched).padStart(8);
		console.log(`${label} | ${perOp} | ${total} | ${iters} | ${planOk} | ${rows}`);
	}
	console.log("─".repeat(80));
	console.log(`Total scenario time: ${humanMs(runMs)} | RSS before=${(memBefore / 1024 / 1024).toFixed(0)}MB after=${(memAfter / 1024 / 1024).toFixed(0)}MB`);
	console.log("");

	const allPlansOk = results.every((r) => r.planAsserted);

	const report = {
		generatedAt: new Date().toISOString(),
		commitSha: getCommitSha(),
		branch: getBranch(),
		hardware: getHardwareSync(),
		dataGeneration: {
			targetNodes: args.nodes,
			actualNodes: data.nodeCount,
			linksCreated: data.linkCount,
			treeWide: 64,
			treeDepth: 4,
			genMs: Number(genMs.toFixed(2)),
		},
		results: results.map((r) => ({
			label: r.label,
			totalMs: Number(r.totalMs.toFixed(3)),
			iterations: r.iterations,
			perOpUs: Number(r.perOpUs.toFixed(2)),
			rowsTouched: r.rowsTouched,
			planAsserted: r.planAsserted,
			plan: r.planSummary,
		})),
		allPlansOk,
		totalRunMs: Number(runMs.toFixed(2)),
		rssBeforeMB: Math.floor(memBefore / 1024 / 1024),
		rssAfterMB: Math.floor(memAfter / 1024 / 1024),
	};

	if (args.out) {
		const outPath = resolve(args.out);
		writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
		console.log(`[wiki-benchmark] report written → ${outPath}`);
	} else {
		console.log("[wiki-benchmark] JSON report:");
		console.log(JSON.stringify(report, null, 2));
	}

	db.close();
	if (!args.keepDb) {
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}

	if (!allPlansOk) {
		console.error(`[wiki-benchmark] FAIL: one or more scenarios did not use the expected index.`);
		process.exit(2);
	}
}

main();
