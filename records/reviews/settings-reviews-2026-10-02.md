# Settings, reviews and startup revision - 2026-10-02

Two user requests from the Codex session "Fix agent activity and building view", after its office behavior round (`c117b5a`, [office-behavior-2026-10-02.md](office-behavior-2026-10-02.md)):

- **A.** Six settings and reviews changes, with a revision log.
- **B.** "See if you can revise them", about the caveats in the 2026-10-02 office round's report: the first launch after an update could open light for a moment over a dark workspace, the first launch is slower because nothing is cached, there is a `startup …` timing line in `main.log`, and a backup race was fixed.

Codex (GPT-6) implemented A, tested it, and started B. It then hit its usage limit before committing, rebuilding the App or writing this log. Claude (Opus 5.5) reviewed the uncommitted work, fixed what is listed under "Review fixes", finished B, verified both and committed them. Both rounds were then pushed to `main` and the release installed by Claude (Sonnet 5.5).

## A. Requested changes

| # | Request | Delivered |
|---|---|---|
| 1 | Custom commands in Settings: the user chooses the keys for moving and rotating the view | New **Settings → Controls** pane: an action (Move, Rotate, Zoom) for each mouse drag (left, middle, right), and a key for each of Move left/right/up/down, Rotate left/right, Zoom in/out and Reset view. Press a key in a field to bind it. A key that is already bound swaps with the old one, and so does a drag action, so no two actions share an input. **Reset controls** restores the defaults: left drag moves, middle zooms, right rotates; W A S D move, the arrow keys rotate, `=` and `-` zoom, Home resets (`0`, `+` and `_` still work as aliases). The bindings are a window preference (`office-controls` in local storage), not a workspace record, so no store schema changed. A malformed preference falls back to the defaults. The 3D view reads the bindings live, and its accessibility label no longer lists fixed keys. |
| 2 | Settings → Connections: one **Check account** right below "Sign in to each…", instead of one per provider | One **Check account** button under the pane's lead checks all three providers at once (each through its own official CLI, as before). The per-provider buttons are gone. While a check runs the button reads "Checking…". A provider that fails reports its own error and does not stop the others. |
| 3 | Settings → Agent isolation: Check isolation above the sign-in buttons, then a table (Provider, Status), with the status line to the right of Check isolation | Once isolation is set up the pane reads, top to bottom: **Check isolation** with the status line beside it ("Agent isolation is set up. New agent launches now run as the QRO-Agent account.", or the last check's result); the three **Sign in** buttons; a table with the columns **Provider** and **Status**, one row per provider (signed-in account or "Not signed in"/"Not checked", with the check time and a **Check** link); the last isolation check's summary; and Remove isolation. The set-up steps list shows only while isolation is not set up. |
| 4 | Reviews page organised like the Agents tab: one row per task that expands in place to its reviews, numbered in order, each expanding to its content with "Recorded details" at the bottom | **Pipeline reviews** is a list of tasks (pipeline requests). Each row expands in place to its steps, numbered in dependency order and including the worker's production step and the director's decision, so worker → PM A → PM B → PM A → director reads 1–5. A reviewer who appears twice is listed twice. Each step expands in place. It loads the step's report (the stored `report.md`, or the first stored text file), with buttons for its other stored files and **Recorded details** (the recorded text, attempt, job and the "completion is not a verdict" note) at the bottom. **Request positions** and **Research-stage reviews** became collapsible sections below. |
| 5 | Usage → session history showed only Claude sessions though all providers were used | Cause: the store returned the session history page by page in insertion order, and the page sorted only within a page. The first 25 rows were the 25 oldest sessions, all Claude. `localSessionFeed` now sorts all sessions newest first before it takes a page; the stored order is unchanged. The table has a **Refresh** button. "Load more" drops duplicates, and a stale response can no longer overwrite a newer one. |
| 6 | Models showed "swe-2-max · default effort" when the effort is max | Devin's model ids carry the effort as a suffix (`swe-2-max`). A shared label shows them as **devin · swe-2 · max effort** in the agent roster, the agent drawer, the office name tags and the connection confirmation. Only the display changed. The stored model id and the id sent to the provider are still `swe-2-max`. Other providers' labels are unchanged. |

## B. Startup follow-up

- **First launch over a dark workspace.** With no remembered theme (the first launch of a build that has the `window-theme` file), the window stays hidden until the workspace has been read. It then appears at the loading page in the workspace's colours, about 0.14 s after start on a scratch workspace. Every later launch shows the window at once in the remembered theme, as before. The page itself is now built in two variants, `index.html` (light) and `index-dark.html`. The main process loads the one that matches the workspace, so the page's first paint is right even before the page has stored a theme of its own. If the remembered theme is ever wrong (a restored backup in the other theme), the loading page and window colour switch as soon as the workspace is read. The IPC sender check follows the page actually loaded.
- **Theme file for light workspaces.** The 2026-10-02 code never wrote `window-theme` for a light workspace: the write was skipped when the theme matched the default. That was harmless while light was the assumed default. Now a missing file means "wait", so the file is written whenever it is missing or different.
- **First launch slower.** Not changed. The extra time on a first launch is Chromium compiling and caching the page's code and the office's shaders on this machine. Those caches live in the data folder and cannot be shipped with the build. The loading page now covers that time in the right colours.
- **Timing line.** `main.log` now records each step's own duration instead of the time since start, plus the total, the time since the process began, the theme, and when the window was shown: `startup window=… recovery=… store=… services=… reconcile=… page=… total=… process=… theme=dark shown=0ms`. `shown=0ms` means shown at once; `shown=135ms` means a first launch that waited for the workspace.
- **Backup race.** Re-checked; the fix from the 2026-10-02 round stands (the backup and boot tests pass, 13 of 13).
- **Loading page overlap.** The loading page now loads while the workspace opens and the services start, instead of before them.

## Review fixes (Claude)

- **Startup (Codex's version).** It hid the window on every launch until the workspace was read. On the real workspace that is 0.2–0.4 s with nothing on screen, even when the theme was known. It also relied on `ready-to-show`, which fires for the window's blank first document before the theme is known, so on a first launch the window appeared only with the full page. Its renderer change let the page's built-in theme override the page's own stored one, which is stale after a restore or crash reload. The page's stored theme now wins again; the built-in theme covers only a page that has none.
- **Reviews.** The inline preview lost the "open in the full viewer" action the old single preview pane had. It is back.
- **3D view.** Space no longer scrolls the page while the view has focus. That behaviour was dropped when the keys became configurable.
- **Settings.** "Checking..." now uses the same ellipsis as the rest of the app, and the Controls pane has its own section in the file.
- **Packaged settings check.** It replaced the app's IPC handlers before the app had registered them, which only worked by timing. It now waits for the office to load first.

## Verification

All runs used new, empty scratch `QRO_USER_DATA_DIR`s with synthetic agents (Test dir 1, Test PM A–D, Test worker 1 on synthetic Devin `swe-2-max` seats). No provider was called. The real workspace was not opened.

| Check | Result |
|---|---|
| `prettier --check` (all sources and tests), `tsc --noEmit`, `git diff --check` | clean |
| Unit suite (`pnpm test`) | **1,082 tests: 1,081 pass, 0 fail, 1 existing skip**. New: controls parsing and swapping, Devin labels, cross-provider paging (`tests/settings-reviews.test.ts`), full review sequence order (`tests/job-outputs.test.ts`). Run before the last startup edit, which changed only when the first-launch window is shown (`main.ts`, not unit-tested; the desktop checks below cover it). |
| Browser preview `tests/settings-reviews.browser.ts` | PASS. Covers the single Check account (three checks, one synthetic failure reported), the isolation order and table, controls that survive a reload and reset, nested in-order reviews with Recorded details last, no horizontal overflow at 390 px, mixed-provider paging and refresh, and the model label. |
| Dev-build desktop suites | PASS: `office3d-revision` (office behavior round), `desktop.e2e`, `office3d` (webgl=true), `ui-revision`, `revision`, `office-chat`, `pipeline-request`, `pipeline`, `startup-theme` |
| Packaged **test** build | PASS: `settings-reviews.desktop` (re-bound keys and mouse buttons move the rendered 3D view; isolation, history, labels), `office3d` (webgl=true), `desktop.e2e`, `ui-revision`, `revision`, `startup-theme` |
| First-launch theme (`tests/startup-theme.desktop.ts`, dev and packaged) | PASS. Over a dark workspace with no `window-theme` file, the window was never visible in light colours: its first visible frame was the dark loading page, and the page's first `data-theme` was dark. Later launches showed the window at once in the remembered theme, and Light after switching. The packaged run failed once on an assertion that was too strict: the sampler started after the window was already shown, so it saw no hidden phase. The window was right (first visible frame dark, `shown=183ms`). The check now reads the wait from `main.log`. |
| **Release** build of `99df397` (fuses: RunAsNode, NodeOptions and NodeCliInspect disabled) | `tests/installed-smoke.desktop.ts` PASS: office heading and first 3D frame, empty roster, `shown=191ms` on the first launch and `shown=0ms` on the second. asar SHA-256 `5F011906E12A5E25F92D594731B63E6E787617A2366230C512B8A788D447128B`, 95 files. **Not installed.** |
| Startup timings (release, empty scratch workspace) | `total` 335–428 ms from `start()` to the page, `process` 491–624 ms. The first launch's window appeared about 0.19 s after start. |

Evidence: `Docs\Reviews\settings-reviews-2026-10-02\` (screenshots, unit log, suite results, the theme run output, release fuses and smoke).

Not run: `agents.e2e` and `three-agent.live` (live providers), `isolation-acp.desktop` (needs the QRO-Agent account), CI (no PR), a screen-reader pass, other GPUs.

## Source

- Branch `codex/settings-reviews-20261002`, worktree `Worktrees\settings-reviews-20261002`, on top of `c117b5a` (office behavior), which is on top of `f4af109` (= `origin/main`).
- Commits: `66d35ff` (A, Codex's work with the review fixes), `99df397` (B), then this log.
- No dependency, store schema, shared type, IPC bridge or CI change. The session-history sort is in a read query, not the schema.
- Installed: App\ holds the release build of `99df397` (asar `5F011906E12A5E25F92D594731B63E6E787617A2366230C512B8A788D447128B`, 95 files; RunAsNode, NodeOptions and NodeCliInspect fuses disabled), smoke-tested with `tests/installed-smoke.desktop.ts`. Rollback: `Archive\App-before-settings-reviews-20261002` (the `c117b5a` release, `6618F0CC…C500`).

## Proposed roadmap entry

Roadmap §17 and §11 are organizer-owned (AGENTS.md); the integrating session appends them. The text is in the handoff, `Docs\Reviews\settings-reviews-2026-10-02-handoff.md` (outside Git).
