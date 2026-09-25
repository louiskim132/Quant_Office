# Office live acceptance: planning and result analysis — 2026-09-24

Date: 2026-09-24, local (session UTC 04:00–05:31 on 2026-09-25).
Build: the dev build (`electron .`) of branch `fix/pipeline-live-blockers-20260924`, rebuilt after each fix. It was driven through the desktop UI via CDP, with an isolated `QRO_USER_DATA_DIR`. Only the native folder picker was stubbed, to return the dataset folder.
Roster (all local, office-spawned `LOCAL_CLI_EXEC`): Director = Claude Opus 5.5 (low); PM_A / PM_B / PM_C / PM_D = Claude Sonnet 5 (low); Worker = Devin `swe-2-max`.
Dataset: synthetic, seed 20260924. It has 5 tickers × 500 business days of prices (`data/prices.csv`) plus a model-output file (`results/predictions.csv`, 2450 rows, train/validation/test). It contains no real market data.

## Result

| Flow | Outcome |
|---|---|
| Planning pipeline | **PASS** (after fixes). Brief → draft A ∥ draft B → cross-critiques → Director synthesis → Devin implement → Director verify ran end to end. AWAITING_DECISION was reached, and a real user **Approve** bound to the verify receipt `67ac3ae9…`. The verify step independently reproduced the worker's metrics (agreement ≈1e-16). |
| Result-analysis pipeline | **PASS**. Brief → Devin digest → interpret ∥ falsify → responses → Director finalize → Devin report ran end to end. A real user **Request revision** was bound to report receipt `3fd7a88b…`. The report's verdict: the claim is falsified (test MSE/naive-lag5 1.06, 95% CI [0.81, 1.43]; within-ticker IC 0.039, p = 0.29). |
| Memory | 13 receipt findings were ingested and graphed. The plan-synthesis packet carried the memory digest declaration. |

This run is the first live mixed-provider chain (Devin hops inside Claude pipelines), and the first live user decision on a sealed round (roadmap P3). The evidence is local CLI evidence only; it does not establish any hosted, packaged or Colab claim.

## Defects found and fixed on this branch

1. **Contract vs store on outputs.** CONTRACT.md did not say that `outputs/` stays writable under `canWrite=false`, and it allowed an empty `outputs` list. The store, however, refuses COMPLETED without attributable output. The Director carried its plan in `detail` only. The contract now states both rules (38bd4b0).
2. **Lost receipts.** `observe()` binds `lastReceipt` before the job transition, so a refused COMPLETED left the job UNKNOWN forever: every re-observe rejected the same receipt as a replay, and the reason reached only `console.warn`. A refused COMPLETED on a verified receipt now lands as FAILED with the reason (38bd4b0).
3. **Detail length.** The receipt contract allows a 4000-character `detail`, but a job record holds 2000. The transition now keeps a bounded prefix instead of throwing (38bd4b0).
4. **Transport evidence never recorded** for office-spawned sessions. LOCAL_SUBMIT embeds the full launch record, which exceeds the 1000-character detail limit, and TOOL_CONFINEMENT exceeds the 400-character confinement fields. Both are now bounded (38bd4b0, d165f52).
5. **Serena command string.** `"serena start-mcp-server"` was spawned as the executable name, with no shell, by both the probe and `--mcp-config`, so it could never start. The command is now split (c1209ba).
6. **Serena as a hard prerequisite.** Serena is not installed on this machine, and every planner arm refused to launch, so the planning pipeline could not run. When the executable is absent, the arm now launches without code navigation and records why. A serena that is installed but broken still refuses the launch (c1209ba).
7. **Use as new request cloned pipeline state.** The copy took phase LAUNCHED, the source's specHash, and a briefAssignmentId pointing at the cancelled source's brief. The copy now gets a fresh BRIEFING pipeline (9c7c788).
8. **Queue hid live pipelines.** Right after the brief completed, the request moved to Completed and the Active view read "No active requests" while Launch pipeline was waiting. Pipeline requests now settle only once DECIDED (d165f52).
9. **Memory graph clipped at scale.** With 13 findings the layout radius exceeded half the canvas height, and the top and bottom nodes were cut off. The first layout is now an ellipse bounded by the canvas (ee26b50).

Verification: typecheck clean; full suite 825 tests, 824 passed, 1 pre-existing skip; each fix re-exercised in the app.

## Open findings (not fixed here)

- **Blinding.** A planning packet copies the whole project folder, including `results/`, and the brief and drafts computed outcome metrics while planning. The Director's own verify marked "thresholds set before results" as PARTIAL. The per-request file allowlist IPC (`office:choose-input-files`) exists, but no screen uses it.
- **REVISE** records intent only. The card then reads "Completed" with nothing telling the user that no revision round will run.
- **Pipeline cards give no recovery path.** There is no Observe or retry control. A hop that fails at launch, or whose CLI exits with an error (for example the transient Claude OAuth-refresh race seen on the first run), shows as "unknown" with no reason. "Start request" stays enabled and does nothing.
- **Artifacts shows "0 files stored"** despite about 30 verified pipeline outputs. The Reviews page stays "Pending" for the pipelines.
- **Cancel request** acts immediately with no confirmation. A cancelled request's unresolved jobs keep the agent seat in "Unknown · feed disconnected". A pre-fix evidence error was posted into Office chat as raw JSON.
- **Brief content.** The pipeline card shows "Director brief: completed", but not the brief the user is asked to confirm.
