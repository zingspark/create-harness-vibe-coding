# Harness 0.9.2 intelligence benchmark fixtures

These are pre-registered fixtures and evidence contracts for B1-B6 in
`Harness/tasks/task-upgrade-harness-092/BENCHMARK.md`. They are repository-only
proof assets. They are deliberately outside `templates/` and are not included
in the npm package.

## Operator boundary

Run a candidate from a fresh, isolated install. The executing agent may read
only the installed Harness and its own fixture project; it must not read the
development repository, this directory's manifest, the scorer, or a sealed
holdout. The benchmark runner is an evaluator tool, not an agent tool. It does
not create an agent transcript, claim a successful run, or manufacture output
files.

Use the same runtime, model, effort, permissions, fixture, and user request for
the Harness run and the ordinary-handoff baseline. A baseline handoff must
contain every requirement needed to do the work; it is not intentionally
crippled.

## B2 public fixture contract

`b2/data.json` contains only `records`; do not add expected totals to it. The
candidate CLI is invoked as:

```text
node <cli-path> <absolute-data.json>
node <cli-path> <absolute-data.json> --exclude-refunds
```

Each invocation must write exactly one JSON object to stdout with exactly these
fields: `{"currency":"CNY","totalMinor":N}`. The public oracle expects
1350 without the flag and 1800 with it. `--exclude-refunds` excludes negative
amounts and must not change the no-flag behavior.

`stage1-user-prompt.md` describes the initial implementation. After an
interruption, `stage2-user-prompt.md` is shown with a fresh agent's task
context and code only; it must not rely on the prior chat. `baseline-handoff.md`
is the same-model ordinary handoff and includes the same requirements and
permissions.

The B3-B6 prompts are business-level requests. The executing agent may read
the installed Harness skills and its own fixture, then choose the appropriate
context, memory, reuse, runtime, CLI, or UI tools. These prompts deliberately
do not contain a command-by-command answer or scorer details.

## Evidence contract

The scorer consumes a run evidence JSON passed with `--oracle --run`. Missing
evidence is `NOT_RUN`/failure; a self-reported `pass` flag is never sufficient.
Top-level evidence must include non-empty `sourceSha`, `packageHash`,
`isolatedRoot`, `runtime`, `model`, and `effort`, plus `startedAt`, `endedAt`,
`steps`, `rework`, `recovery`, `duplicateSideEffects`, `estimated`, and
`providerMeasured`, and a `baseline` section. Provider token/cost values may be the literal `"unknown"`
when telemetry is unavailable; estimates remain separate.

The baseline is either `status: "run"` with a handoff path and explicit proof
of the same fixture/permissions/runtime/model/effort, or `status: "not_run"`
with a concrete reason. It is never silently omitted.

Category evidence is intentionally mechanical:

* B1 requires an actual installed root, sentinel, artifact, preserved package
  archive, install receipt, and raw install log. The oracle reads those files,
  hashes the sentinel, archive, and installed artifact on disk, and cross-checks
  the receipt and log against `sourceSha` and `packageHash`.
* B2 names the CLI and data paths. The oracle executes the CLI twice and
  validates both stdout JSON values.
* B3 requires raw JSONL event/effect/execution logs, including a strict join of
  `taskId` (when present) + `dispatchId` + `sessionId` + `requestId` + `replyTo`
  + integer `attempt` on every request, ACK, failure/cancellation, and RESULT.
  A valid trace contains one independent cancellation dispatch and a separate
  dispatch whose attempts are contiguous: one failed/cancelled attempt followed
  by at most one explicit retry in a new session. A requestId may be retained
  across those two attempts when it is still bound to the same dispatch; it may
  not cross dispatches, sessions within an attempt, or stale replyTo joins.
  Every attempt has exactly one request, one ACK, and one terminal event, and the
  current retry has its own successful RESULT. A terminal event from a cancelled
  or failed prior request cannot satisfy the current retry. The effects log
  proves the independent cancellation dispatch, the repeated idempotent retry
  dispatch, replay with no additional side effect, and exactly one result write.
  The log records a requested Codex-to-Claude route; an oracle cannot establish
  the truth of a natural-language claim about runtime identity, so that remains
  an independent-review duty.
* B4 is required and cannot be marked whole-category `skip` or `notApplicable`.
  The trace must show: teach a project/task-scoped rule → a new non-applicable
  scene skips that rule only → counterexample → supersede/disable → restore the
  prior state → retrieval/feedback. The scorer compares the documented
  effective projection of the target rule (`id`, `scope`, `status`, and
  effective `version`/`ruleVersion`/`revision` plus
  `contentContract`/`content` when present), not whole-document bytes. The
  restored audit array must retain the complete before-state audit as an exact
  prefix and append new history; counterexample, supersede/disable, restore,
  and feedback must be present across the appended audit/trace/feedback
  evidence. A per-scene skip is evidence; it is not permission to skip B4.
* B5 requires a genuinely CSV-shaped task, raw lookup log, captured source
  artifact, and a decision log with version/license, adopt/adapt/reject reason,
  and recheck trigger. The oracle checks paths, hashes, URLs, and logs; it does
  not pretend to prove source authenticity, license validity, or semantic reuse.
  Those require independent review.
* B6 requires raw backend and UI observation artifacts, a canonical state file
  hashed on disk, and a genuinely decodable PNG screenshot artifact. JPEG/WebP
  are explicitly unsupported by this lightweight scorer and remain pending
  until a mature decoder is adopted; they cannot pass by marker inspection.
  Lock/reuse evidence must also be present. The raw artifacts must agree on
  the absolute project root, task ID, URL, and state; the CLI-only start and
  UI/API agreement cannot be supplied by booleans in the evidence JSON alone.
  PNG decoding is only a mechanical integrity gate: a valid image is not proof
  that a browser rendered the claimed UI. Preserve the real-browser
  trace/observation and leave visual/UI truth to the distinct independent
  manual review.

Every B1/B3-B6 category has a `mechanical` result and requires an independent
manual review record. The review report must name a distinct reviewer and every
category. Missing artifacts are `NOT_RUN`; pending review blocks the overall
result. A self-reported `success` field, prefilled status, or natural-language
claim cannot manufacture a pass.

Use `evidence-template.md` only as a blank capture checklist. It contains no
successful result and must be filled from real fresh-install files and raw
logs. `--self-check` exercises only the runner's mechanical checks; it is not a
benchmark run and produces no category result.

The runner emits one category row with `n`, `pass`, `fail`, `notRun`, `pending`,
and `skip`, and never labels a single smoke run SOTA or world-leading.
