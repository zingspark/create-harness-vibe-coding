# Blank evidence capture checklist

This is a capture checklist, not a result. Do not fill it with `success` or
`pass` claims. A category remains `NOT_RUN` until the named artifact exists on
disk, its SHA-256 is recorded, and an independent reviewer has inspected it.

Record only artifacts from the fresh isolated run:

- source SHA, package-archive SHA-256, preserved package archive, isolated root,
  evidence root, runtime/model/effort
- command steps with timestamps, source, status, and artifact paths
- B1: installed root, unchanged sentinel, installed artifact, install receipt/log
- B2: CLI path, unchanged public fixture path, exact stdout for both invocations
- B3: raw JSONL events/effects/execution log with joined task/dispatch/session/
  request/replyTo/attempt identities, one ACK and one terminal per attempt,
  one independent cancellation dispatch, one failed dispatch with at most one
  explicit retry in a new session, replay evidence with no additional side
  effect, and the result file/hash
- B4: raw teach/scene-skip/counterexample/supersede-or-disable/restore/feedback
  trace, effective-rule projection, and restored state whose audit retains the
  before-state prefix and appends history (whole-document byte equality is not
  required)
- B5: CSV prompt/input, raw lookup log, captured source, decision/recheck log
- B6: raw CLI/UI/browser observations, canonical state/hash, lock/reuse log, and
  a decodable PNG screenshot. JPEG/WebP are unsupported/pending in this scorer;
  preserve browser trace for manual review even for a valid PNG.
- independent review report, distinct reviewer identity, category-by-category
  decision, and evidence references

Use `status: not_run` with a concrete reason when an artifact cannot be captured.
Never create sealed holdout data or copy scorer answers into an agent fixture.
