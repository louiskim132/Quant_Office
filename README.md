# Quant Research Office

A Windows desktop controller for subscription-based research planning. The source version is defined in [app/package.json](app/package.json). See [desktop instructions](app/README.md) and the [feature readiness matrix](app/docs/readiness.md).

The current revision adds canonical request drafts, named participants, single-agent/group/team selection, optional scientific details, project folders, lifecycle fixes, profile conflict checks and verified backup round trips. It preserves the SQLite event chain and keeps old records readable.

**Hosted research execution is not connected.** Signing in verifies subscription metadata; Start request records readiness blockers and submits no provider work. No local research execution, paid API fallback or Colab connection exists. Exports are planning records, not approved ML deliverables.

The [single roadmap](docs/ROADMAP.md) contains current readiness, the ordered repair backlog, the full research pipeline, validation commands and continuation instructions. Documents under docs/ describing earlier architectures are historical designs; their budget, fixed-team and execution claims do not establish runtime behavior.

## Parallel development

`main` is the integration branch. Start each Codex or Claude Code implementation task in its own Git worktree and feature branch; never run two writing sessions in the same checkout. Codex desktop can create a managed worktree from `main`. For a manual Claude Code checkout, use a unique sibling folder and branch, for example:

```powershell
git fetch origin
git worktree add ..\quant-team-my-task -b claude/my-task origin/main
```

Open the new folder in Claude Code and merge through a reviewed pull request. Project-wide agent rules are in [AGENTS.md](AGENTS.md); Claude Code starts with [CLAUDE.md](CLAUDE.md).
