## Task and result

Packet or worker ID, objective, base commit, and the resulting behavior:

## Scope

Changed paths, and any dependency on another PR:

## Verification

Exact commands and their actual results; screenshots or a packaged-app check for UI changes. List every check that did not run.

## Organizer handoff

Head commit SHA, unresolved defects, migration or interface impact, and the proposed roadmap entry (workers do not edit `docs/ROADMAP.md`).

In a desktop batch, worker PRs target the batch organizer branch and the organizer opens the integration PR to `main`. A packet-wave PR targets `main` directly. Either way, only the organizer merges, through this PR, after `verify` passes on its exact head.
