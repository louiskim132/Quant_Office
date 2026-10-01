# B5 — local subscription acceptance

Real office services, synthetic scratch inputs, LOCAL_CLI_EXEC, subscription authentication only. No Colab or provider cloud session was used. Evidence outside Git: `Docs/Reviews/revision-2026-10-01/b5-live-2/` (acceptance.json, quick-planning.json, packet/receipt directories and SQLite ledger). Personal account identifiers remain outside Git.

| Appointed seat | Model | Effort | QUICK hop |
| --- | --- | --- | --- |
| Test dir 1 | Devin SWE-2 Max (`swe-2-max`) | default (variant encodes Max) | plan-brief, verify |
| Test PM A | Devin SWE-2 Max | default | plan-draft-a |
| Test worker 2 | Codex GPT-6.1 Sol (`gpt-6.1-sol`) | low | implement-1 |

Test PM B–D and Test worker 1 were recorded with Devin SWE-2 Max/default and were not appointed by QUICK. The four real hops completed with verified stored outputs and inherited dependencies. The office opened AWAITING_DECISION automatically. No approval of real research or trading was recorded. CLI versions from the actual tool path: Devin 3000.10.21; Codex 0.159.2. The PATH shim separately reported 0.154.0; it was not the dispatched executable.

The invalid-model task became FAILED with the provider's message that `qro-intentionally-invalid-model` is unsupported for ChatGPT authentication. This exposed a product gap: the office launched plain Codex output, so no structured terminal record was available. `--json` is now part of the launch, and `turn.failed` becomes a provider-reported failure after exit. Arbitrary stderr, a lone error frame or an exit code still cannot manufacture FAILED. Structured command/MCP/web-search items stream as TOOL events.

Cancellation was exercised while a real Codex process and seven descendant tool processes existed. The office wrote its cooperative sentinel and killed the owned tree; all eight PIDs stopped. The job settled FAILED with the office-termination reason, retaining OFFICE_LOCAL provenance. This is not a provider cancellation acknowledgement. Closing/reopening the scratch store and reconciling the chain spawned nothing again. Final follow-up invocation launched exactly two processes (bad model and cancellation); the earlier QUICK invocation launched four.

Output-storage regression: a completed verified receipt whose destination store throws is not consumed, does not settle COMPLETED and retains process/watch bookkeeping. A later observe or a restarted controller stores the output and settles with the same receipt, without a second dispatch. Both baseline regressions failed before the fix. The settlement hook now disposes watchers/timers after durable terminal admission.

Acceptance-script corrections are preserved in the logs: the first draft raced automatic dependent launch; the second draft redundantly asserted that a round already at AWAITING_DECISION was still LAUNCHED; an initial bad-model run lacked --json; a later follow-up reused a superseded account observation. Corrected script uses automatic chaining, fresh account observations and owned-tree checks. These failures are not counted as passing acceptance. Final acceptance.json reports PASS and no callback errors. Reproduce only with explicit live authorization: `QRO_LIVE_B5=1 pnpm exec tsx scripts/b5-codex-live.ts <scratch-folder>`.
