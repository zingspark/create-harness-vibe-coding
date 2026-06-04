---
name: harness-build-loop
description: Use for implementation, review, debugging, verification, and closing a feature.
---

# Harness Build Loop

Load:

- `docs/harness/agent-workflow.md`
- `docs/harness/dispatch.md` when more than one agent is useful
- `docs/harness/PLAN.md`
- current feature doc if present

Follow:

```text
acceptance criteria -> failing test/manual check -> implementation -> verify -> review -> docs sync
```

Close only with recorded verification evidence.
