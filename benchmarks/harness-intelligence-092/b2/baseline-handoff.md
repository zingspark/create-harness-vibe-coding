# Ordinary handoff for the comparison run

This is a same-model, same-runtime, same-effort comparison. Work only in the
isolated project and preserve the user-created sentinel and `b2/data.json`.

Implement a billing CLI that reads the first JSON path argument and prints
exactly one JSON object to stdout with exactly the fields `currency` and
`totalMinor`. Without flags, sum all `records[].amountMinor`. Add
`--exclude-refunds` so negative amounts are excluded only when that flag is
present; verify that the no-flag behavior remains unchanged. Record commands,
outputs, failed assumptions, evidence status, and any retries in this handoff.
Do not read the development repository or write outside the isolated project.
