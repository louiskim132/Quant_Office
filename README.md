# Quant Research Office

A Windows desktop controller for subscription-based research planning. The source version is defined in [app/package.json](app/package.json). See [desktop instructions](app/README.md) and the [feature readiness matrix](app/docs/readiness.md).

The current revision adds canonical request drafts, named participants, single-agent/group/team selection, optional scientific details, project folders, lifecycle fixes, profile conflict checks and verified backup round trips. It preserves the SQLite event chain and keeps old records readable.

**Hosted research execution is not connected.** Signing in verifies subscription metadata; Start request records readiness blockers and submits no provider work. No local research execution, paid API fallback or Colab connection exists. Exports are planning records, not approved ML deliverables.

The [single roadmap](docs/ROADMAP.md) contains current readiness, the ordered repair backlog, the full research pipeline, validation commands and continuation instructions. Documents under docs/ describing earlier architectures are historical designs; their budget, fixed-team and execution claims do not establish runtime behavior.

## Parallel development

Use one organizer plus up to seven isolated coding workers. The organizer reviews and combines exact worker commits, tests the combined result, and submits one integration PR to `main`. The governing [roadmap protocol](docs/ROADMAP.md#15-parallel-coding-organizer-and-up-to-seven-workers-d2) covers ownership and GitHub/hosted clients. The detailed [desktop session manual](docs/DESKTOP-SESSIONS.md) covers the fixed Session 1–7 workers plus Session 8 organizer workflow.

```powershell
git fetch origin
node tools/parallel.mjs init ui-round-1 7
```

The general command creates isolated checkouts under the sibling `quant-team-sessions/ui-round-1` folder, all pinned to one commit. It creates no model sessions. Use `assign` to validate a task's ownership and `check` to inspect its committed diff. A prepared fixed eight-session batch is configured with `node tools/desktop.mjs setup <batch-directory>` and then operated only through the desktop manual. Shared rules are in [AGENTS.md](AGENTS.md); Claude Code starts with [CLAUDE.md](CLAUDE.md). GitHub connection and model sign-in are separate from launching workers.
