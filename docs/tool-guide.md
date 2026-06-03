# Tool System Reference

## Overview

Zero-core has 15+ runtime tools. Each tool has:
- **name**: Internal identifier (e.g. `bash`, `webSearch`)
- **description**: Short label for UI display
- **prompt**: Full usage guide that the LLM sees
- **configSchema**: User-configurable parameters with defaults
- **inputSchema**: Zod-validated parameters per invocation
- **execute**: Async function returning a string result

Tools are registered via `buildTool()` and managed by `ToolRegistry`. User config is persisted in SQLite and injected into the LLM's tool description as `Current config: ...`.

---

## Tool Catalog

### Bash

Execute shell commands. Supports foreground (blocking) and background modes.

| Parameter | Type | Description |
|-----------|------|-------------|
| command | string | Shell command to execute |
| timeout | number? | Timeout in seconds (foreground only) |
| background | boolean? | Run in background, returns task_id |

**Config**: `timeout` (default: none)

**Output — success (default config)**:
```
hello

[Completed in 0.1s]
```

**Output — with config.timeout=2**:
```
from-config

[Completed in 0.0s]
```

**Output — input.timeout overrides config.timeout=1**:
```
override

[Completed in 0.0s]
```

**Output — stderr captured and labeled**:
```
[stderr] stderr-test

[Completed in 0.0s]
```

**Output — multi-line**:
```
a
b
c

[Completed in 0.0s]
```

**Output — non-zero exit code**:
```
Error: Exit code 42
Command: node -e process.exit(42)
```

**Output — timeout**:
```
Error: Command timed out after 1s
Command: node -e "setTimeout(()=>{},10000)"
```

---

### Read

Read file contents. Supports text, images, PDFs, and Jupyter notebooks.

| Parameter | Type | Description |
|-----------|------|-------------|
| path | string | File path (absolute or relative) |
| offset | number? | Start line (1-based) |
| limit | number? | Max lines to read |
| mode | "full"\|"outline"? | Read mode |
| pages | string? | Page range for PDF/notebook |

**Config**: `max_lines` (2000), `default_mode` ("full"), `max_file_size` (256 KB)

**Output — default config (full mode)**:
```
1	tiny
```

**Output — config.default_mode="outline" (no explicit mode param)**:
```
sample.ts (12 lines, TypeScript)

L1           import zod
L3-5         fn hello - export function hello(name: string): string {
L7           class Foo - export class Foo {
L9             method constructor
L10            method bar
```

Note: `L3-5` shows the full range because fn hello has no children (its body lines are folded). `L7` shows only the start line because its children (L9, L10) are expanded below it.

**Output — config.max_lines=5 (50-line file)**:
```
1	line 1
2	line 2
3	line 3
4	line 4
5	line 5

[File has 50 lines, showing 1-5. Use offset/limit to read more.]
```

**Output — offset+limit overrides config.max_lines**:
```
10	line 10
11	line 11
12	line 12

[File has 50 lines, showing 10-12. Use offset/limit to read more.]
```

**Output — config.max_file_size=1KB (2KB file rejected)**:
```
File too large (2.0 KB). Maximum is 1.0 KB.
Use offset and limit parameters to read specific sections of large files.
```

**Output — CRLF file (normalized to LF)**:
```
1	alpha
2	beta
3	gamma
```

---

### Write

Write content to a file. Creates parent directories automatically.

| Parameter | Type | Description |
|-----------|------|-------------|
| path | string | File path |
| content | string | Content to write |

**Config**: `syntaxCheck` (true)

**Output — config.syntaxCheck=true, valid file**:
```
Successfully wrote 13 bytes to w-ok.ts
```

**Output — config.syntaxCheck=true, broken file**:
```
Successfully wrote 19 bytes to w-bad.ts

⚠ Syntax warnings in w-bad.ts:
  L1: unmatched '{' — missing '}'
Please verify the file structure is correct.
```

**Output — config.syntaxCheck=false, broken file (no warning)**:
```
Successfully wrote 19 bytes to w-nocheck.ts
```

**Output — auto-create nested directories**:
```
Successfully wrote 6 bytes to deep/sub/dir/file.txt
```

---

### Edit

Perform exact string replacement in a file.

| Parameter | Type | Description |
|-----------|------|-------------|
| path | string | File path |
| oldText | string | Exact text to find |
| newText | string | Replacement text |

**Config**: `syntaxCheck` (true)

**Output — config.syntaxCheck=true, valid edit**:
```
Successfully edited edit-ok.ts
```

**Output — config.syntaxCheck=true, creates syntax error**:
```
Successfully edited edit-bad.ts

⚠ Syntax warnings in edit-bad.ts:
  L2: unmatched '{' — missing '}'
Please verify the file structure is correct.
```

**Output — config.syntaxCheck=false, broken edit (no warning)**:
```
Successfully edited edit-nocheck.ts
```

**Output — text not found (shows file head)**:
```
Error: Text not found in edit-nf.txt (4 lines).

File starts with:
1: aaa
2: bbb
3: ccc
4: 

Use Read to re-read the file and verify exact content.
```

**Output — partial match (shows context)**:
```
Error: Text not found in edit-partial.txt (4 lines).

Partial match found near line 2:
1: aaa
2: bbb something
3: ccc
4: 

Use Read to re-read the file and verify exact content.
```

**Output — CRLF mismatch detection**:
```
Error: Text not found in edit-crlf.txt (3 lines).

Partial match found near line 1:
1: line one
2: line two
3: 

Hint: file uses CRLF line endings but oldText uses LF.

Use Read to re-read the file and verify exact content.
```

---

### Grep

Search file contents using ripgrep (falls back to grep if rg unavailable).

| Parameter | Type | Description |
|-----------|------|-------------|
| pattern | string | Regex pattern |
| path | string? | Directory to search |
| glob | string? | File filter (e.g. `*.ts`) |
| type | string? | Language type (e.g. `js`, `py`) |
| output_mode | "content"\|"files_with_matches"\|"count"? | Output format |
| head_limit | number? | Max results (default 250) |

**Config**: `head_limit` (250), `max_columns` (500)

**Output — default config (content mode)**:
```
src/main.ts:42:const x = "hello";
src/utils.ts:15:const y = "world";
```

**Output — config.head_limit=5**:
```
grep-test/many.txt:1:match_line_0
grep-test/many.txt:2:match_line_1
grep-test/many.txt:3:match_line_2
grep-test/many.txt:4:match_line_3
grep-test/many.txt:5:match_line_4
```

**Output — input.head_limit=3 overrides config.head_limit=10**:
```
grep-test/many.txt:1:match_line_0
grep-test/many.txt:2:match_line_1
grep-test/many.txt:3:match_line_2
```

**Output — config.max_columns=100 (wide line truncated)**:
```
grep-test/wide.txt:1:TARGET xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx ...
```

**Output — output_mode=files_with_matches**:
```
grep-test/wide.txt
```

**Output — no match**:
```
No matches found.
```

---

### Glob

Find files by name pattern.

| Parameter | Type | Description |
|-----------|------|-------------|
| pattern | string | Glob pattern (e.g. `**/*.ts`) |
| path | string? | Directory to search |

**Output — default (all matching files)**:
```
file-7.dat
file-8.dat
file-9.dat
file-3.dat
file-4.dat
file-5.dat
file-6.dat
file-0.dat
file-1.dat
file-2.dat
```

**Output — config.result_limit=3**:
```
file-3.dat
file-4.dat
file-5.dat

... (6 total files, showing first 3)
```

**Output — scoped path**:
```
subdir/nested.dat
```

**Output — no match**:
```
No files matching '*.zzz' found.
```

---

### WebSearch

Search the web via configurable provider.

| Parameter | Type | Description |
|-----------|------|-------------|
| query | string | Search query |
| maxResults | number? | Max results (default 8, max 20) |

**Config**: `provider` ("duckduckgo"), `maxResults` (8), `searxngUrl`, `serpApiKey`, `braveApiKey`

**Providers**: DuckDuckGo (default, free), SearXNG (self-hosted), SerpAPI (paid), Brave (free tier)

**Output — default provider, 5 results**:
```
Found 5 results for: "test"

[1] R1
    https://a.com/1
    S1

[2] R2
    https://a.com/2
    S2

...

Sources:
- [R1](https://a.com/1)
- [R2](https://a.com/2)
...
```

**Output — input.maxResults=2**:
```
Found 2 results for: "test"

[1] R1
    https://a.com/1
    S1

[2] R2
    https://a.com/2
    S2

Sources:
- [R1](https://a.com/1)
- [R2](https://a.com/2)
```

**Output — empty results**:
```
No search results found for: "nothing"
```

**Output — config.provider error (network unavailable)**:
```
Search error: DuckDuckGo search failed: fetch failed
```

---

### WebFetch

Fetch a URL and return content in a specified format.

| Parameter | Type | Description |
|-----------|------|-------------|
| url | string | URL to fetch |
| format | "markdown"\|"html"\|"text"\|"json"? | Output format |
| headers | Record<string,string>? | Request headers |

**Config**: `format` ("markdown")

**Format behavior**:
- `markdown` (default): Strips script/style/nav, extracts `<main>` or `<article>` content, converts to clean markdown via Turndown
- `json`: Raw JSON, pretty-printed
- `text`: Plain text, strips all HTML tags, preserves paragraph breaks
- `html`: Raw HTML source

**Config priority**: input.format > config.format > default ("markdown")

**Output — markdown (simple page)**:
```
Example Domain
==============

This domain is for use in documentation examples without needing permission.

[Learn more](https://iana.org/domains/example)
```

**Output — markdown (GitHub repo page)**:
```
[anthropics](/anthropics) / **[claude-code](/anthropics/claude-code)** Public

*   [Fork 21.1k](/login)
*   [Star 130k](/login)

*   [Code](/anthropics/claude-code)
*   [Issues 5k+](/anthropics/claude-code/issues)
...
```

**Output — json (API endpoint)**:
```
{
  "userId": 1,
  "id": 1,
  "title": "sunt aut facere repellat provident occaecati",
  "body": "quia et suscipit\nsuscipit recusandae..."
}
```

**Output — error**:
```
Error: Failed to parse URL from not-a-url
```

---

### Agent

Delegate a task to a sub-agent.

| Parameter | Type | Description |
|-----------|------|-------------|
| task | string | Task description |
| model | string? | Model override |
| systemPrompt | string? | Custom system prompt |
| blocking | boolean? | Wait for result (default true) |

**Config**: `auto_background` (false), `auto_background_timeout` (0s)

**Blocking output**: The sub-agent's final text result
**Non-blocking output**: `task_id: <id>`

---

### Wait

Wait for background tasks or timeout.

| Parameter | Type | Description |
|-----------|------|-------------|
| timeout | number | Max wait in seconds (1-3600) |
| task_id | string? | Wait for specific task |

**Output — sleep fallback**:
```
Resumed after 1s.
```

**Output — event-driven wake**:
```
Woke after 1000ms
```

**Output — specific task_id**:
```
Task t1 done
```

---

### TaskList

List all background tasks.

| Parameter | Type | Description |
|-----------|------|-------------|
| filter | "all"\|"running"\|"completed"? | Status filter |

**Config**: `max_completed` (5)

**Output — config.max_completed=3 (8 tasks total)**:
```
Completed (showing 3 of 8):
✓ [t7] bash  completed  step:1  1s
    task 7
✓ [t6] bash  completed  step:1  1s
    task 6
✓ [t5] bash  completed  step:1  1s
    task 5
  ... and 5 older tasks

Total: 8 tasks, 0 running
```

**Output — config.max_completed=10 (shows all)**:
```
Completed (showing 8):
✓ [t7] bash  completed  step:1  1s
    task 7
...
✓ [t0] bash  completed  step:1  1s
    task 0

Total: 8 tasks, 0 running
```

**Output — filter=running, none active**:
```
No running tasks.
```

---

### TaskStatus

Check status and recent activity of a background task.

| Parameter | Type | Description |
|-----------|------|-------------|
| task_id | string | Task ID to check |

**Config**: `recent_turns` (6), `turn_length` (500 chars)

**Output — not found**:
```
Task nope not found.
```

**Output — running task with currentTool**:
```
task_id: t1
Status: running
Elapsed: 3s
Steps: 4
Current tool: Bash
```

**Output — completed task**:
```
task_id: t2
Status: completed
Elapsed: 5s
Steps: 8
```

---

### TaskStop

Stop a running background task.

| Parameter | Type | Description |
|-----------|------|-------------|
| task_id | string | Task ID to stop |

**Output — not found**:
```
Task nope not found.
```

**Output — not running**:
```
Task t1 is not running (status: completed).
```

**Output — stopped**:
```
Task t2 has been stopped.
```

---

### AskUser

Ask the user a question during execution.

| Parameter | Type | Description |
|-----------|------|-------------|
| questions | Array<{question, header?, options?, multiSelect?}> | 1-4 questions |

**Output**: `User responses:\n- <key>: <value>`

---

### TodoWrite

Update the task list.

| Parameter | Type | Description |
|-----------|------|-------------|
| todos | Array<{content, status, activeForm}> | Complete task list |

**Output — mixed statuses**:
```
Task list updated: 1/3 completed, 1 in progress.
```

**Output — all completed**:
```
Task list updated: 1/1 completed, 0 in progress.
```

---

## Config Parameter Reference

| Tool | Config Key | Type | Default | Description |
|------|-----------|------|---------|-------------|
| Bash | timeout | number | none | Command timeout in seconds |
| Read | max_lines | number | 2000 | Max lines to return |
| Read | default_mode | "full"\|"outline" | "full" | Default read mode |
| Read | max_file_size | number | 256 | Max file size in KB (0 = no limit) |
| Write | syntaxCheck | boolean | true | Check syntax after write |
| Edit | syntaxCheck | boolean | true | Check syntax after edit |
| Grep | head_limit | number | 250 | Max search results |
| Grep | max_columns | number | 500 | Max columns per line (truncate wide lines) |
| WebSearch | provider | string | "duckduckgo" | Search provider |
| WebSearch | maxResults | number | 8 | Max results per query |
| WebSearch | searxngUrl | string | — | SearXNG instance URL |
| WebSearch | serpApiKey | string | — | SerpAPI key |
| WebSearch | braveApiKey | string | — | Brave Search API key |
| WebFetch | format | string | "markdown" | Default output format |
| TaskList | max_completed | number | 5 | Max completed tasks to show |
| TaskStatus | recent_turns | number | 6 | Recent conversation turns |
| TaskStatus | turn_length | number | 500 | Max chars per turn |

---

## Test Results

All tool output formats verified via `npx tsx scripts/test-tool-output.ts`:

| Tool | Tests | Status |
|------|-------|--------|
| Bash | 7 | PASS |
| Read | 9 | PASS |
| Edit | 6 | PASS |
| Write | 4 | PASS |
| Grep | 5 | PASS |
| Glob | 4 | PASS |
| WebSearch | 5 | PASS |
| WebFetch | 3 | PASS |
| TaskList | 3 | PASS |
| TaskStatus | 3 | PASS |
| TaskStop | 3 | PASS |
| Wait | 3 | PASS |
| TodoWrite | 2 | PASS |
| **Total** | **57** | **ALL PASS** |

Run tests: `npx tsx scripts/test-tool-output.ts`
