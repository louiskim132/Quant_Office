# Quant Research Office

A Windows desktop controller for subscription-based research planning. The source version is defined in [app/package.json](app/package.json). See [desktop instructions](app/README.md) and the [feature readiness matrix](app/docs/readiness.md).

The current revision adds canonical request drafts, named participants, single-agent/group/team selection, optional scientific details, project folders, lifecycle fixes, profile conflict checks and verified backup round trips. It preserves the SQLite event chain and keeps old records readable.

**Hosted research execution is not connected.** Signing in verifies subscription metadata; Start request records readiness blockers and submits no provider work. No local research execution, paid API fallback or Colab connection exists. Exports are planning records, not approved ML deliverables.

The [single roadmap](docs/ROADMAP.md) contains current readiness, the ordered repair backlog, the full research pipeline, validation commands and continuation instructions. Documents under docs/ describing earlier architectures are historical designs; their budget, fixed-team and execution claims do not establish runtime behavior.
