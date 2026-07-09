---
name: skill-creator
description: Create new zero-core skills, and modify or improve existing ones. Use whenever the user wants to create a skill from scratch, edit an existing skill, refine a skill's triggering, or iterate on a skill until it works well. Trigger this skill proactively on any mention of "skill", "make a skill", "create a skill", "improve this skill", or when capturing a reusable workflow as a skill.
---

# Skill Creator (zero-core)

A skill for creating new zero-core skills and iteratively improving them.

At a high level, the process of creating a skill goes like this:

- Decide what you want the skill to do and roughly how it should do it
- Write a draft of the skill
- Run a few realistic test prompts (with the skill enabled) and look at the results
- Help the user evaluate the outputs, both qualitatively and against objective criteria
- Rewrite the skill based on the feedback
- Repeat until you and the user are satisfied

Your job when using this skill is to figure out where the user is in this process and then jump in to help them progress. Sometimes they say "I want to make a skill for X" — you help narrow down what they mean, write a draft, design test cases, and iterate. Sometimes they already have a draft — you go straight to the eval/iterate part. Always stay flexible; if the user says "just vibe with me", do that instead.

## zero-core skill conventions

zero-core skills live as folders under the **`[skills]/` virtual path channel**. The agent never touches real disk paths directly — all reads/writes go through the virtual prefix, which the runtime resolves to the underlying directory.

- **identity = directory name (id)**. The folder name (`<skill-id>`) is the stable identity used in `skillPolicy.enabledSkills` and the `[skills]/<id>/...` path. Path-safe: letters, digits, `.`, `_`, `-`; 1–64 chars.
- **display name = frontmatter `name`**. May differ from the directory name. Falls back to the directory name when absent.
- **`description` frontmatter is the primary trigger mechanism** — it's the only thing in the system prompt that decides whether a skill fires. Put both *what the skill does* AND *when to use it* here, not in the body. Make it a little "pushy" (see Writing Guide) to combat under-triggering.
- **`${SKILL_DIR}` / `${CLAUDE_SKILL_DIR}`** inside skill bodies resolve to `[skills]/<id>` — use them so the skill stays portable across the zero-core and Claude ecosystems.
- New skills created via this skill land under the **app skills root** (`~/.zero-core/skills/`); external skills from `~/.claude` / `~/.agents` are read-only.

> **Note**: zero-core currently has **no automated eval infrastructure** (no benchmark aggregator, no description-optimization loop, no eval-viewer). The loop below is a **manual test cycle** — write the skill, run real prompts, evaluate with the user, revise. Automated eval tooling may be added later; for now keep it hands-on.

## Creating a skill

### Capture Intent

Start by understanding the user's intent. The current conversation might already contain a workflow the user wants to capture ("turn this into a skill"). If so, extract answers from the conversation history first — tools used, sequence of steps, corrections the user made, input/output formats. The user may need to fill the gaps, and should confirm before proceeding.

1. What should this skill enable the agent to do?
2. When should it trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Should we set up test cases? Skills with objectively verifiable outputs (file transforms, data extraction, fixed workflow steps) benefit from test cases. Skills with subjective outputs (writing style, art) often don't. Suggest the appropriate default, but let the user decide.

### Interview and Research

Proactively ask about edge cases, input/output formats, example files, success criteria, and dependencies. Wait to write test prompts until you've got this part ironed out. If useful MCPs/search tools are available, research in parallel via subagents; come prepared with context to reduce the burden on the user.

### Write the SKILL.md

Based on the user interview, create the skill using the **`Write` tool** with the virtual path:

```
[skills]/<new-skill-id>/SKILL.md
```

Fill in these frontmatter components:

- **`name`**: Human-readable display name (may differ from the directory name).
- **`description`**: When to trigger + what it does. **This is the primary triggering mechanism** — include both what the skill does AND specific contexts for when to use it. All "when to use" info goes here, not in the body. Make it a little "pushy" — instead of "Build a dashboard", write "Build a fast internal dashboard. Use this skill whenever the user mentions dashboards, data visualization, internal metrics, or wants to display any kind of data, even if they don't explicitly ask for a 'dashboard.'"
- **the body**: when to use, the procedure, examples (see Writing Guide below).

A minimal new skill:

```
---
name: My New Skill
description: <one-line; what it does + when to use it>
---

# My New Skill

<when to use, the procedure, examples>
```

### Validate the skill (required)

After writing the draft, **you must run the format validator** before considering the skill done:

```
node ${SKILL_DIR}/scripts/validate-skill.mjs [skills]/<new-id>/
```

`${SKILL_DIR}` and any `[skills]/<id>/` token are resolved by the Shell channel to real paths, so this works from any agent. The validator checks (and reports each failure on its own line):

- SKILL.md exists and has a valid `--- ... ---` frontmatter block
- frontmatter has non-empty `name`
- frontmatter has non-empty `description` (this is the primary trigger — scanner silently drops skills without one)
- `description` length ≥ 10 chars (warning only — too-strict would over-reject; fix if reasonable)
- SKILL.md ≤ 256KB (scanner skips larger files; the skill would vanish)
- directory name (id) is path-safe (`[a-zA-Z0-9._-]`, 1–64 chars; no spaces / `.` / `..` / separators)
- body is non-empty (content after the frontmatter)

If it prints `✓ skill valid` you're clear. If it lists problems, fix each one and re-run — **the skill is not complete until validation passes**. Re-run after every meaningful edit to the draft, not just once at the end (cheaper than discovering a malformed skill mid-test-loop).

### Skill Writing Guide

#### Anatomy of a Skill

```
skill-id/                      ← directory name = identity (path-safe)
├── SKILL.md                   (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown body
└── Bundled Resources (optional)
    ├── scripts/               Executable code for deterministic/repetitive tasks
    ├── references/            Docs loaded into context as needed
    └── assets/                Files used in output (templates, icons, fonts)
```

#### Progressive Disclosure

Skills use a three-level loading system:

1. **Metadata** (`name` + `description`) — always in the agent's context (~100 words). This is what triggers the skill.
2. **SKILL.md body** — read into context whenever the skill triggers (<500 lines ideal).
3. **Bundled resources** — read/run as needed (unlimited; scripts can execute without being loaded).

Keep SKILL.md under 500 lines. If you approach that limit, add another layer of hierarchy with clear pointers to where the agent should go next (e.g. `references/aws.md`). For large reference files (>300 lines), include a table of contents.

#### Writing Patterns

- **Prefer the imperative form** in instructions.
- **Explain the why** behind each instruction instead of stacking rigid MUSTs. zero-core agents are smart — when given the reasoning they generalize; when given bare commands they overfit. If you catch yourself writing ALWAYS/NEVER in caps, reframe and explain the reasoning instead.
- **Define output formats** with templates:
  ```markdown
  ## Report structure
  Use this exact template:
  # [Title]
  ## Executive summary
  ## Key findings
  ## Recommendations
  ```
- **Include examples** — concrete input/output pairs teach better than abstract prose.
- **Look for repeated work across test runs.** If every test case made the agent independently write the same helper script, bundle that script into `scripts/` and reference it — saves every future invocation from reinventing the wheel. (This skill ships its own `scripts/validate-skill.mjs` for exactly this reason — see "Validate the skill" below.)

#### Principle of Lack of Surprise

Skills must not contain malware, exploit code, or anything that would surprise the user in its intent if described. Don't go along with requests to create misleading or malicious skills.

### Writing Style

Explain the *why* behind everything. Use theory of mind; make the skill general rather than over-narrow to specific examples. Start with a draft, then re-read it with fresh eyes and improve.

## Test cases (manual)

After writing the draft, come up with 2–3 realistic test prompts — the kind of thing a real user would actually say, with concrete details (file paths, real column names, actual company context). Share them with the user: "Here are a few test cases I'd like to try — do these look right, or do you want to add more?"

Save the test prompts somewhere (e.g. `[skills]/<id>/evals.md` or in the conversation) so you can re-run them after each revision. You don't need formal assertions for subjective skills — qualitative review with the user is enough.

## The manual test loop

This is the heart of the process. zero-core has no automated eval harness yet, so the loop is hands-on:

1. **Enable the skill** on an agent (SkillsSection toggle, or the test agent has the skill in `skillPolicy.enabledSkills`).
2. **Run each test prompt** against an agent that has the skill enabled. Capture the output.
3. **(Optional) Run a baseline** — the same prompt against an agent *without* the skill. Comparing the two shows whether the skill is actually adding value.
4. **Evaluate with the user** — show the outputs side by side. For objective skills, check whether the output meets the stated criteria. For subjective skills, ask the user how it looks.
5. **Improve the skill** based on the feedback (see below).
6. **Re-run the test prompts** and compare against the previous iteration. Repeat until the user is satisfied.

Stop when:
- The user says they're happy
- All test cases produce acceptable outputs
- You're not making meaningful progress between iterations

## Improving the skill

### How to think about improvements

1. **Generalize from the feedback.** The goal is a skill that works across many real prompts, not just the 2–3 test cases. Don't add fiddly overfit fixes; if there's a stubborn issue, try branching out — different metaphors, different working patterns. It's cheap to try and you might land on something great.
2. **Keep the prompt lean.** Remove parts that aren't pulling their weight. Read the transcripts, not just the final outputs — if the skill is making the agent waste effort on something unproductive, cut the part causing it.
3. **Explain the why.** Transmit understanding, not just instructions. Even terse user feedback usually points at a real underlying need — understand it and bake the reasoning into the skill.
4. **Look for repeated work across test cases.** If all test cases made the agent write a similar helper, bundle it into `scripts/`.

### The iteration loop

After improving the skill:

1. Apply the improvement (Write/Edit on `[skills]/<id>/SKILL.md` or a sibling file).
2. **Re-run the validator** (`node ${SKILL_DIR}/scripts/validate-skill.mjs [skills]/<id>/`) — an edit that breaks the frontmatter or empties the body will silently kill triggering; catch it now, not at the next failed test.
3. Re-run all test prompts.
4. Compare outputs to the previous iteration.
5. Get user feedback, improve again, repeat.

Keep going until the user is satisfied, the outputs are all acceptable, or progress stalls.

## After the skill is done

- Offer to **re-read the `description`** one more time and tighten it for triggering accuracy (the manual equivalent of description optimization — think about near-miss queries that should *not* trigger, and edge cases that should).
- Mention that the skill is now visible to any agent with it enabled in `skillPolicy.enabledSkills`, and editable from the Skills page (app skills only).

---

Repeating the core loop for emphasis:

- Figure out what the skill is about
- Draft or edit the skill (Write to `[skills]/<id>/SKILL.md`)
- Run real test prompts against an agent that has the skill enabled
- Evaluate outputs with the user (qualitative + objective criteria)
- Improve and repeat until satisfied

Good luck!
