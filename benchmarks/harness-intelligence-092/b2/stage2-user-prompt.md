# Stage 2 user request after interruption

Continue this billing task in the isolated project using only the supplied
task context and current code; do not rely on the previous chat. Add the
`--exclude-refunds` flag: records with a negative `amountMinor` are refunds
and must be excluded when the flag is present. Preserve the original no-flag
sum and the exact stdout JSON contract. Run both forms against the unchanged
fixture and record the outputs and any failed assumption/evidence status.

The task context must retain why this requirement changed, unresolved items,
and whether any prior assumption was verified or failed. Do not read the
development repository or modify files outside this isolated project.
