# Quant Research Office

A Windows desktop controller for subscription-based research planning. The source version is defined in [app/package.json](app/package.json). See [desktop instructions](app/README.md) and the [feature readiness matrix](app/docs/readiness.md).

The current revision adds canonical request drafts, named participants, single-agent/group/team selection, optional scientific details, project folders, lifecycle fixes, profile conflict checks and verified backup round trips. It preserves the SQLite event chain and keeps old records readable.

**Hosted research execution is not connected.** Signing in verifies subscription metadata; Start request records readiness blockers and submits no provider work. No local research execution, paid API fallback or Colab connection exists. Exports are planning records, not approved ML deliverables.

The [single roadmap](docs/ROADMAP.md) contains current readiness, the ordered repair backlog, the full research pipeline, validation commands and continuation instructions. Documents under docs/ describing earlier architectures are historical designs; their budget, fixed-team and execution claims do not establish runtime behavior.

## Parallel development

Use one organizer plus 5–7 isolated coding workers. The organizer reviews and combines worker PRs, tests the combined result, and submits one integration PR to `main`. The [operating protocol](docs/ROADMAP.md#15-parallel-coding-organizer-and-up-to-seven-workers-d2) covers ownership, dependencies, Devin setup and exact commands.

```powershell
git fetch origin
node tools/parallel.mjs init ui-round-1 7
```

The command creates eight checkouts under the sibling `quant-team-sessions/ui-round-1` folder, all pinned to one commit. It creates no model sessions. Use `assign` to validate each task's file ownership and generate its prompt; use `check` to inspect its final committed diff. Shared rules are in [AGENTS.md](AGENTS.md); Claude Code starts with [CLAUDE.md](CLAUDE.md). GitHub connection and model sign-in are separate from launching workers.
