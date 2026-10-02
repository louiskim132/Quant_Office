# Technical publication revision — 2026-10-02

User scope: plan and perform all free technical publication work; legal review is handled separately by the user. All implementation, file review and checks were performed by GPT-6.1 Sol at medium effort. No publication, purchase, account sign-in, real workspace mutation or installed `App` replacement occurred.

## Source and execution plan

The dirty/stale `repo` anchor was preserved. Work began from local `origin/main` `46624c96b3da4b469e8847f2a6ad536bf01e06bd`, in `Worktrees/publication-readiness-20261002` on `codex/publication-readiness-20261002`. Separate isolation and release workers used their own worktrees and scoped commits; integration occurred sequentially.

1. Repair the three independently reproduced publication defects and add behavioral regressions.
2. Review the integrated fixes; repair additional concrete credential/lifecycle faults.
3. Complete free release preparation: clean package staging, unsigned portable bytes and closed inventory, manual update/rollback/uninstall instructions, scratch profile acceptance.
4. Prepare the missing real-provider isolation dispatch operation; preserve `NOT_RUN` for provider/account evidence that cannot be manufactured locally.
5. Validate the combined source, test package and hardened candidate, and reconcile current roadmap status.

## Revisions

- Credential failure preserves encrypted bytes and cannot silently disable configured isolation. A nonsecret `agent-isolation.json` records required intent independently of DPAPI availability; readable legacy credentials migrate, unreadable legacy/quarantined bytes conservatively block. Explicit Settings disable remains a durable user choice. Unreadable saved API keys also refuse execution and subscription observation rather than changing billing modes. Packaged applications ignore the developer `QRO_AGENT_ISOLATION=off` escape hatch.
- Full history and command receipts pass before main-process services, reconciliation or IPC registration. The themed loading page remains responsive during verification. Store mutation admission verifies a pending checkpoint before writes and permanently latches any detected integrity failure. Restored history passes before replacement services are built.
- Independent review found additional execution ownership flaws: ordinary CLI `disposeAll` previously discarded bookkeeping without killing children; terminal receipt settlement could forget a still-running child; asynchronous submits could resume after teardown; errors/pending kills could be mistaken for process exit. Active ownership now survives observation settlement until exit. Restore awaits real owned-child termination, refuses failed stops and closes admission across asynchronous preflight. App/controller shutdown retries owned-child termination. Failed/canceled isolation transitions rebuild adapters from persisted intent after successful teardown.
- Build `dist` and package staging are recreated within checked generated directories. Links/junctions and escaped targets are refused. Actual seeded obsolete-file packaging checks demonstrate stale files are removed while unrelated release files survive.
- Portable ZIP tooling adds exact source commit, SHA-256, a closed inventory and standalone PowerShell verification. Missing, changed and additional files fail verification. Distribution is explicitly unsigned; hashes establish byte identity, not publisher trust. Manual update, rollback, data preservation and uninstall are documented in [PORTABLE-RELEASE.md](../../docs/PORTABLE-RELEASE.md).
- The existing `isolation-signin-ui.ts` harness now accepts an explicit `dispatch` operation. It requires a marked scratch profile, standard already-bound roster, independent isolation checks, durable probe/output hashes, cancellation of synthetic child processes and restart non-duplication. The harness records provider-reported identity/denial separately from office-local observations. No live operation was run here.
- Claude's existing stream normalization is now covered for fragmented tool use/result frames, stderr/prose exclusion and deduplication. ACP client lifecycle remains fixture-tested; provider lifecycle evidence remains separate.

## Verification and evidence

Raw local logs are retained in this candidate's ignored `app` directory. Final results and exact hardened artifact identity are recorded below after acceptance. Earlier integration unit run: **1,096 tests, 1,095 passed, zero failed, one existing skip**. The preceding first run exposed a Windows process-test cleanup race after its kill assertions passed; the test now waits for child handles to close and uses the established Windows-safe cleanup helper. Assertions about real process-tree termination were retained.

Final combined acceptance:

| Check | Result / raw local log |
| --- | --- |
| Unit suite (`tsx --test --test-concurrency=4 tests/*.test.ts`) | **1,104 total; 1,103 passed, zero failed, one existing skip**, 301.8 s; `app/test-publication-final-unit.log` |
| Typecheck / formatting / diff | PASS; `app/typecheck-publication-final.log`, `app/format-publication-final.log`; `git diff --check` clean |
| Coordination tests | 5/5 PASS; `coordination-publication.log` |
| Combined build, test package and hardened package | PASS; `app/build-publication-final.log`, `app/package-publication-test-final.log`, `app/package-publication-release-final.log` |
| Packaged desktop / real native PTY / Settings / 3D / isolation-ACP UI / first-launch theme | PASS; `app/*-publication-final.log`; UI configured-account views are fixtures, not real-account acceptance |
| Exact hardened package audit | PASS, 95 disk files / 308 archive entries; `app/audit-publication-final.log`; RunAsNode, NodeOptions and inspector disabled, cookie encryption enabled |
| Hardened startup and restart, original and fresh extracted ZIP | PASS; `app/smoke-publication-final.log`, `app/portable-smoke-final.log`; empty scratch profiles, heading + first 3D frame, remembered theme on restart |
| Fresh portable extraction / Node and standalone PowerShell closed inventory | PASS; `app/portable-node-verify-final.log`, `app/portable-powershell-verify-final.log` |
| Current-Windows manual update / rollback / uninstall | PASS on scratch data between release-worker and integrated candidate builds (both 0.5.0), same project retained, no jobs/agents, binary-directory uninstall preserves the SQLite hash; `app/portable-lifecycle-final.log`. This is not a schema-upgrade or clean-VM claim. |

Hardened artifact compiled from committed runtime source `1fb488ba2c73a0ee76b0c48dbdf09d8c85181f2d`; later evidence/test documentation does not change packaged runtime bytes. `app.asar` SHA-256: `12cd7c94e0fe1fcfe08eef177ea4588bde23c3259976ae5e03f384cc7b626b44`. Portable archive: `app/release/qro-1fb488ba2c73a0ee76b0c48dbdf09d8c85181f2d-win-x64.zip`, **454,549,333 bytes**, SHA-256 `e87a9d46f748ba323a409c8cae1c80eb04a6bf3cdd6647818368fb1ad0af45e0`. Authenticode reports `NotSigned`. No release channel was created and nothing was uploaded.

Independent read-only reviews identified and drove the execution fixes above. Targeted teardown/admission checks cover failed termination, repeat error, terminal settlement ownership, and a submit paused before spawn. No claim of independent clean OS acceptance is made.

## Remaining publication gates

- **LR-16b real provider acceptance:** QRO-Agent exists locally, but the recorded scratch checks report all three providers disconnected. Official account sign-in requires the user's identity/challenge response. No credentials are copied from the office user's profile, and no provider work that might consume quota or charges was launched. Complete official sign-ins and run the new per-provider scratch dispatch operation before enabling isolation for customers.
- **Clean Windows acceptance:** current-user fresh folder/profile extraction and startup are local acceptance, not a clean operating system. No Windows Sandbox, Hyper-V VM connection tool or VirtualBox executable was found in the current command inventory. A separately provisioned clean Windows environment is still required for install/update/rollback/uninstall and QRO-Agent runtime readability acceptance.
- **Distribution trust:** this is an unsigned portable candidate. No trusted signing identity, SmartScreen reputation, signed installer or automatic update service was acquired. The free manual distribution procedure is prepared; it cannot claim those properties. A ZIP digest must be obtained through a separately trusted release channel.
- **Provider-dependent features:** R5 hosted operation evidence and complete live Devin ACP lifecycle remain unverified and retain their existing limitations. Colab is excluded by the user's earlier instruction. These are scoped capability gaps, not facts local fixtures can prove.

Technical defects found in this revision are repaired locally, but full official-publication readiness cannot be declared while the real-account and clean-OS gates remain unverified. Legal review is excluded from this assessment.
