# Caller Inventory: Old 10 Wiki Actions → Wiki v2 Migration

> wiki-system-redesign plan-04 §7 deliverable.
> Maps every existing caller of the old Wiki tool's 10 actions
> (`expand / search / create / update / delete / createMemory /
> updateMemory / docRead / docWrite / docEdit`) to its migration stage
> across plan-04 → plan-05 → plan-08.

## Migration stages

- **Plan-04 (this sub)** — `createWikiTool` factory + 9-action schema +
  `WikiSearchService` exist, **not registered**. Caller inventory built.
  Old `wikiTool` still registered and used by all callers below.
- **Plan-05 (runtime swap)** — AgentService compiles `wikiGrants` →
  `CompiledWikiAccess`; AgentLoop populates `callerCtx.wikiAccess`;
  `src/tools/index.ts` swaps `wikiTool` → `createWikiTool(deps)` (same
  visible name `Wiki`). All callers below must move off retired actions.
- **Plan-08 (zero prod-ref)** — `src/tools/wiki-tool.ts` deleted;
  `wikiAnchorNodeIds` removed from `CallerCtx`; `wiki-anchor-injection.ts`
  deleted; legacy `wiki-node-store.ts` and `project-wiki-*` deleted.

## Convention

| Mark | Meaning |
|---|---|
| Plan-04 inventory | Cataloged here; no runtime change. |
| Plan-05 runtime | Caller must move to new action/path vocabulary. |
| Plan-08 delete | Caller file itself is deleted (or final cutover). |

## 1. `expand` (still valid in v2; semantics change)

| Caller | File | Stage | Note |
|---|---|---|---|
| `wikiTool` executor | `src/tools/wiki-tool.ts` | Plan-05 swap | Replaced by `createWikiTool` factory (sub-04). |
| Archivist enrichment prompt | `src/server/wiki-operations.ts` (WIKI_OPERATIONS) | Plan-04 done | Prompt vocabulary updated to `Wiki(action:'expand', node:'project://')`. |
| Renderer wiki store (UI) | `src/renderer/store/wiki-store.ts` | Plan-06 | UI migrates to new structured API; not in this sub. |
| Tests | `tests/unit/*.ts` (m2-wiki-archivist, p1-wiki-store, p3-management-tools, tool-quality-pass-sub3-wiki, sub2-memory-routing) | Plan-08 delete | Old tests retire with old tool. |

## 2. `search` (still valid in v2; semantics change: 6 modes + targets)

| Caller | File | Stage | Note |
|---|---|---|---|
| `wikiTool` executor | `src/tools/wiki-tool.ts` | Plan-05 swap | Replaced by `WikiSearchService` + factory. |
| Archivist enrichment | `src/server/wiki-operations.ts` | Plan-04 done | Prompt uses `Wiki(action:'search', target:'source', query:..., scope:'project://')`. |
| Renderer wiki store | `src/renderer/store/wiki-store.ts` | Plan-06 | UI search migrates to new structured API. |

## 3. `create` (still valid in v2; semantics change)

| Caller | File | Stage | Note |
|---|---|---|---|
| `wikiTool` executor | `src/tools/wiki-tool.ts` | Plan-05 swap | New schema uses `parent` (address) + `name`; old `parentId` + `title` retired. |
| Archivist enrichment | `src/server/wiki-operations.ts` | Plan-04 done | Prompt no longer mentions `create` for source-bound nodes (returns SOURCE_MANAGED). |
| Renderer wiki store | `src/renderer/store/wiki-store.ts` | Plan-06 | UI uses POST `/api/wiki/create` with structured body. |

## 4. `update` (still valid in v2; now requires `expected_revision`)

| Caller | File | Stage | Note |
|---|---|---|---|
| `wikiTool` executor | `src/tools/wiki-tool.ts` | Plan-05 swap | Schema now forces `expected_revision`; `changes`/`operations` for fields/content. |
| Archivist enrichment | `src/server/wiki-operations.ts` | Plan-04 done | Prompt explicitly references `expected_revision` + `operations:[{op:'replace_text',...}]`. |
| Renderer wiki store | `src/renderer/store/wiki-store.ts` | Plan-06 | UI uses POST `/api/wiki/update`. |

## 5. `delete` (still valid in v2; defaults to archive; hard-delete not exposed)

| Caller | File | Stage | Note |
|---|---|---|---|
| `wikiTool` executor | `src/tools/wiki-tool.ts` | Plan-05 swap | New schema: archive (cascade optional). Hard-delete is admin-only. |
| Archivist enrichment | `src/server/wiki-operations.ts` | Plan-04 done | Prompt notes indexer auto-archives source-bound on file delete. |
| Renderer wiki store | `src/renderer/store/wiki-store.ts` | Plan-06 | UI uses POST `/api/wiki/delete`. |

## 6. `createMemory` — **RETIRED** in v2 (memory via `memory://` + create)

| Caller | File | Stage | Note |
|---|---|---|---|
| `wikiTool` executor | `src/tools/wiki-tool.ts` | Plan-05 swap | Retired branch. Memory = `Wiki(action:'create', parent:'memory://', name, attributes:{memory_type, durability})`. |
| Enrichment / archivist | `src/server/enrichment-runner.ts`, `src/server/wiki-node-store.ts` (ensureMemoryAgentRoot, upsertMemoryNodeInScope) | Plan-05 runtime | Memory lifecycle now via `WikiService.ensureAgentMemoryRoot` + `WikiService.create({parent:'memory://'})`. |
| `runtime/wiki-anchor-injection.ts` | memory doc-path helpers | Plan-08 delete | File removed entirely (anchor injection retired). |
| `tools/wiki-path-guard.ts` | blocks disk Markdown write | Plan-08 delete | No more disk Wiki bodies. |
| Tests | `tests/unit/m2-wiki-archivist.test.ts`, `memory-recall.test.ts`, `sub2-memory-routing.test.ts` | Plan-08 delete | Old tests retire with old memory actions. |

## 7. `updateMemory` — **RETIRED** in v2 (memory via `memory://` + update)

| Caller | File | Stage | Note |
|---|---|---|---|
| `wikiTool` executor | `src/tools/wiki-tool.ts` | Plan-05 swap | Retired branch. Memory update = `Wiki(action:'update', node:'memory://<subject>', expected_revision, changes/operations)`. |
| `runtime/wiki-anchor-injection.ts` | docPathFor / readNodeDetail helpers | Plan-08 delete | File removed. |
| Tests | `tests/unit/m2-wiki-archivist.test.ts`, `sub2-memory-routing.test.ts` | Plan-08 delete | Replaced by `wiki-v2-tool-*.test.ts` (sub-04 verifier). |

## 8. `docRead` — **RETIRED** in v2 (merged into `read` view=content)

| Caller | File | Stage | Note |
|---|---|---|---|
| `wikiTool` executor | `src/tools/wiki-tool.ts` | Plan-05 swap | Retired branch. `Wiki(action:'read', node, view:'content', section?, lineStart?, lineEnd?)`. |
| Archivist enrichment | `src/server/wiki-operations.ts` | Plan-04 done | Prompt now uses `Wiki(action:'read', view:'content')` not `docRead`. |
| Tests | `tests/unit/p1-wiki-store.test.ts`, `tool-quality-pass-sub3-wiki.test.ts` | Plan-08 delete | Old tests retire. |

## 9. `docWrite` — **RETIRED** in v2 (merged into `update` changes.content)

| Caller | File | Stage | Note |
|---|---|---|---|
| `wikiTool` executor | `src/tools/wiki-tool.ts` | Plan-05 swap | Retired branch. `Wiki(action:'update', node, expected_revision, changes:{content})` or `operations:[{op:'replace_text',...}]`. No `overwrite=true` bypass. |
| Archivist enrichment | `src/server/wiki-operations.ts` | Plan-04 done | Prompt uses `changes.content` / `operations`. |
| Tests | `tests/unit/tool-quality-pass-sub3-wiki.test.ts` | Plan-08 delete | Replaced by `wiki-v2-tool-format.test.ts`. |

## 10. `docEdit` — **RETIRED** in v2 (merged into `update` operations)

| Caller | File | Stage | Note |
|---|---|---|---|
| `wikiTool` executor | `src/tools/wiki-tool.ts` | Plan-05 swap | Retired branch. `Wiki(action:'update', node, expected_revision, operations:[{op:'replace_text', old_text, new_text}])`. |
| Archivist enrichment | `src/server/wiki-operations.ts` | Plan-04 done | Prompt explicitly uses `operations:[{op:'replace_text',...}]`. |
| Tests | `tests/unit/tool-quality-pass-sub3-wiki.test.ts` | Plan-08 delete | Replaced. |

## Cross-cutting: identity / scope wiring

| Caller | File | Stage | Note |
|---|---|---|---|
| `CallerCtx.wikiAnchorNodeIds` | `src/tools/types.ts`, `src/runtime/agent-loop.ts`, `src/runtime/types.ts` | Plan-05 + Plan-08 | Plan-05 adds `callerCtx.wikiAccess`; Plan-08 deletes `wikiAnchorNodeIds` (no fallback). |
| `runtime/wiki-anchor-injection.ts` | anchor resolution | Plan-08 delete | Replaced by `WikiContextCompiler` (server-side). |
| `tools/wiki-path-guard.ts` | disk Markdown write guard | Plan-08 delete | No more disk Wiki bodies. |
| `tools/wiki-tool.ts` | old tool definition | Plan-05 swap → Plan-08 delete | Plan-05: replaced by `createWikiTool`; Plan-08: file removed. |

## Verifier expectations (acceptance-04 §G)

`result-04.md` must include this inventory + the v2 LLM-visible JSON schema
(exported from `src/tools/wiki-v2-tool.ts`). Each row above corresponds to a
migration commit in plan-05 (runtime caller change) or plan-08 (delete).
