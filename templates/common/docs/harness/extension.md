# Extension Contract

Purpose: keep stack-specific agents, skills, rules, and hooks compatible with this harness.

Use during setup whenever adding assets from ECC, SuperClaude, toolboxes, or local project conventions.

## Agent Contract

Every added agent must have frontmatter:

```yaml
---
name: stack-agent-name
description: Use when ...
tools: Read, Grep, Glob
model: sonnet
skills: harness-context
---
```

Choose one harness skill:

| Agent Type | Skill |
| --- | --- |
| research, docs, API lookup | `harness-research` |
| planning, architecture, context split | `harness-context` |
| tests, implementation, debugging, review, verification | `harness-build-loop` |

Agent body must state:

- load first
- inputs required
- allowed write set or read-only
- forbidden scope
- verification or evidence
- return format from [dispatch.md](dispatch.md)

## Skill Contract

Every added skill must state:

- when to use
- docs to load
- required inputs
- allowed writes
- output format
- whether to update `docs/harness/PLAN.md`
- whether to use [dispatch.md](dispatch.md)

Skills should extend the harness. They should not replace `docs/README.md`, `PLAN.md`, `context-loading.md`, `dispatch.md`, or `agent-workflow.md`.

## Rules

- Do not add broad agents that can write anywhere.
- Do not add agents whose role overlaps an existing common agent without naming the difference.
- Do not add tools that bypass project permissions or user approval.
- Do not run stack-specific writing agents in parallel unless write sets are disjoint.
- If an added asset conflicts with this harness, adapt the asset instead of changing the core contract.

## Registration

After adding assets:

- list agents in `MEMORY.md#Agents`
- list skills in `MEMORY.md#Skills`
- update `docs/harness/PLAN.md` when the asset affects current work
- run `node scripts/validate-harness.mjs`
