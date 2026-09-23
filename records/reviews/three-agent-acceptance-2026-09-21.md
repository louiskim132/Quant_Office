# Three-agent local CLI chain — acceptance record

Date: 2026-09-21 (run timestamps UTC 2026-09-22T00:03–00:07)
Checkout: `C:/Users/louis/Desktop/AI/Quant Office/repo-sessions/next-batch-001/organizer`
Harness: `app/tests/three-agent.live.ts` (opt-in; requires `QRO_LIVE_THREE_AGENT=1`)
Artifact root: `app/test-output/three-agent-live-2026-09-22T00-03-19-074Z/` (`acceptance.json`, per-session packet/result/outputs, final `state.json`, `workspace.sqlite`)

## Scope

Bounded live acceptance of the C9 `LOCAL_CLI_EXEC` route: a Director → PM → Worker dependency chain running three real Claude Code CLI processes under office control, with automatic dependent launch after verified durable predecessor output. Synthetic office work only — no research execution, no hosted dispatch, no provider cloud claims.

## Result: PASS

`acceptance.json` records `status: PASS`, `manualStarts: 1`, `automaticDependents: 2`, `errors: []`.

- Three real `claude.exe` processes (pids 18272, 25612, 24000), each in its own `sessions/session-*` packet directory.
- One manual handoff (Director); the PM and Worker launches were event-driven from `advanceLocalChain`/`reconcileLocalChain` triggers — a trigger, never an outcome.
- Each hop produced exactly `outputs/report.json` (UTF-8, no BOM) plus a schema-valid `office-local-result@2` `result.json` receipt carrying the `packet.sha256` sidecar identity, `sequence: 1`, state `COMPLETED`.
- Durable verified outputs: stored under `results/…/attempt-001/files/<sha256>/outputs/report.json` with byte length and SHA-256 matching the receipt.
- Chain integrity: nonce `5f4c0ec4-…` carried unchanged through all three reports; trail closed as `[DIRECTOR, PM_A, WORKER]`; each `predecessorSha256` is the measured hash of the inherited report bytes and matches the packet's inherited-manifest entry (`roleVerified`, `nonceMatchesBrief` true at each hop).
- Replay non-duplication: dependent jobs launched exactly once each; no duplicate `chain-launch:` events.
- Bindings honestly labeled: `confinementStatus: UNVERIFIED`, `bindingEvidence: UNBOUND`, `requirement: SCOPED_DELIVERY`, `providerSessionId: null`. Local CLI evidence only — no hosted-session claim.

## Defects found and repaired during acceptance

1. **Generated packet-hash instructions** — `CONTRACT.md` told the agent to copy `packetHash` from `packet.json`, where the field does not exist. The first live run (artifact root `three-agent-live-2026-09-21T23-57-46-002Z`, `failure.json`) ended with a receipt whose `packetHash` was the `snapshotManifestHash`; `readLocalResult` correctly refused binding — the verification held, the instructions were wrong. The contract now names `packet.sha256` as the copy source and warns against `snapshotManifestHash` and re-hashing formatted `packet.json`. Commit `5febc7f`.
2. **Concurrent-trigger false-blocker race** — multiple completion signals could queue behind `chainTail`; a callback admitted on a stale snapshot recorded a false `chain-blocked:` event after a sibling had already launched the job. The serialized section now re-reads durable state and re-verifies INTENT + local route + dependency readiness before any account check or handoff. Commit `5febc7f`.

## Regression evidence at acceptance

Recorded with the roadmap entry: `tsx --test` suite — 690 tests, 689 passed, 1 pre-existing privileged-symlink skip; `tsc --noEmit` clean; `node scripts/build.mjs` clean; three development desktop suites (`desktop.e2e`, `pipeline.desktop`, `revision.desktop`) pass — the latter two after correcting stale selector assumptions for the current Projects/Office flow.

## Not established by this acceptance

- Mixed-provider chains (a Devin CLI worker hop is separately scheduled and unproven here).
- Packaged/native acceptance of this revision; the packaged build predates these repairs.
- Hosted/provider dispatch, R5 transport, custody, and the C8 user-run Colab pilot.
- Provider-verified model/effort application — local result.json self-reports remain self-reports.
- Output-storage failure recovery and retention of process/watch bookkeeping until durable terminal admission — the recorded next item.
