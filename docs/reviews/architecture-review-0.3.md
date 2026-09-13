# Architecture 0.3 — independent document review

Review type: ad hoc architecture consistency review by a separate Codex subagent, with local integration by the primary agent. This is not a production PM-B/Claude Opus 5 review, an executed test report, a provider capability probe or certification of a running application. The input inventory from before this review is preserved in records/reviews/architecture-input-inventory-0.3.json; it records file identities, not a complete immutable copy of all original document contents.

Scope: desktop execution boundaries, generalized team roles, independent review, Colab exclusion, hosted execution, artifacts, authority, budgets and durability. The reviewer read architecture, provider execution, team protocol, workflow, records, UI, decisions, acceptance criteria and relevant handoff requirements. No research code, tests, provider probes or Colab interaction were executed.

## Original independent findings

These positions are preserved even after correction. Line anchors refer to the documents as inspected before the revisions below.

1. **AR-001 / P1 — Reserve maximum liability, not estimated spend.** Original provider-execution.md line 66 reserved estimated costs, while line 68 permitted hosted jobs to continue disconnected. Concurrent jobs could fit estimates inside a shared ceiling while their permitted individual charges exceeded it. Required fix: atomically reserve each invocation's maximum enforceable liability, including tools/exports; enforce reconciled spend plus outstanding reservations plus new reservation within all applicable ceilings; unknown liability blocks hard-ceiling dispatch.

2. **AR-002 / P2 — Make smoke acceptance an explicit full-run prerequisite.** Original workflow.md line 18 permitted full-run approval following preflight, while line 26 described smoke placement without requiring acceptance. Required fix: bind accepted compatible smoke evidence before full-run approval or bind a launcher that mechanically enforces smoke success before expensive computation. Define any contract-level inapplicability explicitly.

3. **AR-003 / P2 — Define how protected-region policy controls artifact grants.** Original workflow.md line 70 protected holdout regions, while provider-execution.md line 54 granted files without specifying mixed-region files or derived artifacts. Required fix: partition/classify artifacts and record exposure lineage before provider transfer; mixed/unclassified inputs remain unavailable to ordinary contexts; protected access requires specific user authority and a durable pre-transfer exposure event; no local scientific partitioning.

## Implementation response

The primary agent accepted all three findings and amended the specification:

- AR-001: provider execution, record contracts, architecture and execution-policy metadata now require maximum enforceable liability across all ceilings. Estimates remain separate, unknown liability blocks dispatch, and reconciliation cannot double-count or prematurely release reservations.
- AR-002: full-run approval now selects accepted compatible smoke evidence or an explicitly reviewed enforcing launcher. A conditional package approval is not evidence that smoke already passed. Only a predeclared task without an expensive stage may mark smoke inapplicable.
- AR-003: artifact grants now bind content/partition, role, purpose, region and derived exposure lineage. Protected access requires a user decision and exposure record before transfer. Scientific repurposing requires a new contract. Partitioning is user-prepared or separately authorized provider work.

The primary record review separately corrected three issues:

- LR-001: use a finalized payload archive plus detached release/approval envelope; self/enclosing hashes are excluded from the internal inventory and the outer transport hash belongs only to its transfer receipt.
- LR-002: specify canonical JSON control-character escaping, Unicode handling, integer bounds/format and negative-zero normalization, rather than leaving serializer behavior ambiguous.
- LR-003: explicit accepted preflight import leaves the waiting state before hosted validation begins; full-run approval remains blocked until content validation and smoke gates are satisfied.

All changes are specification changes. Runtime enforcement remains unimplemented and untested. A follow-up independent review of the amended definitions is recorded separately below when available.

## Follow-up independent position

Verdict: **NO_DEFECT_FOUND in the reviewed resolutions.** The separate reviewer marked AR-001, AR-002, AR-003, LR-001, LR-002 and LR-003 resolved by the amended documentation and confirmed that policy metadata, decisions and acceptance criteria reflect them. The original findings above remain part of the record.

Follow-up scope was read-only architecture consistency. No executable schemas, financial enforcement, provider capability, access controls, canonicalization golden vectors, launcher ordering, recovery behavior or Windows EXE were tested. This is neither PM-B/Claude verification nor runtime certification.
