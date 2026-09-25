# Claude Code project instructions

Read and follow [AGENTS.md](AGENTS.md). It contains the shared rules for Claude Code, Codex and Devin sessions.

Before implementation, read the exact current task packet and the bounded roadmap path in `AGENTS.md`: sections 1.1 and 1.5, the section 11 tables, and the newest dated entries at the end of section 17. Section 17, not section 16, holds the dated progress log. Work only in the assigned isolated checkout and branch from the batch's frozen base; do not share a writable checkout or push directly to `main`. The organizer alone updates the roadmap; workers propose updates in their PR handoff.

When `SESSION.md` exists, this checkout is part of the fixed desktop batch. Read it and `docs/DESKTOP-SESSIONS.md`; run `node tools/desktop.mjs status`. A worker may implement only the current packet returned by `start`. The organizer may announce `WORK READY` only after `publish` succeeds.

Session 9 (`repo-sessions\<batch>\reviewer`) is read-only. Before each review, run `git fetch` and check out `origin/main` or the PR head under review (detached), and state the reviewed SHA. It never edits files or takes part in the Session 1–8 orchestration. Only the user or Session 8 refreshes that checkout.

Outside a batch (no `SESSION.md`), work only in a new worktree under `Quant Office\Worktrees\` created from `origin/main`, never in `Quant Office\repo` or in a batch session's checkout.

Session 8 may merge only its own completed integration PR through GitHub after the current-head protection checks in `AGENTS.md` pass. It must never push directly to `main`. Sessions 1–7 never merge into `main`.

Claude is the primary provider named by the roadmap, but that does not relax the hosted-execution, evidence, isolation, or live-provider gates in section 1.1.
