# Office live acceptance round 3: packaged rev-2 re-run — 2026-09-25

Date: 2026-09-25, local.
Build: the **packaged** taskbar install `Quant Office\App\` at `findings-rev-2` head `cce6aee` (merged as `4533d57`; `app.asar` SHA-256 `6D98FC8E99A88A44B689DD9EE8AD3771B64F59D5957B921DC330460BB94C71B3`, byte-identical in `release\` and `App\`). Driven through the desktop UI via Playwright `_electron.launch` on the packaged exe against the **real** userData (`%APPDATA%\Quant Research Office`) — the first live run on the installed build.
Roster (all `LOCAL_CLI_EXEC`, office-spawned): Director = Claude Opus 5.5 (low); PM_A…PM_D = Claude Sonnet 5 (low); Worker ×2 = Devin `swe-2-max`.
Dataset: the user's real `XRPUSDT_Asia_Last_Day_Sample.csv` (98 rows) staged under the project folder `C:\Users\louis\Downloads\Test 1`.

## Result

| Flow | Outcome |
|---|---|
| Planning round "Write 200ema code" | **PASS with recovery evidence**. Brief attempt 1 was orphaned when the driving office process exited (spawned child killed with parent); the pid-liveness observation correctly reported `the recorded pid 10624 is not running`, and `office:pipeline-retry-hop` minted + launched attempt 2, which COMPLETED. All 9 hops COMPLETED; real user **Approve** bound to report receipt `e9469207…`. |
| Planning round "Write ema3 code" (revised scope: period 3 fits 98 rows) | **PASS with recovery evidence**. Brief attempt 1 FAILED on the transient Claude OAuth-refresh race — W2's single documented transient signature flagged `transientProviderError` and the office's one-shot auto-retry minted attempt 2 after ~60 s with no user action. A driver crash orphaned implement-1/2 attempt 1; pid-liveness reported them dead, bridge retry completed both on attempt 2. `plan-synthesis`'s receipt survived the office restart and was picked up by `reconcile()` (stranded-receipt repair). All 9 hops COMPLETED; **Approve** bound to `6ee27338…`. |
| User-run computation | The user ran the office-verified `ema3.py` in Colab on the sample and uploaded `ema3_result.csv`. Byte-identical to a local `--seed first` run (pandas `ewm(span=3, adjust=False)` parity). |
| Result-analysis round "Analyze ema3 results" | **PASS**. Brief → digest → interpret ∥ falsify → responses → finalize → report: all 8 hops COMPLETED, every stage independently returned **CORRECT** (98/98 rows, time order identical, alpha=0.5 seed-first). **Approve** bound to `31c2b22c…`; `report.md` previewed through the hash-checked `jobOutputPreview` bridge. |

This run is the first live exercise of the rev-2 feature set on the packaged install: dead-spawn observation, hop retry, transient auto-retry, stranded-receipt reconcile, verified output preview, and the sealed AWAITING_DECISION → hash-bound decision chain. It replicates the C8 *pattern* (office produces code → user runs it externally → office verifies the returned artifact) but is **not** the formal S3 run-package/run-return pilot — the stage machine's S0→S10 journey remains open.

## Open findings (fed to the next round)

1. **`jobOutputPreview` response carries no `verified` field.** The handler hash-checks stored bytes and throws on integrity failure, so the preview is verified-by-construction — but the response shape cannot positively state that a check ran; the card labels "office-verified bytes" statically. Return an explicit flag.
2. **Retry is unreachable in BRIEFING.** `PipelineCard.retryable` gates on `pipeline.phase === 'LAUNCHED'`, while the store `request.pipeline.retryHop` refuses only DECIDED/AWAITING_DECISION. A failed/orphaned brief (attempt 1 above) has no UI retry path — today's retries used the bridge directly.
3. **Chain-launched dependents mint jobs with no local-session binding.** Observing one logs `[legacy binding: no local-session record — resolved as flat packet by rule, reconcile to bind]`; the fallback works and reconcile binds later, but the binding should be written at launch.
4. **Observing an INTENT job throws** `A job cannot move from INTENT to UNKNOWN` — correct store behaviour surfaced as a raw IPC error; the card disables Observe for INTENT, but the handler could reject more readably.

## Not exercised in this run

REVISE decision → linked revision request → cross-request inherited inputs (unit-tested only); cancel-request dialog and cascade; withheld-paths editor → BLIND packet blinding; Codex local route; hosted-provider execution (R5 remains BLOCKED_EXTERNAL); provider token/model counters; C10 plugin trials; OmniRoute.
