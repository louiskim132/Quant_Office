> Historical architecture specification. Current runtime status and superseding constraints: [roadmap status, section 11](../ROADMAP.md#11-execution-checklist-and-progress-record). Fixed-team and API-budget provisions below are not active product defaults.

# Team, authority and independent review — architecture 0.3

The team is one reusable set of role definitions, instantiated into isolated contexts per project, experiment and task. All role inference and executable work occurs on OpenAI or Anthropic infrastructure. The local application is the deterministic controller and message transport.

## Role contracts

| Role | Mandate | Inputs | Required output | Authority limits |
| --- | --- | --- | --- | --- |
| Director — GPT-6 Astra | Form bounded hypotheses, freeze contracts, choose next experiments, resolve competing positions | User mandate, scientific proposals, original reviews, rebuttals, verified evidence, budget | Versioned contract or decision with rationale, evidence and reopening condition | Cannot override missing required evidence or a hard failure; cannot raise user spending/scope limits |
| PM-A — GPT-5.6 Sol | Deliver approved behavior and integrate work | Frozen contract, source/data identities, acceptance definitions | Implementation position, code/package, acceptance mapping, execution evidence, limitations | Cannot certify independent verification or change science/tests unilaterally |
| PM-B — Claude Opus 5 | Find correctness, leakage, schema, unit and reproducibility defects | Frozen spec, patch, test definitions, raw job artifacts; no A conclusion on first review | Independent review with demonstrated defects or NO_DEFECT_FOUND and tested/untested scope | Blocks release on a concrete hard failure or missing required evidence; speculative objections need bounded resolution |
| PM-C — Claude Opus 5 | Define metric/uncertainty/statistical analysis and determine supported findings | Contract and verified raw evidence; no D conclusion on first analysis | Analysis proposal or findings report, executable calculations, uncertainty, scope limits | Cannot relabel invalid evidence as a scientific null or redefine criteria after results |
| PM-D — GPT-5.6 Sol | Seek artifact explanations and independently check economics | Contract and the same verified evidence as C; no C conclusion initially | Counterexamples, independent oracle, economics/falsification report, claim limits | Blocks advancement under frozen criteria; cannot select favorable costs from evaluation results |
| Workers — configurable | Produce a bounded patch, fixture, calculation or table | Supervising PM task and exact allowed inputs | Output manifest, changed files, logs, check evidence, usage and limitations | No approvals, scientific amendments, direct Director delivery or unapproved subdelegation |

PM-A owns executable data-integrity implementation; PM-B challenges it. PM-D defines an independent cost oracle where relevant; a worker can implement it under review. There is no extra permanent data-integrity team. PM-C statistical workers execute calculations in provider infrastructure and attach code, inputs and outputs.

## Task and context construction

Every invocation binds role instruction version, provider/model identity, project/experiment/task IDs, supervising PM, exact inputs, allowed artifact namespace, tools, deadline, budget and expected output schema. The controller assembles only records that role is allowed to see. Provider-reported session/task IDs are retained with every reply.

Context comprises role policy, frozen research contract, bounded task, selected evidence and prior allowed positions. Long-history summaries are provider-generated artifacts that retain references to original records; they never replace dissent. Context size and summarization cost count toward the budget.

Implementation and verification have distinct contexts and sandbox namespaces even when the same worker model/slot is reused. A shared writable workspace, shared memory index or report search tool must not leak first conclusions across the review boundary. Cross-project evidence is visible only after an explicit, provenance-linked import. All approved input grants expire with the task or round.

Workers return to their supervisor. The PM evaluates acceptance, integrates work and submits a position. A worker's “done” message means output received, not task accepted. The controller distinguishes provider completion, artifact completeness, PM acceptance and independent verification.

## Independent rounds

### Contract review

The Director drafts the hypothesis and constraints. PM-C proposes metrics/statistical rules; PM-D proposes applicable economics and falsification; PM-A evaluates implementation feasibility; PM-B identifies missing or inconsistent acceptance conditions. The Director freezes the resolved contract within user scope. Unresolved required external facts stay blockers. These discussions are versioned inputs, not automatically authoritative preregistration.

### Implementation round A/B

1. Freeze one input bundle: contract, source/patch, acceptance/test definitions, environment and raw execution evidence.
2. PM-A submits its implementation report to the controller. PM-B gets the frozen bundle without A's conclusions, verdict summary, conclusion-bearing filenames or acceptance labels that disclose A's position. Raw execution outputs remain available as evidence; independent review is not denial of facts.
3. Persist B's first report and A's first report immutably. If either is missing, the round remains incomplete.
4. Share both reports with the authorized participants. Permit one rebuttal from each. A no-rebuttal declaration closes that side.
5. Assemble original reports, rebuttals, concrete unresolved objections and evidence into a Director packet. The Director records revise, retire or advance for that exact bundle.

### Findings round C/D

After the user imports external results and required hosted validation completes, C and D independently receive the same immutable evidence bundle. They have separate contexts, calculation outputs and first reports. Store both before mutual disclosure, allow one rebuttal each, then send the packet to the Director. Where provider resources cannot reconstruct a required calculation, the report is explicitly incomplete/inconclusive; no local or Colab agent execution fills the gap.

A timed-out reviewer cannot be replaced by its counterpart's self-review. Retrying a reviewer uses the same disclosed-input boundary. If the original bundle changes, create a new round and invalidate affected approvals rather than editing an old report.

## Concrete disagreement rules

| Disagreement | Required resolution |
| --- | --- |
| Deterministic violation | Reproducible counterexample, fix, fresh execution evidence and affected review |
| Missing evidence | Collect evidence or freeze a narrower claim in a new contract |
| Statistical/economic disagreement | One specified calculation or experiment with a budget and decision rule |
| Scientific policy change | New research contract/version and invalidated downstream approvals |
| Speculative concern without demonstration | Record uncertainty; Director requests a bounded probe or states why it does not block the current claim |

Reviewers must actively seek counterexamples. NO_DEFECT_FOUND is acceptable with executed checks and limitations. Objection counts are not a success metric. A passing engineering workflow does not establish profitable or deployable research.

## Bounded operation

The global worker pool has two slots. PMs can prepare bounded work, but spawned executable worker jobs must reserve a slot. No hidden nested agent expansion is allowed; use a flat controller-visible task graph initially. Models cannot increase their own budgets or concurrency.

Each task has an initial attempt and at most two repair attempts, recorded separately from bounded transient transport retries. After repairs are exhausted, escalate to the Director with the evidence. Extra discussion/computation requires a concrete unresolved question and available approved budget; additional rebuttal rounds are not automatic.

The user owns goals, external facts, account permissions and spend ceilings. Routine code/control repairs proceed within the approved contract. Questions are collected into a small decision inbox with reason, owner, affected gates and proposed resolution. The team never asks the user to approve a vague claim that work is complete.

## Team-quality evaluation

Evaluate roles using seeded deterministic defects and valid controls, hidden from the evaluated role where appropriate. Track detection, false positives, evidence quality, unnecessary blocking, repair attempts, elapsed time and actual cost. Compare outputs rather than assuming expensive models or provider diversity guarantee independence or correctness.

Reuse generic defect classes from the CatBoost example when relevant: import side effects, unit errors, missing/empty fields, temporal boundary mistakes, unsupported family sizes, stale checkpoints, failed-check propagation and misleading null reports. Include a separate non-CatBoost task and project-specific fixtures.

Role changes require a versioned configuration record. Existing reports retain the actual model and instructions that produced them. No independent PM reports have been generated by this architecture-writing session.
