# Evaluator runbook — plugin-evaluation comparison

Operating procedure for one evaluator session running the synthetic comparison in
roadmap section 3.2. The canonical plan, arm table, budget and quality gates live
there; the scoring key and isolation rules live in EVALUATOR.md. This file orders
the steps only — it installs no plugin and performs no provider call. Every
participant session and the blind review are manual steps; their inputs and
outputs are named below. Evaluator-side material: never ship it to a participant
workspace.

Harness entry points referenced below — `harness/attempt.mjs` `prepareAttempt`,
`harness/freshness.mjs` `applyFreshnessAmendment`, `harness/ledger.mjs` append/read,
`harness/scorecard.mjs` `scorecard`, `harness/score.mjs` `blindPacket`/`recordScore`/
`runCodeGate` — are this round's intended surface. If one is absent, do the step by
hand against the record contracts in `harness/records.mjs` and note the
substitution in the ledger. Run harness and verify commands from `app/`.

The evaluator keeps a run root in the disposable environment, outside every
participant workspace: `attempts/<attemptId>/` holds each copied task dir and its
collected outputs; `ledger.jsonl` holds one record per attempt in append order.

## 0. Environment checklist (once, before any attempt)

- Disposable evaluator environment: no provider credentials or secrets, no network
  beyond the participant tool's own session traffic. The grader imports candidate
  JavaScript — never run it in the production office store (EVALUATOR.md).
- Per-attempt isolation: a fresh directory holding ONLY the copied `task/`. The
  participant must not see EVALUATOR.md, RUNBOOK.md, verify.mjs, other attempts,
  transcripts or the parent repository. Setting a working directory alone is not
  isolation; a failed isolation invalidates the run — record it and stop.
- Node available for the harness and verify.mjs.
- Freeze before the first attempt: provider, model, effort and client/runtime
  versions identical across arms (different models are not a plugin effect); the
  arm list (A0, AS, AP, AG, B0, BG, and BL only where its configured route is
  permitted); one fresh attempt per arm; the 10-minute task timebox
  (`TIMEBOX_MS`); the preregistered setup/indexing limit. No silent reset/retry.
- Prerequisite flag: BL (LightRAG) requires a permitted configured model route —
  no paid inference, unsupported subscription reuse or new local model service.
  Without one, record BL as BLOCKED_EXTERNAL; an unrun arm is not a zero-cost run.
- Do not let any graph builder index the evaluator checkout or run root.

## 1. Fixture integrity check

From `app/`: `node benchmarks/plugin-evaluation/verify.mjs --self-check`.

Expect `status: "FIXTURE_CHECK_ONLY"`, oracle passing all cases, starter rejected.
A failed self-check means the fixture is broken: stop, run no attempts. This
verifies the fixture only — it is not an agent, plugin or savings result.

## 2. Per-attempt flow (baseline arms A0, B0)

1. Prepare — `prepareAttempt` (or by hand): copy ONLY `task/` into
   `attempts/<attemptId>/`; write the manifest (`plugin-eval-attempt@1`):
   attemptId, arm, phase `INITIAL`, promptSha256 of the exact prompt bytes,
   taskHash plus per-file sha256/bytes of the copied inventory, config
   {provider, model, effort, clientVersion, tools: [] for baseline}, timeboxMs
   600000, setupMs, createdAt. Append it to the ledger.
2. Participant session (manual) — start the participant tool on the attempt dir
   with the track's verbatim TASK.md prompt (Track A for A-arms, Track B for
   B-arms). Input: the copied task dir and prompt. Start the task clock when the
   prompt is delivered; stop at completion or the timebox, whichever is first. A
   timeout is a failed attempt — record it; do not reset or retry.
3. Collect — copy the attempt outputs (track A: changed files plus REPORT.md;
   track B: REPORT.md) back to the run root and write the usage record
   (`plugin-eval-usage@1`): attemptId, agent {input, output, reasoning,
   cacheRead, cacheWrite}, helperModels [{name, input, output}], setupWallMs,
   taskWallMs, toolBytes, note. Copy only counters the tool actually reports; an
   unobservable counter stays null = UNKNOWN, never 0. Record provider-cache
   observations rather than assuming a fresh chat is cold. Exclude download
   bytes from token counts; count install/setup wall time in the setup fields.
   Tokens are not subscription allowance or money.
4. Ledger — append usage and artifact pointers for the attempt.
5. Hold all scoring for the blind review (section 5).

## 3. Plugin-arm additions (AS, AP, AG, BG, BL)

Baseline flow plus, for each attempt:

- Install: only the declared pinned tool version into the disposable environment,
  never the production store. Charge install/index wall time to setup, never to
  task time.
- Bind: a separate tool process/index bound to that attempt's exact workspace.
  Project selection is not filesystem isolation; incompatible sessions get
  separate mutable indexes/processes (roadmap 3.2).
- Readiness: before the task clock starts, run a real project-scoped query against
  the attempt workspace and record it. A mailbox-style session needs an
  acknowledged bootstrap/tool check — written config files alone are not
  observation. If readiness fails, record failed/unavailable and do not run; an
  optional-tool fallback is allowed only when the recorded policy permits it, and
  the attempt is then labeled degraded, not a successful plugin arm.
- Manifest: `config.tools` lists exactly that arm's declared additions.
- Cold vs reuse: a repeat attempt may reuse only an index built from the same
  initial source snapshot — never answers, edits, session memory or evaluator
  material. Record cold build versus reuse per attempt; refresh work belongs to
  the FRESHNESS phase.
- Permissions precede graph/index access: the tool must never index the evaluator
  checkout, other attempt dirs or transcripts.

## 4. Freshness phase (every arm, after INITIAL is scored)

1. `applyFreshnessAmendment` (or by hand): amend ONLY the Beacon source section of
   `docs/catalog.md` in each attempt dir with the exact correction text in
   EVALUATOR.md. Write a new manifest with phase `FRESHNESS` and a fresh
   attemptId; never overwrite the INITIAL records.
2. Participant session (manual): the same arm configuration receives the same
   follow-up prompt asking which conclusion changes. Same timebox and collection
   as section 2.
3. The response must cite the new source, recheck Birch and keep profitability
   unknown — recorded on the FRESHNESS score as freshness {newSourceCited,
   birchRecheck, unknownPreserved}.
4. Charge index-refresh and follow-up tokens/time on the FRESHNESS usage record
   (setupWallMs/taskWallMs). Do not quietly reuse a stale graph.

## 5. Blind review (manual)

- `blindPacket` (or by hand): per attempt, assemble a review packet — REPORT.md
  plus the code diff on track A — stripped of arm and tool identity.
- A reviewer who has not seen arm identity scores each packet against the six
  EVIDENCE_FINDINGS and the EVALUATOR.md honesty bar (no invented result, missing
  critical counterevidence, unsupported citation, inference presented as fact).
  Input: blind packets. Output: per-finding verdicts. Code passes alone do not
  establish semantic quality.

## 6. Scoring and scorecard

- Track A only: `runCodeGate` → from `app/`, `node
  benchmarks/plugin-evaluation/verify.mjs <absolute-task-copy>` inside the
  disposable environment. Expect exit 1 on the broken starter, 0 on a correct
  classifier; record codeGate {ran, exitCode, passed, total}. The quality gate
  needs all 16 cases; independently review diffs for hardcoded ids, deleted
  requirements and out-of-scope edits.
- `recordScore` writes `plugin-eval-score@1`: attemptId, codeGate (null on track
  B), findings listing all six ids in EVIDENCE_FINDINGS order with verdicts —
  PRESENT requires the cited source filename and section heading — the freshness
  block on FRESHNESS scores, defects [], blind: true.
- `scorecard` compares arms per roadmap 3.2: total observed usage across ALL
  attempts (failures included) per successful task, paired medians/ranges, and
  cold/reuse break-even. Zero successful tasks → no finite efficiency score.
  Savings within observed variation or missing counters → INCONCLUSIVE. A gate
  miss is not promoted for smaller output. This tiny fixture may show no graph
  benefit — that is a reportable result, and it proves nothing about
  production-scale quality.

## 7. Teardown

- Shut down every plugin process/index started in section 3 and verify none
  remain.
- Preserve every attempt dir, manifest, usage and score record; a ledger read must
  show one complete record per declared attempt.
- Confirm no evaluator material reached any participant workspace or index.

## 8. Failure and honesty rules

- Missing counters are null/UNKNOWN, never 0 and never estimated.
- Failed and timed-out attempts still count in the arm's total usage.
- No silent rerun, reset or retry: a retried attempt is a new attemptId with the
  failure preserved in the ledger.
- Quality before efficiency: a configuration that misses a gate is not promoted
  for smaller output.
- Never claim savings for a configuration that did not run; unrun arms are absent
  rows, not zeroes.
- Contaminated isolation (participant saw evaluator material, other attempts or
  transcripts) invalidates the attempt; record the violation.
- INCONCLUSIVE and no-finite-score are valid outcomes — report them.
- Keep existing retrieval available regardless of the outcome.
