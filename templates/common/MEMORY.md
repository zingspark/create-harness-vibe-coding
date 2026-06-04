# MEMORY.md — {{projectName}} Project Resource Index

> The project fact source is reached via `CLAUDE.md -> docs/README.md`. This file persists cross-session context: resource index, user preferences, tool usage standards.

## Agents (Sub-agents)

> Pending initialization by Claude Code from [ECC](https://github.com/affaan-m/ECC).
> Init command: describe your project type and language to Claude — it will pull matching agents.

## Skills (Workflows)

> Pending initialization by Claude Code from [ECC](https://github.com/affaan-m/ECC) or [awesome-claude-code-config](https://github.com/Mizoreww/awesome-claude-code-config).

## Rules (Code Rules)

Located under `.claude/rules/ecc/`, auto-loaded by the CC engine:

- [common.md](.claude/rules/ecc/common.md) — Universal coding rules (alwaysApply: true)
- Language-specific rules pending Claude Code initialization (e.g. python.md, typescript.md, etc.)

## Harness (Runtime)

- [Architecture docs](docs/harness/architecture.md)
- [Agent workflow](docs/harness/agent-workflow.md)

## User Mem

> User preferences, habits, corrections. Written by CLAUDE.md §5 triggers, newest first.
> No entries yet — awaiting first "remember…" instruction.

## Tool Usage Standards

> Claude Code self-learning: high-frequency tool/MCP/skill pitfalls, alternatives, common error fix templates.
> Written by CLAUDE.md §5.3 triggers.
> No entries yet — awaiting first auto-discovery.
