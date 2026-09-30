# Quant Research Office

A local-first Windows desktop office for quant research teams. It plans work, runs office tasks on the user's own local coding agents (Claude Code, Codex, Devin), verifies what they return, and keeps an append-only record of every request, decision and piece of evidence. The main experiment always runs outside the office: the user runs the exported package manually (for example in Colab) and imports the returned files.

The office never runs research compute on the desktop, never controls Colab, never uses a developer's account or key, and has no brokerage or trading connection. Hosted agent dispatch is not enabled (roadmap R5).

- Plans and status: [docs/ROADMAP.md](docs/ROADMAP.md) — section 11 for status, section 17 for the dated log.
- The desktop app, development and tests: [app/README.md](app/README.md).
- Rules for coding agents: [AGENTS.md](AGENTS.md); Claude Code also reads [CLAUDE.md](CLAUDE.md).
- Workflow reference: [docs/workflow.md](docs/workflow.md). Earlier architecture documents and the roadmap archive are in [docs/history/](docs/history/).

## Parallel development

Two workflows are supported ([roadmap section 1.5](docs/ROADMAP.md#15-parallel-coding-and-packet-workflows-d2)). The fixed desktop batch runs up to seven local workers plus an organizer through `tools/desktop.mjs` and the [desktop session manual](docs/DESKTOP-SESSIONS.md). Packet waves give each pre-written packet its own branch from `main` and its own PR. Either way, changes reach `main` only through the protected GitHub PR after the exact head passes the required `verify` check.

```powershell
git fetch origin
node tools/parallel.mjs init ui-round-1 7
```

`init` creates an organizer and worker worktrees in the sibling `<repo>-sessions/<batch>` folder, all pinned to one commit. It launches no model sessions. `assign` validates a task's file ownership and `check` inspects a worker's committed diff. A fixed eight-session batch is configured with `node tools/desktop.mjs setup <batch-directory>` and then operated only through the desktop manual.
