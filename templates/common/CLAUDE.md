# CLAUDE.md

## 📖 Doc Navigation (read before every task)

`@docs/README.md` is the project fact source. Route by role:

| Your Role | Required Reading |
|-----------|-----------------|
| Writing code / implementing | `docs/harness/agent-workflow.md` → `docs/features/_template.md` |
| Designing architecture / new modules | `docs/harness/architecture.md` → `docs/domain/ports.md` |
| Reviewing code | `docs/harness/state-machines.md` → tests |
| Fixing bugs / debugging | `docs/harness/data-flow.md` → `docs/harness/state-machines.md` |
| New to the project | `docs/research/PRD.md` → `docs/harness/architecture.md` |

**Hard rules**:
- Before touching cross-layer boundaries, read `docs/domain/ports.md`
- Before adding failure paths, read `docs/harness/data-flow.md`
- Before modifying stateful components, read `docs/harness/state-machines.md`
- Unsure whether to open a feature doc? Read `docs/harness/agent-workflow.md` §1
- **Every new session must read `@MEMORY.md`** for accumulated context

---

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## 5. Memory & Self-Learning

When a user expresses "remember / preference / habit / correction" intent, **persist to `MEMORY.md`** for reuse across sessions.
**Important**: Every new session must read `@MEMORY.md`.

### 5.1 Trigger Words

When the user's message contains these keywords or intent, write to `MEMORY.md`:

| Trigger Phrase | Meaning | Write To |
|---|---|---|
| "remember…", "note…", "save…" | User wants to persist a fact/preference | User Mem |
| "don't ever…", "never…", "stop doing…" | User corrects a behavior — avoid in future | User Mem |
| "next time…", "always…", "from now on…" | User specifies a future default behavior | User Mem |
| "I prefer…", "I like…", "my workflow…" | User expresses a work habit or preference | User Mem |

If unclear whether a message triggers memory, ask the user before writing. Don't auto-record every conversation.

### 5.2 MEMORY.md Write Format

Append to `## User Mem` in `MEMORY.md`, newest first:

```markdown
### YYYY-MM-DD — <short title>
- **Trigger**: <user's exact words>
- **Behavior**: <what to do / what to avoid going forward>
- **Why**: <user's reason, if provided>
```

### 5.3 Self-Learning: Tool Usage Standards

When Claude Code discovers the following patterns (without involving user privacy), auto-append to `## Tool Usage Standards` in `MEMORY.md`:

| Pattern Discovered | Record |
|---|---|
| A tool/MCP/skill fails 3+ times when called frequently, or has a better alternative | Record: scenario → failure cause → recommended alternative |
| A code error repeats in the same file/module (lint errors, type errors, import errors) | Record: error type → trigger condition → fix template |
| A skill/MCP is called in a way that deviates from best practices, causing inefficiency | Record: correct usage → usage to avoid |

Format:

```markdown
### <tool/skill name> — <brief issue>
- **Scenario**: <when it triggers>
- **Problem**: <specific symptom>
- **Solution**: <recommended approach>
- **Date**: <first recorded date>
```

If the same issue already exists, update it rather than creating a duplicate. If a new finding contradicts an old record, replace the old one and note the date.
