# B3 user request: dispatch and side-effect safety

In the isolated project, use the installed Harness and the requested Codex →
Claude route to create one small, specified result file. Exercise a request,
acknowledgement/result correlation, cancellation, an explicit failed attempt,
and a retry. Repeating the same dispatch must not create a second side effect.

Choose the installed runtime/dispatch tools yourself. Record the raw event and
side-effect logs, runtime/model/effort selections, cancellation and retry
outcomes, and the hash of the one result file. Do not read the development
repository, scorer, prefilled result, or sealed holdout. If a runtime is
unsupported, record that failure rather than silently substituting another one.
