# {{projectName}}

Project development notes belong here.

## Development Commands

Record the real project commands after bootstrap:

```bash
# Install dependencies
# e.g. npm install

# Run locally
# e.g. npm run dev

# Run tests
# e.g. npm test

# Build
# e.g. npm run build
```

Replace the examples with the real commands discovered from this project. If a command is unknown, record the open question in `Harness/tasks/<task-id>/PROGRESS.md`.

## Git And Release Notes

- Keep branch, commit, pull request, CI, and release conventions in this README.
- Do not place build scripts, git policy, or project maintenance instructions in `CLAUDE.md`.
- Keep code architecture notes in `Harness/project/architecture.md` or feature docs.
- For README improvements, use `.claude/skills/wf-readme/SKILL.md`; preserve public docs unless a rewrite is approved.

## Harness

The agentic engineering harness lives in `Harness/`.

- Normal agent sessions start from `CLAUDE.md`.
- Use `Harness/specs/guides/SETUP.md` only for install/bootstrap guidance, migration, upgrade decisions, or explicit setup requests.
- Use `Harness/README.md` as the Harness workflow router when a routed task needs it.
- Load memory and resource registrations from `Harness/MEMORY.md` only when routed.
- Track active work in `Harness/PROGRESS.md` and `Harness/tasks/<task-id>/PROGRESS.md`.
- Use `/wf-update` or `$wf-update` for Harness upgrades; the agent should report version, changed files, validation results, and release highlights from update metadata.
- Use `Harness/specs/workflows/WF.md` only when the user explicitly invokes a WF command such as `/wf` or `/wf-max`; complex work may still use direct planning, tests, and subagents without entering WF.

### Harness intelligence routing

Workflow entry points create a bounded, role-scoped task context pack before
dispatch and regenerate it on resume. External research is conditional: the
local policy checks capability gaps, volatile APIs, explicit requests, repeated
failures, or benchmark gaps before an agent reads current web, GitHub, or
Hugging Face sources. Source URL, version/terms, date, and adopt/adapt/reject
rationale remain part of task evidence. Packs and structural checks improve
boundaries but do not replace semantic validation.

`/wf-max` uses evidence-driven WF-Max-Useful fan-out by default; a dependency
chain, absent independent acceptance, or coordination cost without benefit may
be recorded as no-spawn. WF-Max-Strict is enabled only by an explicit strict
request and remains bounded by actual runtime capacity. Direct commands such as
`/wf-help`, `/wf-task-list`, `/wf-init`, and `/wf-update` stay direct and do not
force task routing or external research.
  - Claude Code: invoke the `wf` skill with `/wf`.
  - Codex: invoke the `wf` skill with `$wf` or `/skills`.
- Use `Harness/specs/runtime/subagents.md` when coordinating multiple agents.

Tool discovery files stay at the repository root:

- Claude Code: `.claude/settings.json`, `.claude/agents/`, and `.claude/skills/`.
- Codex: `.agents/skills/` for repo skills and `.codex/` for config placeholders. The bundled update reminder uses a startup-only hook; avoid turn-by-turn runtime hooks unless `/wf-auto` explicitly opts into a bounded tick hook.
