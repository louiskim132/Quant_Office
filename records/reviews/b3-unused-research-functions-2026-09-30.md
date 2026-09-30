# B3 / U5 — unused research-policy functions: sheet and decisions (2026-09-30)

Decided by Claude on the user's instruction of 2026-09-30 ("go with your recommendation"). Line numbers refer to `origin/main` at `8641720`. Implementation: branch `chore/b3-unused-research-functions` (worktree `Worktrees\b3-cleanup`).

**Rule used:**
- **Delete** when the same rule is already enforced on the path the app actually uses, or when the feature the function served was replaced.
- **Keep for a named backlog item** only when that item is where the function would be wired in.

Git history keeps every deleted function (restore from `8641720`).

## Sheet

| Function | Enforced today in the wired path? | Where it would wire in | Cost | Decision |
|---|---|---|---|---|
| `assertNoLocalExecution` (`core/research-gates.ts`) | Yes, structurally. The office has no local research-compute route: research runs only from the exported C8 run package in Colab (`main/run-package.ts`). The `LOCAL_FALLBACK` route type exists only in this function. Agent execution is guarded separately by `assertHostedExecution` / `assertLocalExecution` (`core/guards.ts`, `main/controller.ts:815`). | Nowhere; there is no fallback to refuse | — | **Delete** |
| `impactClaimBlocker` (`shared/shadow.ts`) | Yes. `core/shadow-ledger.ts:52–57` refuses simulated fills in execution imports and executed fills in observation batches, so simulated fills never count as executions. | — | — | **Delete** |
| `thresholdInvalidation` (`shared/shadow.ts`) | Yes. `core/store.ts:3232–3238` checks the threshold identity, and the G-SHADOW gate refuses a claim whose `thresholdHash` differs from the current frozen policy (`core/store.ts:3410–3442`). | — | — | **Delete** |
| `reEntryBlockers` (`core/monitoring.ts`) | Mostly. The branch panel's "Re-entry ancestry" shows every ancestor's retirement and its reason (`lineageAncestry`, `main/main.ts:997`, `renderer/pipeline.tsx:1113`). Retired branches cannot advance (`shared/research.ts:308`). | `research.amendBranch` as an acknowledgement step | S | **Delete**; the ancestry view already shows the same information |
| `searchLedger` (`core/monitoring.ts`) | Partly. "Search prior results before re-entry" is wired through the indexed `store.researchPage` (`core/store.ts:2271`) and shows each trial's outcome and retirement reason. It does not rank failures first. | Ordering in `researchPage` (it would break its cursor paging) | M | **Delete**; the in-memory version does not scale to the paged store |
| `reviewStatus` (`shared/cooperation.ts`) | Superseded. `recordReviewDecision` is called only by tests, so these request-level decisions are never recorded by the app. Research reviews run through the store's review rounds, which bind to the request revision (`core/store.ts:2359`, `2417`, `3205`, `3304`). | — | — | **Delete** |
| `resolveRoleSlots` (`shared/cooperation.ts`) | No, and nothing sends `request.slots` from the interface either. Team role slots are recorded but never routed. | Dispatch, together with a UI for requesting slots | M–L | **Delete**. The `request.slots` message no longer claims that slots resolve at dispatch |
| `sealReport`, `openSealedRound` (`main/context-policy.ts`) | Yes. The store seals first reports with a content hash (`core/store.ts:1294–1328`) and opens a round only when every expected report is in (`store.openSealedRound`, `core/store.ts:8134`). | — | — | **Delete** (duplicates) |
| `independenceLabel` (`main/context-policy.ts`) | Yes. The store labels each sealed review `VERIFIED_INDEPENDENT`, `VERIFIED_LOCAL` or `SEPARATE_SESSION_UNVERIFIED` from the isolation evidence (`core/store.ts:3576`). | — | — | **Delete** (duplicate) |
| `parseReceipt` (`main/research-templates.ts`) | Superseded. A C8 run return is bound to the package hash (`shared/run-package.ts:77`), and the package ships the authored template bytes, so a return from other template versions cannot match. | — | — | **Delete** |
| `buildResearchPackage`, `inspectResearchPackage` (`main/artifacts.ts`) | Replaced by the C8 run package (`main/run-package.ts`, `createRunPackageCodec`). | — | — | **Delete** |
| `releaseUnusedReservation` (`main/locations.ts`) | No. An unused reservation leaves an empty folder holding one marker file; it is harmless and is reused under the same idempotency key. | The failed-preflight path in the controller | S | **Delete** |
| `listWorktrees`, `removeWorktreeRegistration` (`main/local-worktree-repo.ts`) | Not needed: nothing moves project worktrees, and `git gc` prunes stale registrations on its own. | Worktree-lane cleanup | S | **Delete**. The tests now read `git worktree list --porcelain` directly |
| `judgeDiagnostic`, `judgeStress`, `assertForecastSeparateFromEconomics` (`shared/research-diagnostics.ts`) | No. `diagnostics.v1.py` reports `None` for undefined metrics but uses a fixed minimum of 30 rows. Nothing in the app judges a returned report against the frozen spec's thresholds, requires slices or stress multiples, or keeps forecast and economics apart. | Reading S4/S6 results from a C8 run return | M | **Keep; wire in with B1** (C8-S3 formal run-package pilot) |
| `assertHostedRetrievalHandle` (`shared/evidence.ts`) | Not applicable yet: every evidence route is local. | A cloud evidence route | S | **Keep; wire in with S3** (cloud routes) |

## Consequences recorded for later

- The C3 in-app package evaluator (`evaluatePackage`, `advanceable` and the `gate*` functions in `core/research-gates.ts`, `catBoostPackageSchema`), plus `releaseManifestSchema` and `assertHonestApproval` in `shared/shadow.ts`, were reached only through `inspectResearchPackage` and `buildResearchPackage`. After this change only their tests use them. B1 decides whether the C8 return reading reuses the evaluator; otherwise they are deleted when B1 closes.
- `core/monitoring.ts` keeps `lineageAncestry`, `calibration` and `compareMethods`, which are wired (`main/main.ts:51`).

## Result

- 16 functions deleted: 15 from the B3 list, plus `openSealedRound`, the other half of `sealReport`. Their private helpers and types went with them. 22 tests were removed and 6 adjusted to keep their other assertions. On the branch base the suite goes from 945 to 923 tests (922 pass, 0 fail, 1 skipped); on the full wave tree, 977 becomes about 955.
- 4 functions kept, each tied to a backlog item (B1 or S3).
