# Ordinary handoff for the comparison run

Use the same runtime, model, effort, permissions, fixture, and user request as
the Harness run. Work only in the isolated project and preserve the
user-created sentinel and `data.json`.

Implement a billing CLI that reads the first JSON path argument and prints
exactly one JSON object with exactly the fields `currency` and `totalMinor`.
Without flags, sum all `records[].amountMinor`. Add `--exclude-refunds` so
negative amounts are excluded only when that flag is present; verify that the
no-flag behavior remains unchanged. Record commands, outputs, failed
assumptions, evidence status, and any retries. Do not read the development
repository or write outside the isolated project.
