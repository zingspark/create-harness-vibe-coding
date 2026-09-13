# {{TASK_ID}} - PLAN

Compact task record. Default: keep 1-3 concise ACs unless the task explicitly needs a broader acceptance matrix.

## Goal

- Outcome:
- Non-goals:

## Scope

- Write set:
- Forbidden:

## Decisions

| # | Decision | Reason | Date |
|---|----------|--------|------|
|   |          |        |      |

## Acceptance

| ID | Criterion | Evidence | Status |
|----|-----------|----------|--------|
| AC-001 |           |          | pending |

Expanded evidence required when triggered by high-risk changes, broad cross-file edits, release work, or user request.

## Expanded Contracts

- Add Given/When/Then, selector contracts, migration notes, or release evidence only when the task risk requires it.

## Context Contract

- Keep the original intent immutable; record later changes under `STATE.json.context.intent.changes`.
- Store only compact constraints, facts, assumptions, decisions, evidence pointers, attempts, and handoff items. Keep raw logs outside `STATE.json`.
- The canonical next action lives at the root `STATE.json.nextAction`; context packs must reference it rather than add another next-action field.

## Risks

| Risk | Mitigation | Status |
|------|------------|--------|
|      |            |        |
