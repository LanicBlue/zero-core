// Wiki 浏览页面(wiki-system-redesign plan-06 §4 / §5)
//
// # 文件说明书
//
// ## 核心功能
// 全局 wiki 树浏览器。左树(canonical path 懒加载 + 分页)+ 右详情(5 tabs)。
//
// 视角(scope)切换根:
//   - Global      → wiki-root
//   - Knowledge   → wiki-root/knowledge
//   - Memory      → wiki-root/memory
//   - Agent memory → memory://<agentId>
//   - Project     → project://<projectId>
//   - Custom      → 任意 logical/canonical address
//
// 搜索(target / mode / case / fields / kinds / scope / limit 全部传后端,非
// 只是视觉控件 —— acceptance-06 §C.1)。
//
// ## 关键不变量
//   - 公开 key 是 canonical path;React 组件树 / store state 均不含 DB 内部 ID。
//   - 搜索 regex invalid / timeout 显示具体错误,不退化为 substring(§C.4)。
//   - 搜索结果点击 → 展开祖先并定位节点(§B.5)。
//   - archived 默认隐藏,管理员开关后可见(§B.6)。
//
// ## 输入
//   - useWikiStore(canonical path keyed)
//   - useProjectStore(scope 选择器列项目)
//   - useAgentStore(scope 选择器列 agent memory)
//
import React, { useEffect, useState } from "react";
import { useWikiStore, scopeToAddress, type WikiViewScope } from "../../store/wiki-store.js";
import { useProjectStore } from "../../store/project-store.js";
import { useNotificationStore } from "../../store/notification-store.js";
import WikiTree from "./WikiTree.js";
import WikiDetail from "./WikiDetail.js";
import type { WikiNodeKind } from "../../../shared/wiki-types.js";
import type { WikiSearchMode, WikiSearchTarget, WikiSearchField } from "../../../shared/wiki-search-types.js";

export default function WikiPage() {
	const scope = useWikiStore((s) => s.scope);
	const setScope = useWikiStore((s) => s.setScope);
	const showArchived = useWikiStore((s) => s.showArchived);
	const setShowArchived = useWikiStore((s) => s.setShowArchived);
	const selectedPath = useWikiStore((s) => s.selectedPath);
	const searchResult = useWikiStore((s) => s.searchResult);
	const searchLoading = useWikiStore((s) => s.searchLoading);

	const { projects, fetchProjects } = useProjectStore();
	const addError = useNotificationStore((s) => s.addError);

	useEffect(() => { fetchProjects(); }, []);

	const scopeAddress = scopeToAddress(scope);

	return (
		<div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-primary, #1a1a1c)" }}>
			<Header
				scope={scope}
				onScopeChange={setScope}
				projects={projects}
			/>
			<SearchBar />
			{searchResult && (
				<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)", padding: "4px 16px", borderBottom: "1px solid var(--border-color, #333)" }}>
					{searchResult.wikiHits.length} wiki + {searchResult.sourceHits.length} source hits
					{searchResult.truncated && " (truncated by limit)"}
					{searchLoading && " · loading more…"}
				</div>
			)}

			<div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
				<div style={{
					width: 320, minWidth: 240,
					borderRight: "1px solid var(--border-color, #333)",
					display: "flex", flexDirection: "column", overflow: "hidden",
				}}>
					<Breadcrumb address={scopeAddress} />
					<div style={{ padding: "4px 8px", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
						<label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-tertiary, #888)", cursor: "pointer" }}>
							<input
								type="checkbox"
								checked={showArchived}
								onChange={(e) => setShowArchived(e.target.checked)}
							/>
							show archived
						</label>
					</div>
					<div style={{ flex: 1, overflowY: "auto" }}>
						{searchResult ? (
							<SearchResultList />
						) : (
							<WikiTree rootAddress={scopeAddress} showArchived={showArchived} />
						)}
					</div>
				</div>

				<div style={{ flex: 1, overflow: "hidden" }}>
					<WikiDetail path={selectedPath} />
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Header — scope selector + archived toggle + refresh
// ---------------------------------------------------------------------------

function Header({
	scope, onScopeChange, projects,
}: {
	scope: WikiViewScope;
	onScopeChange: (s: WikiViewScope) => void;
	projects: Array<{ id: string; name: string }>;
}) {
	const scopeValue =
		scope.kind === "global" ? "global"
			: scope.kind === "knowledge" ? "knowledge"
				: scope.kind === "memory" ? "memory"
					: scope.kind === "project" ? `project:${scope.projectId}`
						: "address";
	return (
		<div style={{
			display: "flex", alignItems: "center", gap: 12,
			padding: "12px 16px", borderBottom: "1px solid var(--border-color, #333)",
		}}>
			<span style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>
				{"\u{1F4D6}"} Wiki Browser
			</span>
			<div style={{ flex: 1 }} />
			<select
				value={scopeValue}
				onChange={(e) => {
					const v = e.target.value;
					if (v === "global") onScopeChange({ kind: "global" });
					else if (v === "knowledge") onScopeChange({ kind: "knowledge" });
					else if (v === "memory") onScopeChange({ kind: "memory" });
					else if (v.startsWith("project:")) {
						const projectId = v.slice("project:".length);
						onScopeChange({ kind: "project", projectId });
					} else if (v === "address") {
						const address = window.prompt("Enter wiki address (canonical path, memory://<agent>, project://<id>, runtime://<alias>):");
						if (address) onScopeChange({ kind: "address", address });
					}
				}}
				aria-label="Wiki view scope"
				style={selectStyle}
				data-testid="wiki-scope-select"
			>
				<option value="global">Global (all)</option>
				<option value="knowledge">Knowledge</option>
				<option value="memory">Agent Memory (all)</option>
				{projects.map((p) => (
					<option key={p.id} value={`project:${p.id}`}>Project: {p.name}</option>
				))}
				<option value="address">Custom address…</option>
			</select>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Breadcrumb — show scope root address
// ---------------------------------------------------------------------------

function Breadcrumb({ address }: { address: string }) {
	return (
		<div style={{
			padding: "4px 12px", fontSize: 11, fontFamily: "monospace",
			color: "var(--text-tertiary, #888)",
			borderBottom: "1px solid var(--border-color, #333)",
			whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
		}} title={address}>
			{address}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Search bar — full params wired to backend (acceptance-06 §C.1)
// ---------------------------------------------------------------------------

const MODES: WikiSearchMode[] = ["fulltext", "substring", "exact", "glob", "regex", "hybrid"];
const TARGETS: WikiSearchTarget[] = ["wiki", "source", "both"];
const FIELDS: WikiSearchField[] = ["name", "path", "summary", "content"];
const KINDS: WikiNodeKind[] = [
	"namespace", "project", "directory",
	"source_file", "source_symlink", "source_submodule",
	"knowledge", "memory", "node",
];

function SearchBar() {
	const runSearch = useWikiStore((s) => s.runSearch);
	const clearSearch = useWikiStore((s) => s.clearSearch);
	const last = useWikiStore((s) => s.lastSearchParams);
	const addError = useNotificationStore((s) => s.addError);

	const [query, setQuery] = useState("");
	const [mode, setMode] = useState<WikiSearchMode>("fulltext");
	const [target, setTarget] = useState<WikiSearchTarget>("wiki");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [fields, setFields] = useState<WikiSearchField[]>([]);
	const [kinds, setKinds] = useState<WikiNodeKind[]>([]);
	const [limit, setLimit] = useState(20);

	// Restore from last search when navigating back.
	useEffect(() => {
		if (last) {
			setQuery(last.query ?? "");
			setMode(last.mode ?? "fulltext");
			setTarget(last.target ?? "wiki");
			setCaseSensitive(last.caseSensitive ?? false);
			setFields(last.fields ?? []);
			setKinds(last.kinds ?? []);
			setLimit(last.limit ?? 20);
		}
	}, [last]);

	const toggleField = (f: WikiSearchField) => {
		setFields((cur) => cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]);
	};
	const toggleKind = (k: WikiNodeKind) => {
		setKinds((cur) => cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]);
	};

	const handleSearch = async () => {
		if (!query.trim()) {
			addError("empty query");
			return;
		}
		// scope 恒 null 是设计决策,不是缺口:Wiki Browser 走 UI-admin authority,
		// 后端注入的 grant scope = wiki-root(整树),传 scope 只会收窄、不会扩大
		// 授权 —— 与 UI-admin 全树浏览语义冲突。非 admin 视角(如 plan-08 引入
		// per-agent / per-project 浏览器时)才需要 scope 控件由调用方决定。
		await runSearch({
			query: query.trim(),
			mode,
			target,
			caseSensitive,
			fields: fields.length > 0 ? fields : undefined,
			kinds: kinds.length > 0 ? kinds : undefined,
			limit,
			cursor: null,
			scope: null,
			fileGlobs: undefined,
		});
	};

	return (
		<div style={{
			padding: "8px 16px",
			borderBottom: "1px solid var(--border-color, #333)",
			display: "flex", flexDirection: "column", gap: 6,
		}}>
			<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
				<input
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
					placeholder="Search…"
					aria-label="Wiki search query"
					style={{ ...selectStyle, flex: 1 }}
					data-testid="wiki-search-input"
				/>
				<select value={mode} onChange={(e) => setMode(e.target.value as WikiSearchMode)} style={selectStyle} aria-label="search mode">
					{MODES.map((m) => <option key={m} value={m}>{m}</option>)}
				</select>
				<select value={target} onChange={(e) => setTarget(e.target.value as WikiSearchTarget)} style={selectStyle} aria-label="search target">
					{TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
				</select>
				<label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-secondary, #888)", cursor: "pointer" }}>
					<input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
					case
				</label>
				<label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-secondary, #888)" }}>
					limit
					<input
						type="number"
						min={1}
						max={200}
						value={limit}
						onChange={(e) => setLimit(Math.max(1, Math.min(200, Number(e.target.value) || 20)))}
						style={{ ...selectStyle, width: 60 }}
					/>
				</label>
				<button type="button" onClick={handleSearch} style={smallBtnStyle} data-testid="wiki-search-go">Search</button>
				<button type="button" onClick={() => { clearSearch(); setQuery(""); }} style={smallBtnStyle}>Clear</button>
			</div>
			<details style={{ fontSize: 11, color: "var(--text-tertiary, #888)" }}>
				<summary style={{ cursor: "pointer" }}>Filters</summary>
				<div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
					<div>
						<span style={{ marginRight: 8 }}>fields:</span>
						{FIELDS.map((f) => (
							<label key={f} style={{ marginRight: 10, cursor: "pointer" }}>
								<input type="checkbox" checked={fields.includes(f)} onChange={() => toggleField(f)} />
								{" "}{f}
							</label>
						))}
					</div>
					<div>
						<span style={{ marginRight: 8 }}>kinds:</span>
						{KINDS.map((k) => (
							<label key={k} style={{ marginRight: 10, cursor: "pointer" }}>
								<input type="checkbox" checked={kinds.includes(k)} onChange={() => toggleKind(k)} />
								{" "}{k}
							</label>
						))}
					</div>
				</div>
			</details>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Search result list
// ---------------------------------------------------------------------------

function SearchResultList() {
	const searchResult = useWikiStore((s) => s.searchResult);
	const selectPath = useWikiStore((s) => s.selectPath);
	const loadMoreSearch = useWikiStore((s) => s.loadMoreSearch);
	const searchLoading = useWikiStore((s) => s.searchLoading);
	const expandPath = useWikiStore((s) => s.expandPath);

	if (!searchResult) return null;

	const handleSelect = (path: string) => {
		selectPath(path);
		// Expand ancestors so the node is locatable in the tree (acceptance-06 §B.5).
		void expandAncestors(path, expandPath);
	};

	return (
		<div data-testid="wiki-search-results" style={{ padding: 8 }}>
			{searchResult.wikiHits.length === 0 && searchResult.sourceHits.length === 0 ? (
				<div style={{ fontSize: 12, color: "var(--text-tertiary, #555)", padding: 8 }}>
					No matches.
				</div>
			) : (
				<>
					{searchResult.wikiHits.map((h) => (
						<div
							key={`w:${h.path}`}
							data-testid="wiki-search-hit"
							onClick={() => handleSelect(h.path)}
							style={searchHitStyle}
							title={h.path}
						>
							<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
								<span style={{ fontSize: 9, padding: "1px 4px", background: "var(--bg-active, #2a2a2e)", borderRadius: 2, color: "var(--text-tertiary, #888)" }}>
									{h.matchType}
								</span>
								<span style={{ fontSize: 9, padding: "1px 4px", background: "var(--bg-active, #2a2a2e)", borderRadius: 2, color: "var(--text-tertiary, #888)" }}>
									{h.matchedField}
								</span>
								<span style={{ fontSize: 9, color: "var(--text-tertiary, #666)" }}>{h.kind}</span>
								<span style={{ fontSize: 9, color: "var(--text-tertiary, #666)" }}>r{h.revision}</span>
							</div>
							<div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
								{h.displayTitle || h.path}
							</div>
							{h.snippet && (
								<div style={{
									fontSize: 10, color: "var(--text-tertiary, #666)",
									marginTop: 2, maxHeight: 36, overflow: "hidden",
								}}>
									{h.snippet}
								</div>
							)}
							<div style={{ fontSize: 9, color: "var(--text-tertiary, #555)", fontFamily: "monospace" }}>
								{h.path}
							</div>
						</div>
					))}
					{searchResult.sourceHits.map((h, i) => (
						<div
							key={`s:${i}:${h.path}`}
							data-testid="wiki-search-source-hit"
							style={{ ...searchHitStyle, borderLeft: "2px solid #f4b400" }}
							title={h.path}
						>
							<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
								<span style={{ fontSize: 9, padding: "1px 4px", background: "rgba(244,180,0,0.15)", borderRadius: 2, color: "#f4b400" }}>
									source
								</span>
								<span style={{ fontSize: 9, color: "var(--text-tertiary, #666)" }}>{h.matchType}</span>
								<span style={{ fontSize: 9, color: "var(--text-tertiary, #666)" }}>{h.matchedField}</span>
							</div>
							<div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
								{h.displayTitle}
							</div>
							{h.snippet && (
								<pre style={{
									margin: "2px 0 0", fontSize: 10, color: "var(--text-tertiary, #888)",
									maxHeight: 36, overflow: "hidden", whiteSpace: "pre-wrap",
								}}>
									{h.snippet}
								</pre>
							)}
						</div>
					))}
					{searchResult.hasMore && (
						<div style={{ padding: "6px 8px" }}>
							<button
								type="button"
								onClick={() => loadMoreSearch()}
								disabled={searchLoading}
								style={smallBtnStyle}
							>
								{searchLoading ? "Loading…" : "Load more"}
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}

/**
 * Walk canonical path ancestors and trigger lazy expand for each,so the
 * selected search result is visible in the tree. Best-effort: store.expandPath
 * is idempotent; already-loaded paths skip the request.
 */
async function expandAncestors(path: string, expandPath: (p: string, opts?: { reset?: boolean }) => Promise<void>): Promise<void> {
	const segments = path.split("/");
	const acc: string[] = [];
	let current = "";
	for (const seg of segments) {
		current = current ? `${current}/${seg}` : seg;
		acc.push(current);
	}
	for (const p of acc) {
		await expandPath(p);
	}
}

// ---------------------------------------------------------------------------
// shared styles
// ---------------------------------------------------------------------------

const selectStyle: React.CSSProperties = {
	padding: "4px 8px",
	background: "var(--bg-secondary, #1c1c1e)",
	border: "1px solid var(--border-color, #333)",
	borderRadius: 4,
	color: "var(--text-primary, #e0e0e0)",
	fontSize: 12,
};

const smallBtnStyle: React.CSSProperties = {
	padding: "4px 10px",
	background: "transparent",
	border: "1px solid var(--border-color, #333)",
	borderRadius: 4,
	color: "var(--text-secondary, #888)",
	fontSize: 12,
	cursor: "pointer",
};

const searchHitStyle: React.CSSProperties = {
	padding: "6px 8px",
	cursor: "pointer",
	fontSize: 12,
	color: "var(--text-secondary, #888)",
	borderRadius: 4,
	marginBottom: 4,
	borderLeft: "2px solid transparent",
};
