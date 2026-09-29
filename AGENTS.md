# Repository agent instructions

Rules for every coding agent (Claude Code, Codex, Devin) working in this repository. `docs/ROADMAP.md` is the single source of truth for plans and status; do not create a competing plan or continuation file.

## Before you edit

- Read the task packet, then this bounded roadmap path: section 1.1 (boundaries), 1.5 (workflows and merge gate), the section 11 status tables and the newest three entries at the end of section 17. Open other sections only when the packet cites them.
- Current code is `origin/main`. `Quant Office\repo` is only the Git anchor that owns the worktrees: never implement or review there, and never move or rename it.
- Work in the checkout your workflow gives you (roadmap section 1.5): a batch session's folder under `repo-sessions\<batch>\` with its ignored `SESSION.md`, or otherwise a new worktree and branch under `Quant Office\Worktrees\` created from `origin/main`. A hosted agent works in a fresh clone at the packet's base commit.
- Record `git status --short --branch`, the commit, branch and worktree before editing. Treat old hashes in documents as navigation hints, not proof.

## While you work

- One writer per checkout. Keep the branch scoped to one packet and to the files it names. Shared types, IPC bridges, store schemas, dependencies, CI, agent rules and the roadmap are organizer-owned: report a needed cross-scope change instead of making it.
- Preserve roadmap section 1.1. Local tests do not establish hosted-provider, scientific, brokerage or live-research capability.
- Never force-push, rewrite shared history, push to `main`, or delete another session's branch or worktree. In another session's checkout do not run `git clean`, `git worktree remove/prune` or `git stash`: the stash stack is shared by every worktree, and untracked files there may be safety copies.
- Run application commands from `app` (roadmap section 14). If `node` is not on `PATH`, use `C:\Program Files\nodejs\node.exe`. Do not run live-provider fixtures unless the task explicitly authorizes them.

## Finishing and merging

- A worker's PR lists the changed files, the commands run with their actual results, blockers and a proposed roadmap entry. Never claim a test or provider operation that did not run. Workers never merge.
- In a desktop batch, worker PRs target the batch organizer branch and the organizer ships one integration PR after the round closes. In a packet wave, each packet's PR targets `main` directly.
- The organizer merges only through the GitHub PR, and only when `origin/main` is an ancestor of the exact PR head, the required `verify` check passed on that same head, and required conversations are resolved. Without authenticated PR access, report the PR URL and the blocker; never request or expose a raw token and never push directly.
- On integration the organizer appends a dated entry at the end of roadmap section 17 and updates the matching section 11 row. Date entries with the local date of the recorded commit (`git log -1 --date=short-local`), not UTC.
- After an integrated change touching `app/`, the organizer rebuilds and repackages (`node scripts/build.mjs && node scripts/package.mjs` from `app`), confirms the installed app is closed, mirrors the release into `Quant Office\App\` (the taskbar pin's target), and records the SHA-256 of `App\resources\app.asar` in the entry.

## Desktop batch

- In a configured batch, do not infer work from chat or the roadmap. Session 8 publishes with `node tools/desktop.mjs publish`; Sessions 1–7 act only on the packet `node tools/desktop.mjs start` returns and submit with `finish` or `block`. Only Session 8 accepts, rejects, reopens, updates the roadmap and closes the round. The operating manual is `docs/DESKTOP-SESSIONS.md`.
- Session 9 (`repo-sessions\<batch>\reviewer`) is read-only. Before each review it runs `git fetch`, checks out `origin/main` or the PR head under review (detached), and states the reviewed SHA. It never edits files or takes part in the Session 1–8 orchestration; only the user or Session 8 refreshes that checkout.

## User data and acceptance testing

- The user's live office data is `%APPDATA%\Quant Research Office`. Never modify, reset or migrate it without an explicit request from the user in chat. Every backup goes to an absolute, dated path outside any Git checkout (for example `Quant Office\Archive\`), and the reply reports that path.
- Tests, demos and acceptance runs use `QRO_USER_DATA_DIR` pointing at a scratch folder, never the live workspace.
- A change to `app/src/renderer` needs a user-level check before it closes: open the packaged app with an isolated `QRO_USER_DATA_DIR` and use the changed UI as a user would. Unit tests and CI do not replace this.
- The standard test roster is identified by agent name, not model: `Test dir 1` (DIRECTOR), `Test PM A` to `Test PM D` (PM_A–PM_D) and `Test worker 1` (plus `Test worker 2` when a round needs two workers), all local on the office-spawned CLI transport. Every test report names the agent and the model and effort it ran with. User instruction of 2026-09-27: every seat runs Devin SWE-2 Max until the user says otherwise.
- When a provider releases or retires a model, the organizer updates `PROVIDER_MODEL_SUGGESTIONS` in `app/src/shared/effort.ts` and its review date in the same change.
