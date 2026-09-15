# Quant Office: roadmap alignment review

Date: 2026-09-14
Reviewed checkout: `C:/Users/louis/Desktop/AI/Quant Office/repo`
Branch: `main`
Commit: `a7f845c91b6b0401affad9d2d0889abb380cf82c`
Working tree at review start: clean (`## main...origin/main`). No remote fetch was performed.

This is a review report, not a replacement roadmap or authorization to implement changes. It evaluates the current roadmap against the original checked-in handoff and the user's clarification in this conversation. Product code and the canonical roadmap were not changed.

## Executive finding

**The roadmap has materially shifted the execution boundary and the definition of a usable first release.** The requested product is an agent team that designs research, writes code, prepares run packages, coordinates independent PM reviews, and interprets results. The user manually executes ML training, evaluation, and backtesting in Colab and returns the results.

The current roadmap instead assigns the main candidate run to a controller and verified hosted executor, couples research progress to an independently provisioned signing harness and reviewer runtime, and adds a separate holdout custodian, shadow evaluation, and monitoring. Some of those controls support the original quality goals. Their placement as prerequisites for completing the user's basic workflow is the problem.

**This is more than a documentation inconsistency.** Source inspection confirms that the production pipeline has no configured independent research runtime, refuses preparation of independent reviews without it, and converts otherwise passing provider gate reports into blocked outcomes when independent harness verification is absent. However, this review found no evidence that real training or backtesting has actually been launched by the application.

The project contains substantial reusable work. The right correction is to restore the manual Colab workflow and match each requirement to the operation it protects. Deleting checks or declaring imported results independently verified would not accomplish that correction.

## 1. Baseline and evidence limits

The controlling intent for this review is the user's latest clarification:

> Colab, manually operated by the user, executes ML training/evaluation and profitability backtesting. Director, PMs, and workers handle coding, direction, cross-PM conversations, and quality checks.

That separation is supported by the original [handoff, lines 5–7](<C:/Users/louis/Desktop/AI/Quant Office/repo/reference/handoff-v1.0.txt:5>), its [manual Colab modes](<C:/Users/louis/Desktop/AI/Quant Office/repo/reference/handoff-v1.0.txt:88>), and its [first-implementation acceptance](<C:/Users/louis/Desktop/AI/Quant Office/repo/reference/handoff-v1.0.txt:198>). The older [workflow document](<C:/Users/louis/Desktop/AI/Quant Office/repo/docs/workflow.md:55>) explicitly has the user open Colab, run the package independently, and import outputs.

The original handoff also required hosted execution for agent-generated code and statistical calculations, with Colab as a fallback through a user task. It therefore does **not** establish that every product coding worker was meant to execute locally. The location of agents' tools is a separate decision from who runs the main experiment. The local developer worktrees used to build Quant Office are a third, distinct concern.

Sources inspected include roadmap sections 1–7, relevant later-stage and progress entries, the source/rationale register, historical handoff/workflow/team/subscription documents, and selected current scheduling, pipeline, admission, export, and desktop wiring code. This is a requirements and source review, not a comprehensive security audit or a fresh test run. Historical test counts are treated as reported evidence.

Git blame places the key hosted-only wording in the initial commit, `b635934`. Available Git history cannot identify the earlier discussion or decision that introduced it. The roadmap cites a later staged-team comment, but this review did not recover the complete originating conversation. Consequently, expansions are classified as conflicting, compatible, or requiring decision evidence; their authorship and authorization are not invented.

## 2. Findings

### F1 — Critical: the main experiment moved from the user to the system

**Original:** agents prepare an approved package; the user runs Colab preflight, smoke, training, and evaluation; agents examine the returned evidence.

**Current:** [section 1.1](<C:/Users/louis/Desktop/AI/Quant Office/repo/docs/ROADMAP.md:15>) requires training, backtesting, and diagnostics to execute only through verified provider-hosted infrastructure. [Section 3.1](<C:/Users/louis/Desktop/AI/Quant Office/repo/docs/ROADMAP.md:235>) describes a hosted research executor. Most decisively, [S3](<C:/Users/louis/Desktop/AI/Quant Office/repo/docs/ROADMAP.md:690>) assigns candidate execution to the controller and verified hosted execution.

**Impact:** implementing the canonical instructions leads toward provisioning execution services for work the user intended to perform manually. A missing hosted execution capability becomes a blocker for the main experiment even though the intended Colab route exists outside the application.

**Correction:** make user execution and result return explicit first-class stages. Agents may author and review the training/backtest code; execution of the approved main experiment belongs to the user's manual Colab step.

### F2 — High: “no Colab connection” has been confused with “no manual Colab workflow”

[Section 1.1](<C:/Users/louis/Desktop/AI/Quant Office/repo/docs/ROADMAP.md:16>) actually preserves manual export/import while prohibiting a Colab connection. The older [workflow](<C:/Users/louis/Desktop/AI/Quant Office/repo/docs/workflow.md:55>) explains the intended distinction clearly: the user operates Colab, while the app supplies files and instructions without connecting, polling, or controlling the notebook.

**Impact:** a valid boundary against agent access to Colab was interpreted as excluding Colab from the overall research process. The blanket hosted-only rule in F1 makes the ambiguity consequential.

**Correction:** explicitly say that manual Colab execution is the normal external run path, and that agents/controller have no runtime access. Keep those two statements together wherever the boundary is specified.

**Correction to this conversation:** my earlier claims that Colab was simply “prohibited,” and that it was excluded because it could not supply custody guarantees, overstated the documentary evidence. Manual Colab was explicitly supported. Those answers reinforced the drift rather than recognizing the contradiction.

### F3 — High: the current stage pipeline does not center the user handoff

The original workflow contains waiting states before preflight and the main run. Those names still exist in [shared types](<C:/Users/louis/Desktop/AI/Quant Office/repo/app/src/shared/types.ts:2>), but the current research scheduler maps S3 to a `PRINCIPAL` agent and treats S2–S10 as agent/stage operations. See [research-controller.ts](<C:/Users/louis/Desktop/AI/Quant Office/repo/app/src/main/research-controller.ts:15>) and [roadmap section 4](<C:/Users/louis/Desktop/AI/Quant Office/repo/docs/ROADMAP.md:278>), which describes the older stages as retained for historical replay.

**Impact:** retaining old enum names is not evidence that the intended export → wait → import → review journey works in the current product.

The inspected project export is explicitly a planning archive, and research export produces an evidence archive. These are useful capabilities, but do not by themselves demonstrate the fixed, approved Colab launcher and complete manual-run cycle promised by the original handoff. See [artifacts.ts](<C:/Users/louis/Desktop/AI/Quant Office/repo/app/src/main/artifacts.ts:255>) and its research evidence export around line 321.

**Correction:** acceptance must demonstrate a runnable frozen package, an explicit waiting state, restart while waiting, result import bound to that package, and subsequent independent PM review. Existing archive export should not be counted as that acceptance without exercising the complete journey.

### F4 — High: independent review has become dependent on additional trust infrastructure

The original design already required separate first reports, raw evidence, concrete objections, preserved disagreement, and no self-certification. Those requirements remain aligned with the user's goal.

The current implementation additionally requires an independent `ResearchRuntime`, signed isolation claims, and an Ed25519 trust anchor for harness claims. [main.ts](<C:/Users/louis/Desktop/AI/Quant Office/repo/app/src/main/main.ts:392>) constructs the pipeline with a null runtime. [pipeline.ts](<C:/Users/louis/Desktop/AI/Quant Office/repo/app/src/main/pipeline.ts:165>) refuses S2/S7 preparation without that runtime; collection around line 279 blocks passing gate claims when an independent harness is unavailable. [research-admission.ts](<C:/Users/louis/Desktop/AI/Quant Office/repo/app/src/core/research-admission.ts:5>) enforces the signature and pinned harness.

**Impact:** ordinary PM review and scientific progression depend on provisioning a separately trusted execution system. That dependency is materially stronger than delivering separate contexts and independently checking a user-run package.

**Correction:** specify the actual checks and isolation needed for each review, and distinguish controller-enforced report separation, independently executed calculations, and stronger provider/custody attestations. Retain accurate labels. A signature authenticates a configured signer's claim; it does not independently prove scientific correctness. The review does not recommend bypassing the present gates: revise their contract and implementation together.

### F5 — High: R5 combines a real transport problem with expanded product prerequisites

[R5 and section 5.3](<C:/Users/louis/Desktop/AI/Quant Office/repo/docs/ROADMAP.md:416>) require supported submission, observation, output retrieval, follow-up, cancellation, settings, and context controls. The roadmap records a route that could submit and send a follow-up but could not programmatically read results or cancel. Those are legitimate obstacles to automatically operating a director/PM/worker team, even with manual Colab execution.

The opening roadmap status additionally makes an independent research runtime and isolated custodian the next provisioning work. This makes “R5 blocked” read as one indivisible obstacle to the entire application.

**Correction:** report readiness separately for agent communication, agent tool execution where required, manual experiment handoff, returned-result validation, and optional protected evaluation. Restoring manual Colab removes the need for automatic main-run execution; it does not automatically fix agent messaging or result retrieval. This review did not retest current provider capabilities, so the historical provider blocker is not presented as a new account diagnosis.

### F6 — Medium: later research lifecycle features displaced the first useful milestone

The original first milestone was approximately ten assets, fixes to the supplied CatBoost pipeline, independent review, and a complete manual pilot. Later modeling redesign was explicitly separate. The current [S8–S10](<C:/Users/louis/Desktop/AI/Quant Office/repo/docs/ROADMAP.md:736>) adds a deterministic holdout custodian, shadow evaluation, and ongoing monitoring; section 2 adds a one-follow-up termination policy.

**Impact:** a full research lifecycle and its supporting infrastructure are being treated as the completion target before the requested manual pilot is demonstrated.

**Classification:** scope expansion requiring confirmation of the relevant user decisions, rather than proof that every later feature was unauthorized. The roadmap references a supplied staged-team comment. Holdout protection, leakage checks, cost checks, and bounded review already existed in the original intent.

**Correction:** make the manual pilot the first acceptance milestone. Treat stronger custody, shadow, monitoring, and changed scientific decision policies as separately scoped capabilities. A manual holdout result need not be called independently custodial evidence; its limitations should constrain that claim without erasing the usefulness of the whole pilot.

### F7 — Medium: stage roles may narrow the requested PM collaboration

Current stages use principal, correctness reviewer, advocate, skeptic, custodian, and director functions. These can implement much of the requested organization, but a single advocate/skeptic stage is not automatically equivalent to implementation PM review, verification PM review, findings analysis, economics review, and cross-PM discussion throughout a project.

**Correction:** map each requested PM responsibility to concrete tasks, communications, first reports, rebuttals, and decisions. Preserve flexible role membership; do not restore obsolete fixed model names or a permanent four-PM count merely because they appeared in the first handoff. The roadmap records later flexibility decisions, and the user has not asked to reverse those.

## 3. What remains aligned and should be retained

- Local UI, routing, durable records, explicit transfers, and recovery.
- Director decisions and bounded tasks assigned through supervising PMs.
- Frozen code/configuration/data identities and checks before expensive fits.
- Independent first reports, shared evidence, bounded rebuttals, and preserved dissent.
- Explicit distinctions between failed execution, invalid evidence, inconclusive results, and valid negative findings.
- Validation of returned archives and truthful provenance. A hash verifies bytes, not the quality or origin of an experiment.
- Controls against accidental duplicate jobs, stale artifacts, and changes to the experiment after reviewing its results.
- The separate developer worktree workflow. Its presence does not make it the research-agent runtime.

Two earlier statements also need qualification: a pre-registered manual Colab return is not automatically exploratory merely because it was imported; S3 specifically calls an unregistered return exploratory. And source-level support for hosted execution does not mean the app has actually run training on that infrastructure.

## 4. Recommended product contract for the canonical revision

| Responsibility | Owner and completion evidence |
| --- | --- |
| Set goals and resolve required external facts | User; recorded project mandate and decisions |
| Design experiments, write code, review correctness, prepare release | Director/PM/workers; exact package, tests, separate reports, recorded approval |
| Run preflight, training, evaluation, and backtesting | User manually in Colab; exported package identity and returned logs/artifacts |
| Wait for execution | Local controller; durable waiting state, no automatic Colab access, no unnecessary calls for that waiting experiment |
| Validate and interpret results | Controller validates transfer metadata; agents perform authorized analysis/checks, PMs submit independent findings and objections |
| Decide next experiment | Director; evidence-linked revise/retire/advance decision within the user's scope |

The provider location of agents' shell and analysis tools must be specified separately. This review establishes manual Colab ownership of the main experiment; it does not silently authorize moving all agent tool execution onto the user's PC or adding paid API routes.

## 5. Concrete acceptance that would demonstrate restored alignment

Use a synthetic returned bundle first to test the application, then a user-run pilot when its inputs are ready:

1. Director and PMs agree on a bounded experiment; workers prepare code and a fixed launcher.
2. Independent correctness review is preserved before package approval.
3. Export a package that binds code, configuration, relevant data identities, checks, environment requirements, and expected outputs.
4. Enter a durable waiting state. Restart the app and recover the same pending handoff without submitting a new execution job.
5. User runs Colab independently and imports the returned files.
6. Reject wrong-package, incomplete, corrupt, and duplicate-conflicting returns with useful explanations. Accept an eligible complete return for the applicable analysis while retaining its user-run provenance.
7. PMs independently assess the same authorized evidence, exchange bounded responses, and submit both positions to the Director.
8. Preserve a valid negative result as a completed useful research cycle. Neither profitability nor a cloud training service is a prerequisite for demonstrating the workflow.

These are review recommendations for revision of the canonical roadmap, not newly issued worker packets.

## 6. Review outcome and verification

**Recommendation:** revise the execution contract and first-release acceptance before further work on hosted training or mandatory custody provisioning. Then assess the affected scheduler, readiness rules, exports/imports, admission policy, UI, and tests against that contract. A prose-only correction will leave current runtime barriers intact.

Read-only commands used: Git status/HEAD/branch/worktree inspection, `git log -S`, `git blame`, targeted `rg`, and PowerShell file reads. Source references were inspected at the commit recorded above. Searches for two guessed filenames found no files; the review instead followed the actual scheduler/pipeline/type locations. No application tests, research workloads, provider sessions, installations, or external writes were performed.

Only this report was created, outside the repository. No product files, roadmap entries, commits, branches, or worktrees were changed. There are no code merge conflicts from this review. The remaining evidence limitation is the unavailable pre-Git decision history; the conflict with the user's current clarified intent is nevertheless directly established.
