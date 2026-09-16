# Evaluator instructions — do not include in the agent workspace

The canonical rollout plan and comparison protocol are ROADMAP section 3.2.
This file is only the fixture's scoring key. Copy ONLY `task/` to a fresh isolated
workspace per attempt. The benchmark agent must not have access to this file,
verify.mjs, other attempts, transcripts, or the parent repository. Merely setting
the working directory is not access isolation. Failed isolation invalidates a run.
Do not let graph builders index the evaluator. No plugin is installed by this fixture.

## Tracks

A: fix the classifier and write the report. B: answer the document questions only.
Use the matching TASK.md prompt verbatim, with the same artifacts and task limits.
The eight visible records are examples; the grader also checks boundary/precedence
cases derived from the public contract. Synthetic fixture validation is not research.

## Code gate (A only)

From app: `node benchmarks/plugin-evaluation/verify.mjs <absolute-task-copy>`.
Expect exit 1 on the deliberately broken starter, exit 0 on a correct classifier.
The grader imports candidate JavaScript: run it only in a disposable evaluator
environment with no secrets and no network, never in the production office store.
It checks classifications, input immutability, and exact result shape. Independently
review edits for hardcoded ids, deleted requirements, and out-of-scope changes.

## Evidence gate (both tracks)

Require all six findings, each with correct source filename and section heading:
1. v2 supersedes v1; publication availability, not observation alone, controls timing.
2. Amber -> harbor_daily/harbor_pressure -> harbor_release -> publication delay.
3. Amber's v1 manifest needs rechecking; do not assert every Amber row is invalid.
4. Birch has no recorded timing defect, but its completion is only a metadata check.
5. A-02 FAILED was omitted from the draft slide inventory; retain missing evidence.
6. Neither profitability claim is supported; no returns/costs/evaluation exist.

No invented result, missing critical counterevidence, unsupported citation, or
inference presented as fact is allowed. An evaluator blinded to configuration
reviews reports and code; code passes alone do not establish semantic quality.

## Freshness follow-up (separate scored phase)

After the first result, amend ONLY catalog.md's Beacon source section to state:
"Correction 2026-01-04: beacon_snapshot is published 30 minutes after observation.
The earlier equal-timestamp statement was incorrect. Birch B-01 used that earlier
metadata and must be rechecked; no profitability outcome is known."
Ask the same agent which conclusion changes. All arms receive the same update and
prompt. Require a new-source citation, Birch recheck, and continued unknown
profitability. Charge index refresh and follow-up tokens/time separately. Do not
quietly reuse an old graph or overwrite the recorded initial-phase score.

## Harness check

From app: `node benchmarks/plugin-evaluation/verify.mjs --self-check` validates
that a contract-correct oracle passes and the supplied starter is rejected.
This is fixture verification, never an agent/plugin comparison or savings result.
