---
name: harness-research
description: Use for market, product, stack, dependency, API, pricing, legal, security, or open-source research before PRD or architecture decisions.
---

# Harness Research

Load:

- `docs/research/README.md`
- `docs/research/research-results.md`
- `docs/harness/PLAN.md`

Define:

- research question
- decision needed
- source boundaries
- tool choice: local / GitHub / Tavily / TinyFish / built-in web search / user-provided sources
- fallback when the preferred tool is unavailable
- return format

Return:

- queries and tools used
- sources with links and source type
- adopted / rejected / watch decisions
- risks and unknowns
- patch-ready `docs/research/research-results.md` update
