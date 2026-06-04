---
description: "Universal coding principles — always applied"
alwaysApply: true
---

# Universal Coding Rules

## Architecture Boundaries (CLAUDE.md enforced)
- `domain/` depends on stdlib only — no infrastructure imports ever
- `application/` depends on `domain/` only
- `infrastructure/` implements ports defined in `domain/`
- `harness/` coordinates workflows, contains no domain business rules

## Code Style
- Prefer small, deterministic, pure functions
- Functions > 30 lines need a comment explaining why they can't be split
- No hidden global state in strategy or service objects
- Explicit over implicit: type hints on all function signatures

## Git Workflow
- Commit format: `type(scope): message` — types: feat/fix/test/docs/refactor/chore
- Every feature PR must include: implementation + tests + doc update
- Keep commits atomic; one logical change per commit

## Testing
- Write tests before or alongside implementation, not after
- Test behavior, not implementation details
- Tests must be deterministic and not depend on wall-clock time

## Security
- No API keys or secrets in source code — use environment variables
- Validate all external data at system boundaries
