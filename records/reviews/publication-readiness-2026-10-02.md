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

## Bounded residual acceptance follow-up

The declared local-agent scope supports Claude Code, Codex/OpenAI and Devin; all three need isolated acceptance unless the user explicitly narrows release claims. Existing office-user sign-ins do not establish QRO-Agent authentication. All three CLI executables are installed. The prior isolated profile contains historical signed-in observations, but fresh testing on 2026-10-02 could not start its host: **the saved Windows account password no longer matches QRO-Agent**. An actual hardened scratch run recorded boundary FAIL (0/5), provider status errors, and no agents/jobs. No password was reset or provider prompt submitted. A separate read-only DPAPI check of the current office profile found no readable agent credential; it was not copied or changed. Evidence: `app/test-output/residual-isolation-status.json`, `app/test-output/residual-current-agent-status.json`. Historical sign-ins may still exist in QRO-Agent's provider profile; after credential synchronization, check first and sign in only where needed.

The host is **Windows 11 Home, build 26300**. Read-only `Win32_OptionalFeature` inventory exposes enabled `VirtualMachinePlatform`, but no Sandbox/Hyper-V feature; Sandbox/vmconnect executables, Hyper-V/VirtualBox/VMware services and installed VM tools were not found. DISM-backed `Get-WindowsOptionalFeature` queries require elevation and could not run in this session. VirtualMachinePlatform alone is not a clean Windows guest. No usable existing clean Windows environment was found, and no OS feature installation, upgrade or reboot was performed.

A prepared instrumented scratch harness is retained at `app/test-output/isolation-publication-harness`. Only its inspector fuse is enabled for Playwright; it is explicitly **not a publication artifact**. Its app runtime matches the hardened candidate source; the release ZIP remains untouched. Fresh-harness startup/close was exercised without setup/sign-in/dispatch. This exposed and repaired a stale initial navigation: the harness now opens Settings → Agent isolation before finding setup controls. Targeted helper tests 3/3 and typecheck pass. The final independent medium-effort reviewer found no remaining concrete runtime teardown/transition defect.

Minimal account acceptance steps, from the candidate `app` directory:

```powershell
$acceptanceRoot = (Resolve-Path 'test-output/isolation-publication-harness').Path
node node_modules/tsx/dist/cli.mjs scripts/isolation-signin-ui.ts $acceptanceRoot
```

In its visible scratch window, confirm **Set up** and the Windows administrator prompt. This synchronizes the scratch credential with the existing global QRO-Agent account; it does not import office-user OAuth tokens. Check each provider first, then use its official QRO-Agent sign-in only if missing. Create/bind one standard local CLI test profile per provider through the UI (for example Test worker 1 for Claude, Test worker 2 for Codex, Test dir 1 for Devin), choosing models actually available to that account. No API key or hosted route is needed. Check that the provider's included subscription allowance permits these synthetic tests without additional charges.

From a second PowerShell in the same `app` directory:

```powershell
$acceptanceRoot = (Resolve-Path 'test-output/isolation-publication-harness').Path
'{"op":"check"}' | Set-Content -LiteralPath (Join-Path $acceptanceRoot 'action.json')
Get-Content -LiteralPath (Join-Path $acceptanceRoot 'checks.json')
# One operation at a time; wait for its report before sending the next.
'{"op":"dispatch","provider":"claude"}' | Set-Content -LiteralPath (Join-Path $acceptanceRoot 'action.json')
Get-Content -LiteralPath (Join-Path $acceptanceRoot 'dispatch-claude.json')
# Repeat dispatch/check of report for provider "openai", then "devin".
'{"op":"close"}' | Set-Content -LiteralPath (Join-Path $acceptanceRoot 'action.json')
```

Each dispatch report must have `accepted: true`; failure/NOT_RUN is not acceptance. Provider operations require a working account and nonpaid allowance, and cannot be completed by manufacturing receipts.

For clean Windows acceptance, use an independently provisioned clean Windows machine/VM and the exact hardened ZIP plus trusted verifier. Compare the ZIP digest, extract to a new folder, run `verify-portable.ps1`, launch/restart, create a synthetic project, perform manual version-folder update/rollback, and delete only the binary folder while preserving the data. Record OS/build, standard-user behavior, exact artifact hashes and results; test readable per-machine runtime and QRO-Agent setup separately if that mode is claimed. [PORTABLE-RELEASE.md](../../docs/PORTABLE-RELEASE.md) provides commands and the required observations.

**Policy distinction:** the existing C11 exit criterion calls for a **signed installer on a clean Windows machine**. The user's free-work authorization reopens technical preparation; it does not explicitly waive that criterion. This unsigned portable candidate is a prepared alternative, not completion of the signed-installer gate. Either satisfy that gate with a trusted identity/installer supplied through an eligible free resource, or obtain an explicit user decision changing the declared distribution scope. Never label the unsigned ZIP a signed release.

## Clean Windows VM acceptance (2026-10-02, evening)

Environment: VirtualBox 7.2.20 on the Windows 11 Home host (Windows hypervisor turned off so AMD-V runs natively). Guest: fresh Windows 11 Home build 26300 from the Microsoft ISO (SHA-256 matched Microsoft's published English x64 hash), Guest Additions only, local **standard (non-admin)** account `tester`, no Node, Git, Claude, Codex or Devin CLI. Snapshot `clean-baseline` holds that state. Script and raw log: [clean-vm-2026-10-02/](clean-vm-2026-10-02/).

| Check | Result |
|---|---|
| ZIP SHA-256, old `1fb488b` and new `80df107` | PASS, both match build-machine digests |
| `verify-portable.ps1` full inventory, both versions | PASS |
| New `app.asar` SHA-256 | `183F29C7…8007C`, identical to the build |
| Authenticode | NotSigned (expected) |
| First launch on clean profile, standard user | PASS, workspace created |
| Restart persistence (project survives close/reopen) | PASS |
| Manual update old → new, project preserved | PASS |
| Rollback to retained old folder, project preserved | PASS |
| Uninstall (delete version folders) | PASS: 0 folders, 0 services, 0 scheduled tasks; workspace under `%APPDATA%\Quant Research Office` preserved |
| Missing-CLI behavior | Connections cards show "Not checked"; clicking Sign in gives "Claude Code is not installed or could not be found. Install the official tool, then use Locate sign-in tool…". Clear, but only after a click (polish item). |

Limitations: files arrived through a VirtualBox shared folder, so no Mark-of-the-Web — **SmartScreen/unsigned-download warning not exercised**. Chromium logs `GetGpuDriverOverlayInfo: Failed to retrieve video device` in the VM (virtual GPU, harmless). QRO-Agent per-machine isolation not exercised in the VM. A user-created shortcut is left dangling after uninstall (expected for portable; doc says remove shortcuts).

Gate 2 (clean Windows) is **met for the unsigned portable ZIP**, except the SmartScreen download path. The signed-installer gate (C11) is unchanged.

## Unsigned installer acceptance in the clean VM (2026-10-03)

Decision: the user chose an **unsigned Inno Setup installer** over the portable ZIP; signing is deferred (see ROADMAP C11 decision). Script and log: [clean-vm-2026-10-02/installer-test.ps1](clean-vm-2026-10-02/installer-test.ps1).

| Check | Result |
|---|---|
| Downloaded-file path (Zone 3 mark) | SmartScreen "Windows protected your PC" → More info → Run anyway; UAC shows **Unknown publisher** (expected, unsigned) |
| Install `1fb488b`, upgrade to `2069c3b`, roll back to `1fb488b` | PASS: byte inventory, source commit, install folder not user-writable, Installed apps entry, Start menu shortcut; project preserved across all three |
| Install of `43b2f06` (Version tab, folder check, uninstall fix) | PASS, same checks |
| Uninstall | PASS: folder, Installed apps entry and shortcut removed; 0 services, 0 tasks; workspace preserved. First run left an empty install folder; fixed with `[UninstallDelete]` and re-verified |
| First launch after install/upgrade | 10 s+, later launches fast; attributed to Defender's first scan of new unsigned files plus first-run caches (to be measured on hardware) |

Found and fixed during the run: the verifier now accepts exactly Inno's `unins000.exe/.dat` in an installed copy; Create project requires a folder (red-outlined field). Follow-up: the installer gained a menu (Update/Reinstall, Roll back to kept versions, Uninstall) so no step needs a command line; its own VM pass is recorded below when done.

**Installer menu, clean VM (2026-10-03):** user-run with A = `0e37b3e`, B = `32d2735`, by double-click only. Fresh install of A without a menu; B offered Update and listed A for rollback; update A to B, roll back B to A via the menu (kept installer, digest-checked); Settings > Version showed the expected build after each change. PASS as reported by the user.

**Close-before-uninstall, clean VM (2026-10-03):** with the office open, Uninstall (menu and Settings > Apps) now asks to close it and retries until closed or cancelled; after closing, the uninstall removed the install folder, kept versions, Installed apps entry and shortcut and kept the workspace. PASS as reported by the user (build `7c52025`).
