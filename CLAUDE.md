# Claude Code project instructions

Read and follow [AGENTS.md](AGENTS.md). It contains the shared rules for both Claude Code and Codex.

Before implementation, read `docs/ROADMAP.md` section 1 (including the organizer protocol in 1.5), section 11, and the exact current task packet. Work only in the assigned isolated checkout and branch from the batch's frozen base; do not share a writable checkout or push directly to `main`. The organizer alone updates the roadmap; workers propose updates in their PR handoff.

When `SESSION.md` exists, this checkout is part of the fixed desktop batch. Read it and `docs/DESKTOP-SESSIONS.md`; run `node tools/desktop.mjs status`. A worker may implement only the current packet returned by `start`. The organizer may announce `WORK READY` only after `publish` succeeds.

Claude is the primary provider named by the roadmap, but that does not relax the hosted-execution, evidence, isolation, or live-provider gates in section 1.1.
