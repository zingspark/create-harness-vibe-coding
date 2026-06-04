# {{projectName}} — Docs Entry Point

> **Purpose**: A shared project map for humans and coding agents. `AGENTS.md` tells agents to read `CLAUDE.md` first, then enter the project fact source from here.
>
> **Principle**: Short entry + topic-specific docs. Don't cram everything into `CLAUDE.md` or `AGENTS.md`.

---

## 0-1 Required Project Flow

When starting from scratch, produce docs in this order. Don't move to the next phase without a minimum viable conclusion from the previous one.

| Order | Artifact | Must Answer | Completion Standard |
| --- | --- | --- | --- |
| 1 | [research/scaffolds.md](research/scaffolds.md) | What do others do? Which templates, frameworks, constraints? Why adopt/reject? | At least 3 references; each with Purpose / Strength / Weakness / Decision |
| 2 | [research/PRD.md](research/PRD.md) | What does this MVP solve? What is explicitly NOT in scope? How to verify? | One page; MVP, Non-goals, verifiable acceptance criteria |
| 3 | [harness/architecture.md](harness/architecture.md) | How many layers? Component boundaries? What can/can't harness do? | Layer dependencies, core components, non-negotiable constraints, key decisions |
| 4 | [domain/ports.md](domain/ports.md) | What contracts between layers? Error and idempotency semantics? | Each port: preconditions, postconditions, error semantics, known implementations |
| 5 | [harness/data-flow.md](harness/data-flow.md) | Normal path and failure paths? What does the caller see? | At least 1 core flow; each failure point has system behavior and recovery |
| 6 | [harness/state-machines.md](harness/state-machines.md) | Which components have state? Which transitions are legal/illegal? | Each stateful component: state enum, transition table, illegal transitions |
| 7 | [harness/agent-workflow.md](harness/agent-workflow.md) | How do agents divide work, TDD, verify, and close? | Feature doc template, subagent roles, write set, completion criteria |
| 8 | tests + implementation | Is the design proven by code? | Minimal vertical slice runs; tests cover core success/failure paths |

**Hard gates**:
- If a doc still has `{{...}}` placeholders, don't claim the architecture is finalized.
- **Minimum docs to start coding**: `research/PRD.md` + `harness/architecture.md` + at least 1 filled port contract. Once there, start a minimal vertical slice, but record risks from missing `data-flow.md` / `state-machines.md` in the feature doc or tests.
- If architecture boundaries change, sync docs and tests.
- If implementation spans more than one short session, open a feature doc from [features/_template.md](features/_template.md) first.

## Doc Completion Standards

| Doc | Minimum Standard | Can Defer |
| --- | --- | --- |
| `research/scaffolds.md` | At least 3 references; each with Purpose / Strength / Weakness / Decision; final decision recorded | Rejected options can be backfilled |
| `research/PRD.md` | Why, MVP, Non-goals, decision priorities, acceptance criteria are not placeholders | Non-functional targets can start as MVP-level goals |
| `harness/architecture.md` | Layer dependencies, core components, at least 1 ADR, non-negotiable constraints | Runner variants can say "none yet" when only one runner exists |
| `domain/ports.md` | At least 1 port with preconditions, postconditions, error semantics, idempotency, known impls | Additional ports can be added incrementally with features |
| `harness/data-flow.md` | At least 1 core flow with normal + failure paths | Secondary flows can come later |
| `harness/state-machines.md` | Every stateful component has state enum and transition table | Stateless components don't need entries |
| `harness/agent-workflow.md` | Feature doc, write set, verification, closure criteria are clear | Subagent roles can expand as needed |
| `features/*.md` | Requirements / Design / Tasks / Verification closed loop | Minor fixes can take the fast lane with a reason |

---

## Harness Boundary

The current template uses `interfaces -> harness -> application -> domain` with `infrastructure` adapters. The `domain` is any business domain: data analysis, document processing, code repair, ops automation — all can hang off the same harness.

| Layer | Responsible For | NOT Responsible For |
| --- | --- | --- |
| `interfaces/` | CLI / API / UI entry points | Business rules, data source details |
| `harness/` | Runtime shell, scheduling, safety gates, audit, observability, failure control | Domain business rules, domain decisions, adapter implementation details |
| `application/` | Use-case orchestration, composing domain ports into business actions | Specific external service implementations |
| `domain/` | Business objects, business invariants, port protocols | Importing harness / infrastructure / interfaces |
| `infrastructure/` | Filesystem, database, external API, model service port implementations | Defining business contracts |

How to decide: if it "protects, records, schedules, recovers the system during runtime" → harness. If it "decides whether a business action should happen and what it means" → application/domain.

---

## Doc Map

```text
docs/
├── README.md                       ← You are here
├── features/
│   └── _template.md                ← Single-feature implementation doc template (Kiro-lite)
├── harness/
│   ├── agent-workflow.md           ← Agent roles, TDD, closure, write set rules
│   ├── architecture.md             ← Component map, layer rules, key design decisions
│   ├── data-flow.md                ← End-to-end event flow: normal + error paths
│   └── state-machines.md           ← Stateful component transition diagrams and tables
├── domain/
│   └── ports.md                    ← Cross-layer interface contracts: pre/post, error semantics
└── research/
    ├── PRD.md                      ← One-page MVP scope and acceptance template
    └── scaffolds.md                ← Research conclusions, reference templates, tech rationale
```

---

## Reading Order

| Role | Read First | Then |
| --- | --- | --- |
| New developer | [research/PRD.md](research/PRD.md) | [harness/architecture.md](harness/architecture.md) |
| Implementer | [harness/agent-workflow.md](harness/agent-workflow.md) | [features/_template.md](features/_template.md) |
| Reviewer | [harness/state-machines.md](harness/state-machines.md) | tests |
| Architecture maintainer | [research/scaffolds.md](research/scaffolds.md) | [harness/architecture.md](harness/architecture.md) |

---

## Maintenance Rules

- Code change affects architecture → update `harness/architecture.md`.
- New cross-layer interface → update `domain/ports.md`.
- New flow or failure path → update `harness/data-flow.md`.
- New stateful component → update `harness/state-machines.md`.
- New external dependency, template, or framework choice → update `research/scaffolds.md`.
- Non-trivial feature → copy `features/_template.md`, follow `harness/agent-workflow.md`.
- Docs rules repeatedly ignored by agents → don't lengthen entry files; turn rules into tests, lint, or more specific templates.

---

## External References

- OpenAI, Harness Engineering: short `AGENTS.md` as directory, `docs/` as fact source; architecture boundaries enforced by tests/lint.
- Anthropic, Claude Code Best Practices: `CLAUDE.md` kept short and maintainable; use `@docs/...` to pull in project docs.
- OpenAI, PLANS.md / ExecPlans: complex tasks use self-contained, verifiable, recoverable execution plans.
- GitHub Spec Kit / Kiro Specs: borrow requirements -> design -> tasks -> verification structure.
- Anthropic, Building Effective Agents: agent loops need environment feedback, clear stop conditions, and human checkpoints.
- arc42 / C4 / ADR / ARCHITECTURE.md: provide architecture chapters, static structure views, decision records, and lightweight code maps respectively.
