# Project audit and cleanup — 2026-09-28

Whole-project audit of `origin/main` at `54aa5f7` (plus the roadmap-only PR #44), followed by a cleanup on branch `chore/project-audit-20260928`. Reviewer: the organizer session (Claude Opus 5.5). Scope: application code and tests, build and CI configuration, the roadmap, agent instructions and prompts, the batch tooling, and the workspace folders around the repository.

## Method and coverage

- **Automated scans:** the TypeScript compiler with unused-code checks; a reachability map from the three shipped bundle entry points; an export-usage scan across `src`, `tests` and `scripts`; an unreferenced-CSS scan; a Markdown link and anchor check; a CPU profile of the slowest test; per-test timings from the full suite.
- **Read in full:** `main/main.ts` (the IPC trust boundary), `main/preload.ts`, `main/secrets.ts`, `main/tool-flags.ts`, the packet contract and prompt text in `main/local-packet.ts`, `core/guards.ts`, `tools/desktop.mjs`, `tools/parallel.mjs`, `AGENTS.md`, `CLAUDE.md`, both READMEs, `docs/DESKTOP-SESSIONS.md`, the PR template and CI workflow.
- **Read by hot path:** `core/store.ts` (projection reads, transactions, integrity verification, migrations), `main/local-cli-exec.ts` (spawn, cancel, timeout), `main/archive.ts` (extraction), `main/evidence-tool.ts`, `main/controller.ts` (dispatch policy), the renderer shell and project panel, and the research launcher template.
- **Not read line by line:** the remaining 6,000 lines of `store.ts` reducers and most of `controller.ts`. They are covered by 945 tests, and nothing in the scans pointed at them. `reference/` holds the user's original CatBoost script and handoff and was not audited as product code.
- **Measured on a scratch copy** of the archived live workspace (`Archive/workspace-live-before-agent-reset-20260927.sqlite`), migrated to the current schema. Only sizes and timings were read, never record contents.

## Findings and what changed

### Performance

| Finding | Change | Measured result |
| --- | --- | --- |
| Every store read re-read the whole projection row, parsed it and re-serialized it canonically to check it. The main process calls this about 140 times, and each command also returns a full snapshot. | The store caches the canonical text it last verified or wrote. Reads parse it; writes refresh it; every ROLLBACK clears it; integrity checks still read the stored row. | Snapshot 35.6 ms → 5.1 ms on the real-size workspace (2.4 MB projection). Office chat page 36.6 ms → 6.2 ms. |
| Unit tests inherited the production 4-second gap between Claude launches. The adapter's comment said tests pass 0, but its 16 positional constructor parameters made that impractical. | `LocalCliExecAdapter` takes a named options object; tests pass `claudeSpawnGapMs: 0`. | Full suite 5 m 43 s → 1 m 43 s locally. The two slowest pipeline files 261 s → 34 s. |
| Two main-process lookups loaded the entire event history to find one agent or connection. | Both read state without history. | — |
| The project settings panel fetched the whole state on every change, in addition to the shell's own fetch. | It derives its planning notices from the state already pushed to it. | One full-state IPC round trip fewer per change while the panel is open. |

### Correctness and reliability

- **Cancel and timeout left tool processes running (fixed).** On Windows, the default local CLI route called `child.kill()`, which ends only the direct child. A native CLI's own tool processes survived, although the job record called it "a real cancellation". The default spawn now ends the whole process tree with `taskkill /T /F`, as the isolated host already did. A Windows regression test uses a `cmd.exe` intermediate; a control run showed the grandchild surviving the old kill and dying with the new one.
- **Silent failures (fixed).** Startup reconciliation, chain reconciliation and provider re-observation swallowed errors with empty `catch` blocks. Automatic observation failures went to `console.warn`, which the packaged app never shows. All now write to the log file.
- **Stale capability text (fixed).** The research-stage status panel said programmatic observation was "not part of this build" and marked agent execution as handoff-only. Research stages dispatch through the same local CLI route as other work.
- **Intermittent CI failure (not reproduced).** On 2026-09-28 one `main` run failed `archive.test.ts` "a large workspace streams past the in-memory format limits" with `unexpected EOF` from the inflate worker. The next runs passed. It has not recurred in local runs during this audit. If it recurs, look at file start ordering in `extractStreamedArchive`.

### Security review

No defect found. The renderer is sandboxed with context isolation and a strict CSP. Every non-file request is blocked, permission requests are denied, navigation and new windows are blocked, and every IPC call checks sender, frame and URL. Archive extraction rejects `..`, absolute paths, backslashes, colons and Windows device names, and caps entries and sizes. The agent evidence drop-box validates every frame strictly and binds the caller from the assignment, not the file. Secrets use DPAPI, are written atomically and never logged. The research launcher resolves every path and confirms it stays inside the package root.

### Dead code and hygiene

- **Removed:** the 0.4-era guard prototypes in `core/guards.ts` (budget reservation, approval bundle, smoke gate, provider disclosure, review round) and their five tests. Nothing in the app called them, so the tests implied enforcement that did not exist. The guards production uses are unchanged.
- **Removed:** 82 unused imports, locals and parameters, and two unused CSS rules. Among them were three values the renderer computed on every render and two full snapshots computed and discarded during backup. `tsconfig.json` now rejects unused locals and parameters and type-checks `scripts/`.
- **Simplified:** four copies of the "launch failed" event block and three copies of the local-session path resolver in `main.ts`; an always-true state comparison after each research-stage action.
- **Dependencies:** removed the unused `@electron/windows-sign` and `@types/pngjs`; pinned `@types/node` exactly, per the repository's exact-version policy.

### Instructions, prompts and roadmap

- **Roadmap:** 627 KB (6,221 lines) → 196 KB (1,248 lines). Superseded opening paragraphs, completed packet texts (R0–R7, C1–C8, LR-0…LR-14), 2026-09-12 evidence, the 0.4 audit and log entries before 2026-09-27 moved verbatim to `docs/history/roadmap-archive-2026-09.md`. Section numbers are unchanged. A line-by-line check confirmed only five intended rewrites differ.
- **Roadmap corrections:** section 1.1 still banned any paid API, contradicting the merged LR-15 API-key mode. Section 1.2 and AGENTS.md disagreed on where results are recorded. The section 1.3 code map was all pre-Git hash prefixes; it is now a current module table. Section 1.5 had no path for one-PR-per-packet waves and carried stale specifics. Section 14 pointed at an old `Codex/quant-team/app` path.
- **AGENTS.md, CLAUDE.md:** AGENTS.md said every worker PR targets a batch organizer branch, which contradicted the C11 packet flow; it now describes both workflows and one merge gate. CLAUDE.md duplicated half of AGENTS.md and now holds only Claude-specific notes. The standing roster instruction is kept.
- **READMEs:** both described 0.4/0.5-era behavior ("no local research execution", "Start request submits no provider work", a backup size limit the streamed format removed). Both are rewritten from the current code.
- **Docs folder:** eleven historical design documents moved to `docs/history/`; three redirect stubs removed; `docs/workflow.md`, which is maintained, lost its incorrect "historical" header. The `reopen` command, implemented and tested in `tools/desktop.mjs`, is now in the session manual.
- **Agent prompts:** the packet contract, the prompt block and the generated `finish.py` are consistent with the receipt schema and state that inputs are data, not instructions. No change needed.

### Build and CI

- Actions moved from `@v4` (deprecated Node 20 runtime) to `actions/checkout@v7`, `actions/setup-node@v7` and `pnpm/action-setup@v6`. CI's pnpm moved from 11.19.0 to 12.3.4, matching local development.
- `.gitattributes` now keeps every tracked text file LF, ending the CRLF warnings on docs and manifests. The index was already all LF, so no file content changed.

## Verification

| Check | Result |
| --- | --- |
| `pnpm format:check` | All matched files use Prettier code style |
| `pnpm typecheck` (now with unused checks and `scripts/`) | 0 errors |
| Unit suite | 945 tests: 944 pass, 0 fail, 1 skipped |
| Build and package | Built Quant Research Office 0.5.0 |
| Packaged desktop e2e | Desktop end-to-end checks passed |
| Packaged UI check, scratch data folder | Location & inputs panel renders, withheld editor works, draft survives a state push, no page errors |
| Markdown links | No broken links except 48 archived references to local test logs that were never committed |

## Open items and decisions for the user

- **Unwired policy helpers.** About 20 documented research-policy functions are called only by tests. Examples: `thresholdInvalidation`, `reEntryBlockers`, `impactClaimBlocker`, `reviewStatus`, `sealReport`, `independenceLabel`, `assertNoLocalExecution`, `parseReceipt`, and all of `shared/research-diagnostics.ts`. They encode S0–S10 design decisions, so deleting them is a product choice. Either wire them into the stages they describe, or delete them with their tests.
- **Capabilities in every state push.** Each change sends the renderer about 1.8 MB of capability history it barely uses. Trimming it safely needs readiness code changed to fetch older snapshots on demand. That is a worthwhile next packet but not a cleanup.
- **Job events past the first 50** are unreachable in the agent profile. The unused pager state was removed; a "load more" control would be a small feature.
- **Worktrees folder is 14 GB.** About 35 worktrees exist, most for merged branches, each with its own dependencies and builds. The workspace README lists the safe candidates. Removing worktrees is left to the user, because other sessions may still be using some of them.
- **Launch gates** are unchanged: LR-16 real acceptance needs the user's UAC consent, and the legal review is external.
