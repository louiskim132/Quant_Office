# Quant Research Office — single implementation roadmap

Current status, 2026-09-29: private/internal beta. C11 development is complete (LR-0…LR-11, LR-14, LR-15 and LR-17 merged; L2 closed — `bench-store.ts 1000` opens in about 0.1 s). Open launch gates: LR-16b (isolated agents on the user's subscription, required by D-6; the v1 real acceptance passed on 2026-09-29) and the provider-terms legal review, which a separate reviewer handles outside this project. Deferred under D-3: signing, installer, updates and clean-machine release validation. **Where status lives:** the section 11 tables and the dated log in section 17 (newest last). On 2026-09-28 the superseded opening paragraphs, completed packet texts and log entries before 2026-09-27 moved verbatim to [history/roadmap-archive-2026-09.md](history/roadmap-archive-2026-09.md); section numbers are unchanged.

## 1. Start here: scope, priority and execution rules

Workspace: the authoritative source is `origin/main` of `https://github.com/louiskim132/Quant_Office.git`. `Quant Office/repo` is only the Git anchor that owns the worktrees; its own checkout is stale, so never implement or review there, and never move or rename it. Batch work happens in `Quant Office/repo-sessions/<batch>/{organizer,worker-N,reviewer}`. All other work goes in a new worktree under `Quant Office/Worktrees/`, created from `origin/main`. The installed app is `Quant Office/App/` (the taskbar pin target). The folder map is `Quant Office/README.md`. The version is in `app/package.json`. Check current files, Git state and AGENTS.md before editing. Do not fabricate a branch, commit, test result, cloud receipt or missing configuration.

What exists: a local-first Windows desktop office. Local CLI agents (Claude Code, Codex, Devin) do office work through office-spawned packets whose receipts the office verifies (C9, the communication pipeline and office memory). The research workflow S0–S10 (C1–C8) is implemented and VERIFIED_LOCAL, with the main experiment run manually by the user (section 1.6). Hosted agent dispatch stays blocked on R5 evidence. Launch-readiness slice C11 is complete for development. This paragraph is a summary; the section 11 tables are the status of record.

User decisions: Claude is primary. Existing signed-in profiles need no repeat setup unless the official tool reports a problem. Design ambiguities, including old 10.5/10.6, are delegated and settled here. No approval poll for ordinary local code/document/test-fixture work. External provider challenges/permissions and actual project-specific research inputs may require facts from the user; never invent them to pass a gate.

### 1.1 Boundaries that every implementation must preserve

- The desktop owns UI, records, deterministic policy enforcement, authentication checks, storage, indexing, explicit transfers and recovery. Agents design research, write code, review correctness and interpret results; they do not execute the main experiment. Training, evaluation and backtesting of the approved candidate run in Colab, operated manually by the user, as the normal external run path — not a fallback. No research executes on the local desktop either: “mechanical/no model” does not mean “run research locally.” Synthetic app regression fixtures may run locally.
- Provider access uses the user's own official sign-in or the user's own API key (LR-15, decision D-4). The developer's accounts or keys are never used, embedded or referenced, and the office never falls back silently from one mode to the other. No custom credential client, self-hosted Claude or local research execution. The application never connects to, polls or controls Colab: no browser opener, login, API client, runtime provisioner, notebook editor or access to a live Colab instance, and agents cannot reach it through generic browser/network tools. Manual export of a frozen run package and manual import of its returned files is how the experiment executes; never control that external runtime.
- Three execution concerns stay separate and are never conflated: (a) the main experiment, owned by the user's manual Colab run; (b) agent tool execution — where director/PM/worker sessions run shell and analysis tools — governed by R5 hosted-route evidence, the supported manual handoff, or a labeled local CLI session route (slice C9); (c) local developer worktrees used to build this application, which confer no research-runtime authority.
- The office distinguishes agent identity (provider/model/account), execution environment (local machine versus provider-hosted) and tool profile (what the session may access). An agent's role never dictates its location. Every assignment records where it actually ran; there is no silent fallback between environments.
- Agent office work may run on local CLI agents through their installed signed-in clients, or on hosted sessions once R5 evidence exists. Local-agent evidence is labeled for what it is: scoped workspace delivery is not enforced isolation; session-reported model and effort are self-report unless the tool's own output verifies them; a local process kill is a real cancellation of that session, not a provider acknowledgement. Blinded review, holdout custody and independently verified gates keep their existing requirements; local agents are ineligible for those roles unless enforced isolation is separately verified.
- Evidence tiers are matched to the operation they protect (section 1.6): controller-enforced report separation is the mandatory minimum for the manual pilot; a calculation the frozen spec requires to be independently executed may run inside the user's manual package or a separately provisioned service, labeled by actual provenance; signed harness, isolated hosted runtime and independent custodian attestations are stronger, separately scoped capabilities whose absence blocks the corresponding claim, not the manual workflow. A signature authenticates a configured signer's claim; it does not by itself prove scientific correctness.
- Imported outputs start as USER_IMPORTED/QUARANTINED. Matching hashes prove byte identity, not correct execution, independence, profitable research or provider hosting. A return bound to a registered package keeps its user-run provenance; it is never relabeled independently hosted or custodial evidence, and promotion to stronger claims requires the relevant evidence below.
- The pipeline includes shadow/monitoring artifact contracts and imported evidence, not brokerage integration or real-money order placement. Do not add trading connectors, recurring automation, market-data purchases or capital deployment as implied work.
- Preserve unlimited roster/role membership. Schedule explicit assignments on demand; do not require permanent four-PM teams. Single-agent requests remain single agent, with delegation off unless the user explicitly changes scope.
- State/evidence transitions are main-process/store controlled. Renderer supplies typed IDs, revisions and user intent, never provider receipts, arbitrary shell text, approval facts or trusted observation fields.
- A deterministic gate can fail or lack evidence. Missing/unsupported evidence never equals PASS. No model can override a failed mandatory gate; a legitimate repair appends a new version and reruns affected gates. Pin the independently maintained gate harness outside the candidate's writable scope; candidate code cannot edit its own admission checks, signing material or gate version. A gate-spec defect blocks the branch pending a reviewed prospective correction, never an in-place waiver.
- Preserve old event bytes, user files and historical evidence. Append migrations with backup/replay checks. No automatic external dispatch on restore, relink or migration.

### 1.2 How a coding model should execute this document

1. Read section 1, the current progress row in section 11, and the next incomplete task packet. Use section 1.3 to locate relevant symbols/callers/tests. Read other roadmap sections only when the task depends on them. Verify changed source before trusting old findings; never require a full-roadmap/full-repository reread for every small revision.
2. Track bounded implementation steps within the full authorized deliverable. When the user requests the entire roadmap, continue through all independently actionable remaining work; a completed step is not a reason to stop. Keep unrelated behavior unchanged. Reuse existing modules and libraries; evaluate the specific routing proposal in section 3.1 without installing an unrelated optimizer stack.
3. Implement runtime schema/type changes together, then store/reducer, main service, narrow IPC/preload and UI where needed. Keep old records readable. No renderer authority shortcuts.
4. Add targeted positive and negative regressions described by the work item. Tests must assert behavior, not mirror implementation or replace integration evidence with fabricated production records.
5. Batch the authorized code revisions, then run one consolidated verification pass. Do not rerun tests after each minor edit. Rerun affected checks only for failures or subsequent changes. Run full unit/build/desktop checks before packaging a release. Inspect failures; never weaken gates, skip tests or change every fixture's mode just to obtain green output.
6. Record the result where AGENTS.md says: a dated entry at the end of section 17 and the matching section 11 row — changed files, commands, actual outcomes, migration impact, remaining blockers and the exact next item. Link dated raw logs. Do not maintain a second continuation guide.
7. A blocked provider operation does not block independent fixture implementation. Keep the live feature disabled and record the exact missing capability. End each slice with a concrete status, not an unsupported completion claim.

### 1.3 Code map and navigation

This section is the shared code map; section 11 is current state; sections 1–3 and each work item's rationale are decisions. Do not create separate code-map.md/current-state.md/decisions.md files or copy this roadmap into agent instructions.

Map refreshed 2026-09-28 against `origin/main`. It names where to start reading, not what is safe; Git (HEAD plus staged, unstaged and untracked state) identifies the source you are working on. The hash-prefix tables of 2026-09-08…12, written before the project used Git, are archived. Paths are relative to `app/src`; tests are in `app/tests`.

| Area | Start here | Main tests |
| --- | --- | --- |
| Trusted IPC surface, window, startup | `main/main.ts` (`register`, `buildController`, `dispatch` admission), `main/preload.ts`, `shared/types.ts` (`OfficeAPI`), `main/boot-load.ts`, `main/diagnostics.ts` | `desktop.e2e.ts`, `boot-load`, `diagnostics` |
| Event store, projection, integrity | `core/store.ts` (`OfficeStore`: commands, append-only events, cached projection, LR-17 checkpoint, migrations), `core/canonical.ts`, `core/strict-json.ts` | `core`, `integrity-checkpoint`, `capability-compaction`, `migration`, `store-requests` |
| Assignment lifecycle | `main/controller.ts` (`AssignmentController`: prepare, dispatch, handoff, observe, cancel, reconcile, chain advance), `core/jobs.ts`, `core/guards.ts` | `controller`, `cooperation`, `local-chain`, `handoff` |
| Local agent routes | `main/local-cli-exec.ts` (office-spawned CLI, process-tree kill), `main/local-packet.ts` (packet, contract and prompt text), `main/local-session*.ts` (mailbox, router, guarded file IO), `main/local-worktree-*.ts`, `main/tool-flags.ts`, `main/serena-session.ts`, `main/local-provider-*.ts` | `local-cli-exec`, `local-packet`, `local-session*`, `tool-flags`, `tool-surface`, `process-tree-kill` |
| Agent isolation (LR-16) | `main/agent-isolation.ts`, `main/agent-host.cjs`, `main/agent-isolation-acceptance.ts`, `scripts/agent-isolation/setup-agent-isolation.ps1` | `agent-isolation` |
| Accounts, keys, readiness | `main/subscriptions.ts`, `main/secrets.ts` (DPAPI), `shared/readiness.ts`, `shared/effort.ts` | `subscriptions`, `connections`, `readiness`, `api-keys`, `binding` |
| Communication pipeline | `main/pipeline-runner.ts` (hop minting), `main/round-template.ts`, `main/round-executor.ts`, `main/chain-messages.ts` | `pipeline-mint`, `pipeline-decision`, `pipeline-settle`, `pipeline-scope`, `round-*`, `chain-messages` |
| Research workflow S0–S10 | `main/pipeline.ts` (`PipelineService`), `main/research-controller.ts`, `main/context-policy.ts`, `main/holdout.ts`, `main/run-package.ts`, `main/research-templates.ts`, `core/research-gates.ts`, `core/research-admission.ts`, `core/adjudication.ts`, `core/monitoring.ts`, `core/shadow-ledger.ts`, `shared/research*.ts` | `pipeline`, `research*`, `holdout*`, `shadow*`, `manual-pilot`, `run-package`, `separated-review`, `blinded-review` |
| Evidence and memory | `main/evidence.ts`, `main/evidence-tool.ts`, `main/evidence-dropbox.ts`, `main/memory-ingest.ts`, `shared/evidence.ts` | `evidence*`, `memory*` |
| Files, backup, restore | `main/artifacts.ts`, `main/archive.ts`, `main/recovery.ts`, `main/locations.ts`, `main/outputs.ts`, `core/object-inventory.ts` | `artifacts`, `large-backup`, `recovery`, `locations`, `archive` |
| Contained hosted transport (R1/R5) | `main/pty.ts`, `main/probe.ts`, `main/handoff.ts`, `shared/transport.ts` | `pty`, `probe`, `handoff` |
| Renderer | `renderer/main.tsx` (shell and navigation), `office.tsx`, `agents.tsx`, `pipeline.tsx`/`pipeline-card.tsx`, `research.tsx`, `memory.tsx`, `dispatch.tsx`, `activity.tsx`, `projects.tsx`, `profile.tsx`, `format.ts` | `desktop.e2e.ts` and `*.desktop.ts` |
| Build and tooling | `scripts/build.mjs`, `scripts/package.mjs`, `scripts/bench-store.ts`, `scripts/downgrade-workspace.ts`, repository `tools/desktop.mjs` and `tools/parallel.mjs` | CI `verify.yml`; `tools/*.test.mjs` |

Normal discovery roots: `app/src`, `app/tests` and the specific required scripts. Exclude `app/node_modules`, `release`, `dist`, `.pnpm-store`, datasets, model checkpoints, run archives and old test output from broad search; read a dated log or artifact explicitly when the task requires it. Use targeted search before a full file read. Read the affected implementation, its callers, types, schemas and tests; expand whenever evidence or uncertainty warrants it.

### 1.4 Shared developer context and optional Serena trial (D1)

Scope distinction: this is how Codex/Claude Code developers revise the local desktop application. It is separate from the product's research pipeline and C2 artifact analysis. Local source navigation and synthetic app tests do not authorize local training/backtesting. A navigation plugin is not a research executor or coordinator.

Decisions from the later Token Optimization discussion:

- Keep the desktop workflow and same intended checkout. Changing to a PowerShell window does not share conversations, model understanding or provider caches; the shared material is files, versioned findings and task evidence.
- One writer at a time in a shared checkout; implementation followed by independent review. No simultaneous edits by two clients. Separate worktrees become an option only when a real Git repository exists and parallel work is explicitly authorized; record checkout/revision in each handoff.
- Native targeted search is the baseline. Serena is the first optional navigation trial for repeated symbol/caller reading; it is not needed for R1-A and must not delay safety repairs. Graphify remains an alternative if cross-module relationships, rather than exact symbols, are the bottleneck. Do not install both initially. Section 3.2/C10 separately authorizes planning office-agent trials of all four named tools, one addition at a time followed by measured combinations; D1 is not product tool provisioning.
- When the user proceeds with tool setup, use Serena's supported MCP client interface, verify current primary setup documentation and configure each intended coding client separately against the correct checkout. Start with separate client processes, not an assumed safe shared mutable server. Installation/configuration is not performed by this roadmap update. Do not edit user-wide tool settings as an incidental R1 change.
- No plugin automatically appears in an ordinary web chat. A supported connection and correct tool permissions must be established. Do not promise shared prompt caches, fewer tokens merely from a common directory, or automatic cross-client task dispatch.
- No local LLM/GPU is required for the map/native retrieval baseline. Measure actual indexing CPU/RAM/disk before a navigation rollout; earlier rough resource estimates are not acceptance guarantees.

D1 implementation, only as a separate bounded developer-tooling slice after R1-A or later:

1. Keep this section and section 11 canonical. Add short project-local AGENTS.md and CLAUDE.md pointer instructions only after checking existing/inherited instructions; preserve them. Each pointer tells the client to read section 1, current item and relevant map entries, verify freshness, inspect needed symbols/callers/tests, and update only affected entries. Do not paste the whole roadmap, add conflicting provider policy or introduce another status document.
2. Before configuring a tool, confirm its capabilities are callable in each intended client and scope access to the development checkout. Record actual tool/version/client configuration and how to remove it; no hardcoded unverified install commands here.
3. Compare native search with one semantic-navigation tool on the same bounded code-change fixture: locate symbol, relevant callers/schema and tests; refresh after editing/renaming; show omitted/generated paths do not hide required code. A stale index must trigger refresh/fallback, never stale edits.
4. Record source/tool-output volume, observed model input/output usage where available, duplicate retrieval, latency, local resources and correctness. Do not estimate total token savings from director-only counters. Retain raw source expansion and fallback to rg; no fixed reading cap.
5. Keep the tool only if evidence supports its usefulness without missed dependencies, stale writes or unsupported access. Otherwise remove the trial configuration and retain the native map/search workflow. Do not create a custom cross-client orchestrator for this trial.

Acceptance: both clients locate the same current symbol/callers on the same source version; edits invalidate index/map entries; generated data is excluded by default yet explicitly accessible when relevant; all task regressions remain valid; sequential writing enforced by task ownership. D1 is developer convenience, not a condition for R2–R5 or product cloud readiness.

### 1.5 Parallel coding and packet workflows (D2)

This is developer coordination for changing this application. It does not enable the application's R5 research transport. The text this section held until 2026-09-28 is archived.

**Who owns what.** The organizer owns shared types (`app/src/shared/`), `core/store.ts`, `main/main.ts`, `main/preload.ts`, dependencies and lockfiles, CI, agent instructions and this roadmap. In a desktop batch the organizer is Session 8; otherwise it is the session the user names. Workers own only the files their packet names. An interface change that other work depends on lands first, and dependent work starts from the commit that contains it. Workers propose roadmap changes in their PR body; only the organizer writes this file.

Two workflows are supported. Pick by the shape of the work.

| Workflow | Use it when | Base and merge path |
| --- | --- | --- |
| Desktop batch (Sessions 1–9) | Up to seven parallel packets from one frozen base, all on this machine, coordinated through the local mailbox | `tools/desktop.mjs` publishes every slot from the organizer's clean `HEAD`; accepted worker commits merge into the organizer branch; one integration PR goes to `main` after the round closes. Operating manual: [DESKTOP-SESSIONS.md](DESKTOP-SESSIONS.md). |
| Packet waves (one PR per packet) | Pre-written packets with dependencies, including hosted coding agents that cannot see local folders (the C11 model) | Each packet branches from current `origin/main` in its own worktree or clone and opens its own PR to `main`. Packets whose dependencies are merged and whose files do not overlap may run at the same time as one wave; the organizer re-checks each later packet's anchors after a wave merges. The packet rules and starting prompt are C11.0 and C11.K in section 10. |

**Merge gate, for both workflows.** The organizer reviews the exact head SHA against the packet's acceptance text. Before merging, `origin/main` must be an ancestor of that head, the required `verify` check must have passed on that same head, and required conversations must be resolved. Merge only through the GitHub PR. Never push to `main`, never force-push, and never ask for or expose a raw token; if authenticated PR access is missing, report the PR URL and the blocker. Worker agents never merge.

**Worker environment.** Each checkout installs its own locked dependencies (`pnpm install --frozen-lockfile` in `app`, Node 24.19.0). Never share a writable `node_modules`, never use production app data, and never run two writers in one checkout. A hosted agent (for example Devin) works in a fresh clone at the packet's base commit; a local Windows path means nothing on a hosted machine, and no provider sign-in, repository grant or model choice can be inferred from a successful local push.

**Helpers.** `tools/parallel.mjs` (`init`, `assign`, `check`, `status`) creates a batch of worktrees under `<repo>-sessions/<batch>` and checks a worker commit's ancestry, whitespace and file scope. `tools/desktop.mjs` builds the fixed eight-session batch on it. Scope checks never certify behavior or tests; the organizer still reviews and runs the checks.

Organizer kickoff prompt for a batch: "Read AGENTS.md and ROADMAP sections 1, 1.5 and 11. Organize the requested change into up to seven bounded packets from one frozen base. Define shared interfaces first, give workers disjoint file/test ownership, record dependencies and acceptance, then review their exact commits and test the combined result in your organizer checkout. Close the round, push one integration PR, verify its exact head contains current origin/main and has a successful required verify check, then merge it through GitHub if authenticated PR access is available. Never push directly to main or request a raw token. Do not claim workers were launched without actual session IDs."

Primary references: [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [Devin GitHub connection](https://docs.devin.ai/integrations/gh), [Devin AGENTS.md](https://docs.devin.ai/onboard-devin/agents-md), [Devin environment setup](https://docs.devin.ai/onboard-devin/environment).

### 1.6 Execution ownership contract and first-release milestone — corrected 2026-09-14

The independent alignment review in `records/reviews/roadmap-alignment-2026-09-14.md` found that this roadmap had drifted from the checked-in handoff (`reference/handoff-v1.0.txt`) and workflow (`docs/workflow.md`): the main experiment had been reassigned from the user to a mandatory hosted executor, and provisioned trust infrastructure had become a prerequisite for the user's basic workflow. This subsection is the controlling execution contract. Wherever earlier sections imply that hosted training execution, a signed research runtime or a provisioned custodian is required before the user's manual workflow can complete, this subsection supersedes them. The original intent: Director, PMs and workers handle coding, direction, cross-PM conversation and quality checks; Colab, manually operated by the user, executes ML training/evaluation and profitability backtesting.

| Responsibility | Owner and completion evidence |
| --- | --- |
| Set goals and resolve required external facts | User; recorded project mandate and decisions |
| Design experiments, write code, review correctness, prepare release | Director/PM/workers; exact package, tests, separate reports, recorded approval |
| Run preflight, training, evaluation and backtesting | User manually in Colab; exported package identity and returned logs/artifacts |
| Wait for execution | Local controller; durable waiting state, no automatic Colab access, no calls made on the waiting experiment's behalf |
| Validate and interpret results | Controller validates transfer metadata and returned-byte integrity; agents perform authorized analysis/checks; PMs submit independent findings and objections |
| Decide next experiment | Director; evidence-linked revise/retire/advance decision within the user's scope |

PM responsibility mapping (required by slice C8): each requested PM duty — implementation review, verification review, findings analysis, economics review and cross-PM discussion — maps to concrete tasks, communications, independent first reports, bounded rebuttals and decisions. Flexible role membership is preserved; do not restore obsolete fixed model names or a permanent four-PM count merely because they appeared in the first handoff.

First-release milestone: the manual pilot defined in slice C8 — a complete export → user-run → bound import → independent-review → director-decision cycle on a small bounded experiment — precedes any hosted training, mandatory custody, shadow or monitoring work. Those remain separately scoped capabilities, not deletion targets.

## 2. Evaluation of the proposed research architecture

Adopt the comment's core: stage-based orchestration, preregistration/prediction, deterministic enforcement, performance-blinded correctness, and bounded adversarial analysis. Do not adopt its absolutes or named-model assignments as technical facts.

| Proposal | Decision | Exact rule for this application |
| --- | --- | --- |
| Move deterministic work out of models | Adopt | Scripts calculate metrics and enforce versioned gates. Models select justified methods, inspect assumptions and interpret evidence; research scripts execute inside the user-run package or a separately authorized hosted executor, never on the desktop (section 1.6). |
| Freeze costs as arithmetic | Adopt with correction | Freeze calculation code, inputs, calibration provenance and stress scenarios per branch. Arithmetic validity is mechanical; spread/impact/borrow realism requires independent assessment. A fixed wrong assumption stays wrong. |
| Director predicts before running | Adopt | Store sign, expected range, probability for a named outcome and falsifiers before candidate evaluation. Record existing knowledge; a retrospective prediction is labeled retrospective. Compare predictions to outcomes without exposing them to blinded reviewers. |
| Sequential stages replace simultaneous roles | Adopt | One state machine advances per branch; bounded workers can execute independent authorized subtasks. Advocate/skeptic first reports are isolated and can run independently inside one review stage; no permanent simultaneous role swarm. |
| Force advocate/skeptic opposite conclusions | Modify | Give opposite investigative mandates, not predetermined verdicts. Both may conclude evidence is insufficient or negative. Advocate must provide falsifiers; skeptic lists up to three concrete mechanisms with tests, and states when fewer are supported. No invented objections. |
| Correctness sees only diffs/data flow | Modify | Provide source, full relevant dependencies, schema/timing/split contracts, synthetic examples and deterministic check receipts. Exclude candidate performance, flattering run names and director prediction. Diffs alone are insufficient. |
| Different model families prove independence | Reject as proof | Prefer separately assigned contexts/families when verified and available, but enforce input isolation, separate receipts and sealed first reports. Distinct labels or models alone do not prove independence. |
| Hardcode Astra/Sol/Opus/Terra/Sonnet/Luna | Do not adopt | Map stage functions to existing eligible profiles using verified exact model/effort capabilities. Claude remains primary. No inference that the comment's named models are available through hosted subscription routes. |
| AUC/MAE nearly meaningless | Reject blanket claim | Keep task-appropriate prediction loss/calibration plus economic signal/portfolio metrics. No single metric establishes investability. Rank IC needs sufficient cross-sectional observations; unsupported metrics are NOT_APPLICABLE with a preregistered reason. |
| Unstable feature ranks prove no signal | Reject | Flag for investigation. Redundant/correlated features can share importance; examine grouped importance, prediction stability and ablations. Declare the importance method and evaluation population. |
| Purged/embargoed CV, walk-forward only | Refine | Use chronological outer evaluation and explicit label-interval purging. Gap/embargo duration depends on availability/label spans and which training observations are eligible; a fixed row gap is not a universal leakage solution. |
| Failing 1.5× slippage means no edge | Refine | Include 1.0×/1.5×/2.0× variable-cost stress by default as diagnostics. Freeze the actual economic acceptance rule before viewing results. Sensitivity is evidence about fragility, not a universal economic law. |
| Holdout quota is the only multiple-testing defense | Reject | Use preregistration, all-trial ledger, nested selection, untouched final data, dependence-aware uncertainty and justified multiplicity adjustment. A quota is an operational brake, not a statistical guarantee. |
| One decisive follow-up | Adopt with termination | Maximum one scientific follow-up per candidate lineage at S7. If unresolved afterward, mark INCONCLUSIVE/RETIRE; never force promotion. Corrections are separate logged repairs, and new branches do not reset family trial/exposure counts. |
| Shadow trading verifies realized slippage | Correct | Shadow/paper measures operational feasibility and simulated costs. Actual fills/impact need separately sourced real execution evidence; do not call simulated slippage realized trading costs. |
| Director discretion only at two stages | Refine | Director proposes S0 and adjudicates S7; policy controls advancement elsewhere. Anyone may raise evidence/stop requests. Repairs, retirements and emergency suspensions are logged; uncertainty cannot be forced through. |

Technical support: [TimeSeriesSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html) provides time-ordered splits and a gap parameter, not a complete financial leakage contract. [CatBoost importance documentation](https://catboost.ai/docs/en/concepts/fstr) defines different importance calculations; ranks require interpretation. [Bailey and López de Prado's Deflated Sharpe Ratio paper](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) addresses selection bias/multiple trials and non-normal returns; record its assumptions rather than treating it as a universal pass certificate. [Alpaca paper-trading documentation](https://docs.alpaca.markets/us/docs/paper-trading) explicitly lists simulation omissions including market impact and latency slippage. These sources support the corrections, not a recommendation to install or connect their products.

## 3. Evaluation and adoption of the token-optimization report

Adopt evidence-preserving on-demand context, not the report's numeric idea scores as measured savings. Full artifacts stay outside prompts; models receive focused evidence plus an authorized expansion route. The source report is C:/Users/louis/Desktop/Codex/token-optimization-revision-report.md; all actionable decisions are incorporated here, so a future assistant need not read it to execute the roadmap.

Decisions:

- Start with the existing native artifact/store/query infrastructure. Add a single output storage/retrieval layer after correctness repairs. No mandatory MCP dependency.
- Programmatic diagnostics operate on complete authorized results, return evidence references and coverage, and execute inside the user-run package or through an authorized agent route — never silently on the desktop (section 1.6). Never let a cheaper summarizer be the only path to evidence.
- Use both decision-focused analysis and discovery diagnostics: missing/failed runs, tails, segments, time instability, negative controls and varied samples. Preserve counterevidence and unknowns.
- Cache deterministic query results by all semantic dependencies; cache model interpretations separately and never inherit review approval automatically. Reviewer blinding rules also apply to caches/search/indexes.
- Treat context length targets as soft. Spill to referenced appendices with omission counts; an agent may expand necessary evidence. Never reduce required reasoning/review solely to meet a token target.
- Adopt short reuse-first coding guidance. Trial one navigation tool only after measured need: semantic symbols or dependency graph, not both initially. Graph inferred edges remain labeled inferred; absence of a match is not absence of a dependency.
- For the product team, defer RTK-like command filtering, Context Mode installation and Headroom proxies until a baseline shows a bottleneck. The user reopened model routing on 2026-09-11: evaluate OmniRoute through the bounded proposal in section 3.1. The separate developer Serena trial in section 1.4 responds to repeated source navigation and does not install tooling inside hosted research jobs. If tested, retain raw output, exit status/errors and exactly one responsible filter per output type. Tool compatibility is unverified until exercised through the exact intended route.
- Prompt prefix caching is optional provider behavior, not logical context reduction. Enable only where supported through existing subscription tooling; never introduce a paid API to obtain it.
- Cheaper workers are optional for bounded verifiable extraction. They cannot approve research or replace blinded correctness/skeptic work. Measure full-team tokens including failed attempts/retrieval/indexing/review; unknown usage is UNKNOWN, not zero. Do not equate token totals with subscription quota or promise a percentage saving.

The [Anthropic code-execution pattern](https://www.anthropic.com/engineering/code-execution-with-mcp) supports filtering intermediate data before returning it to the model. This application still needs verified remote retrieval and isolation; a local artifact path alone is not usable by a hosted agent.

### 3.1 OmniRoute review — proposed task routing contract, 2026-09-11

Recommendation: use an optional OmniRoute adapter for bounded model calls, with the office retaining task scope, evidence grants, stage scheduling, review isolation and scientific gates. Multiple agents do not require different providers or broadcasting the same context to every model. Choose the work first, build the permitted evidence packet, then select an eligible route.

The current coupling is concrete: `shared/types.ts` limits `Provider` to openai/claude and models execution as hosted setup; `main/research-controller.ts:scheduleStage` selects named function profiles; `main/controller.ts:prepare/launchGuard` freezes one account and session adapter; `shared/readiness.ts:providerReadiness` requires the full cloud lifecycle for automatic start. Preserve that guard for hosted sessions. Add operation-specific readiness for a separate text-only interface instead of weakening the existing guard to admit inference gateways.

| Work | Preferred mechanism | Required result and boundary |
| --- | --- | --- |
| File inventory, exact search, hashing, schema checks, evidence pagination | Existing deterministic desktop services | Complete authorized results, coverage and exact references; no model needed. |
| Semantic extraction, document classification, short source-grounded summaries | Text-only model call through an explicitly eligible free provider/model pool | Structured output, source references, missing/uncertain fields and validation; tools disabled. Initial fixture uses public or synthetic content. Cheap output cannot be the only route to raw evidence. |
| Research design, ambiguous interpretation, correctness review, advocate/skeptic reports | Pinned capable profile, Claude primary where supported | Role-scoped context, separate first reports, explicit model/effort and stage receipts. Cost routing cannot silently downgrade a mandatory reviewer. |
| Data transformations used in research, diagnostics, training, backtests and final holdout evaluation | The user-run package is the default route (section 1.6); a verified hosted executor or separate custodian is a separately scoped option | Frozen code/input/gate identities, execution receipts and verified outputs. Even deterministic research processing stays off the desktop, and its provenance is labeled by the route that ran it. |

Separate three capabilities in the application contract:

1. `ModelGateway`: bounded text/JSON request and response, with eligible models, context/output limits, data policy, quota and usage evidence. No desktop filesystem, shell, recursive delegation or arbitrary tool execution exposed to these workers.
2. `AgentSession`: a tool-using task with its own verified environment, input transfer, submit/observe/cancel/reconcile/output lifecycle and isolated context. Continue using direct official adapters where necessary.
3. `ResearchExecutor`: execution of pinned research code against authorized data, with deterministic gate verification and separate holdout custody. A remote inference response alone does not establish where tool calls ran.

Under the corrected execution contract (section 1.6) the user's manual Colab run is the default executor for the main experiment. A provisioned `ResearchExecutor` and custodian remain separately scoped options for stronger evidence claims; they are not prerequisites for the manual pilot and their absence must not read as one indivisible blocker.

Do not identify the gateway as the model provider. Represent the transport, upstream provider/account, actual model/version, auth method and execution capability separately, while preserving existing profile identities and frozen assignments during migration. OmniRoute's [upstream documentation](https://github.com/diegosouzapw/OmniRoute) describes a compatible inference endpoint and routing/fallback strategies. Its [architecture documentation](https://github.com/diegosouzapw/OmniRoute/blob/main/docs/architecture/ARCHITECTURE.md) also describes Cloud Agents adapters for hosted platforms; those are candidates for `AgentSession` adapters, not proof they meet this project's output, reconciliation, confinement or custody contracts. No OmniRoute installation or runtime compatibility test was performed for this review.

The proposed narrow change to section 1.1's subscription-only rule is: retain supported official subscription routes for those workflows, and additionally permit explicitly configured, documented free inference APIs for bounded workers. Continue prohibiting paid fallback and unsupported credential reuse. This is a proposed policy extension; the current runtime policy remains in force. A gateway's OAuth or cookie support is not proof of authorized subscription access. Anthropic's [authentication guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) distinguishes native subscription use from third-party access and possible usage-credit charges; keep Claude on a supported route rather than assuming subscription capacity transfers to a proxy.

Routing policy, enforced before any transmission and on every fallback:

- Filter by operation, allowed data recipients, account/auth validity, required model capabilities, reviewer isolation and cost class before optimizing quota or latency. The model may suggest task difficulty; trusted policy defines admissibility and maximum scope. Failure to find an eligible route queues or blocks with a reason.
- Use named provider/model allowlists. For a free-only pool disable paid fallback and remove billable connections from its eligible set; unknown price/quota and exhausted trial credits are not free capacity. OmniRoute's [budget controls](https://github.com/diegosouzapw/OmniRoute/blob/main/docs/routing/AUTO-COMBO.md) document an over-budget `cheapest` default fallback and a `strict` refusal option. Select strict behavior where applicable and test it. Its budget header accepts a positive value, so `budget=0` is not a documented free-only control; catalog cost estimates are not a billing guarantee.
- Build the authorized packet before routing. A failed provider already received that packet: every potential fallback recipient must be eligible for those bytes. Default unclassified project material to no free-provider transfer. Free service data terms vary: Google's [Gemini API terms](https://ai.google.dev/gemini-api/terms) describe product-improvement use and possible human review for unpaid service content, with account/region exceptions. Do not infer data permission from a zero price.
- Keep reviewer reports isolated through retrieval, caches and gateway state. Disable shared conversational memory, semantic response caches, context relay, fusion and automatic prompt compression for blinded reviews and exact code/gate evidence unless isolation and fidelity are separately proven. Do not let a router's panel judge replace the office's sealed-report/adjudication process.
- Persist task/attempt IDs, branch/spec/context identities, route-policy version, requested and reported actual upstream/model/effort, provider receipts, input/output hashes, validation, fallback reasons and observed usage. Mark unavailable identity or usage UNKNOWN. A changed reviewer model is a new review attempt; an indeterminate hosted submission must reconcile before retry or failover.
- Preserve full evidence and bounded expansion. Validate schemas, cited spans, coverage, counterevidence and contradictions. Mechanical checks alone cannot certify semantic completeness; failed or ambiguous extraction returns to the capable profile with the original references and an explicit bounded retry/escalation allowance.

Integration sequence inside the remaining roadmap:

1. C4: introduce the three capability contracts and an immutable routing-policy snapshot on each task. Keep stage-to-request linkage explicit and store controlled. The earlier linkage ambiguity is delegated implementation work, not a pending user design decision. Do not add provider-specific dispatch branches to the stage scheduler.
2. C2/C4: finish durable scoped evidence grants, cache identities and blinded packet enforcement before any routed worker can receive project content. Add one optional OmniRoute inference adapter; direct official session routes remain available. Pin and record the reviewed gateway version/configuration and scope credentials to the gateway instead of copying secrets into artifacts or prompts.
3. C7: use one public/synthetic extraction fixture across deterministic-only, current capable-model and free-worker-plus-validation paths. Freeze the expected facts, required counterevidence and failure/escalation limits before seeing results. Measure correctness, missed evidence, retries, latency, actual total usage and reviewer overhead; unavailable metrics remain UNKNOWN. The target is lower cost/quota per validated successful task, not a claimed token percentage.
4. Batch implementation and then run consolidated verification as requested. Include wrong recipient/model, unknown price, exhausted free quota, forbidden paid fallback, timeout/retry ambiguity, stale policy, invalid JSON, omitted evidence, cross-review cache leakage, restart/replay and unchanged hosted gates. A gateway outage leaves direct routes and queued work recoverable. Enable only the operation/provider scopes supported by observed evidence; do not mark R5 or holdout custody verified from an inference test.

This proposal changes the design sequence, not the current completion status. C4 linkage, C5 custody integration, C6 persistence/panels, C7 scale/recovery/release validation and the R5 external evidence remain required.

### 3.2 Four-plugin office evaluation and synthetic task — 2026-09-16

User objective: reduce total agent tokens with minimal quality influence. Evaluate **Serena, Ponytail, Graphify and LightRAG** against the same bounded tasks. These are complementary candidates, not four mandatory layers on every call. This section is the canonical plan; fixture instructions and the evaluator below are test assets, not another roadmap. Scope of this revision: create the fixture and implementation packets. No plugin installation, agent run, provider call, paid API, real market data or research computation is performed or implicitly enabled.

#### Current source and integration point

Inspected at fetched main `6d27652846d18f8c8b7c5d588bc3a2923b154f4b`: `shared/types.ts` already has `ExecutionEnvironment`, `ToolProfile` (`STANDARD`, `CODE_NAV`) and Devin; `renderer/agents.tsx` already exposes execution and tool-profile preferences. These preferences express intent, not installed tools. `main/local-session.ts` implements the Devin local mailbox; automatic local CLI/ACP transports and local Claude/Codex adapters are still unimplemented per C9. `main/evidence.ts` provides grant-scoped literal search, paged exact reads, hashes, caches and omission reporting. D1 has no installed Serena integration. Preserve this work; do not rebuild C9 or mistake CODE_NAV for verified Serena readiness.

#### Candidate responsibilities

| Candidate | Intended office task | Integration and quality requirement |
| --- | --- | --- |
| Serena | Locate code symbols, callers and affected implementation/tests | Install a pinned runtime/language servers per execution environment; bind a separate process to each active session's exact workspace. Use read-only tools for review; project selection is not filesystem isolation. Verify tool calls on actual clients. |
| Ponytail | Avoid unnecessary implementation on code-writing assignments | Pinned task-scoped rules/skill, not a second retrieval server by default. Preserve required validation, scientific checks, error handling and evidence. Do not impose coding brevity on analyst/reviewer findings. Count repeated rule injection. |
| Graphify | Explore cross-file and cross-document relationships | Derived graph over permitted source versions; return source locators and retain EXTRACTED/INFERRED distinctions. Keep raw expansion. Charge semantic document extraction, indexing and refresh to the run. Do not require its use for every exact lookup. |
| LightRAG | Retrieve connected evidence from document collections | Optional backend behind the office evidence interface, preferably context-only results for the existing agent. Pin extraction/embedding/reranking settings; account for all model calls. Do not silently introduce paid inference, unsupported subscription reuse or a new local model service. Unsupported routes are BLOCKED_EXTERNAL, not zero-cost runs. |

Primary references checked 2026-09-16: [Serena runtime/project setup](https://oraios.github.io/serena/02-usage/020_running.html), [Ponytail and its benchmark limitations](https://github.com/DietrichGebert/ponytail), [Graphify](https://github.com/Graphify-Labs/graphify), [LightRAG](https://github.com/HKUDS/LightRAG). Reverify exact versions and interfaces at implementation; popularity and upstream benchmark percentages are not office measurements.

#### Example task: synthetic feature-availability review

Runnable assets: [agent task](../app/benchmarks/plugin-evaluation/task/TASK.md), [evaluator instructions](../app/benchmarks/plugin-evaluation/EVALUATOR.md), [grader](../app/benchmarks/plugin-evaluation/verify.mjs). Eight invented metadata rows, three small JavaScript modules and seven short documents; Node built-ins only. No OHLCV, full/actual chart data, download, training, financial calculation or backtest. This is a synthetic software/retrieval fixture under section 1.1.

- **Track A (code + evidence):** repair a metadata-admission function under the current availability-time contract; follow source/caller relationships; report affected synthetic experiments and contradictory evidence with citations. The starter intentionally mishandles publication delay, feature/target distinction, failed inputs, malformed/missing timestamps, timezone equality and chronology. Acceptance is the full public contract, not reproducing visible ids.
- **Track B (documents):** answer the same three evidence questions using the same documents, without code changes. Trace a feature through its upstream publication source to an affected experiment; retain an omitted failed run and reject an unsupported profitability claim. This provides an appropriate LightRAG/Graphify comparison rather than ranking a document engine on code editing.
- **Freshness phase:** the evaluator makes the same documented Beacon-source correction in every arm and asks which conclusion changes. Require the new source, not cached old conclusions. Measure refresh and follow-up separately.
- Ship only `task/` to participants. Keep the evaluator, expected answers, other attempts and transcripts outside all participant tools, indexes and filesystem access. A fresh chat/working directory alone is not isolation. Record violations and invalidate contaminated runs.

From `app`, `node benchmarks/plugin-evaluation/verify.mjs --self-check` checks the fixture; `node benchmarks/plugin-evaluation/task/src/preview.mjs` displays the intentionally incomplete starter. The evaluator grades a completed copy using `node benchmarks/plugin-evaluation/verify.mjs <absolute-task-copy>`. Candidate JavaScript executes only in a disposable, no-secret/no-network evaluator environment. Code grading never substitutes for report review.

#### Comparison protocol and bounded run budget

Baseline means **existing tools and targeted retrieval without the four additions**, not an agent deprived of normal search/read/edit tools. Keep the source snapshot, allowed input bytes, exact task prompt, provider, model, effort, client/runtime version, permissions and stopping rules fixed within a comparison. Only the declared tool/rules change. Do not compare different models as plugin effects. Complete initial screening on one actually available official client; verify other clients separately before enabling them. A manual isolated fixture run can precede C9 automation but does not verify office dispatch.

| Track | Initial arms | Follow-up |
| --- | --- | --- |
| A | A0 baseline; AS baseline + Serena; AP baseline + Ponytail; AG baseline + Graphify | Test at most two combinations selected from individually useful additions; compare against baseline and strongest single arm. No default all-tools arm. |
| B | B0 baseline; BG baseline + Graphify; BL baseline + LightRAG where its configured route is permitted | Compare successful backends; do not stack Graphify and LightRAG without a distinct demonstrated need. |

Time-efficient screening: one fresh attempt per eligible arm, at most seven initial attempts; 10-minute task timebox per attempt, no silent reset or retry. Setup/indexing is outside the task timebox but separately timed, charged and subject to a preregistered setup limit. Freeze limits before the first run, report timeouts as failures. These are evaluation budgets only, never production evidence-reading caps. Confirm only promising arms: expand each finalist and its matching baseline to three fresh attempts with rotated/randomized arm order, plus at most two A combinations (three attempts each). Report the small sample; it cannot establish statistical non-inferiority or justify broad rollout. No provider benchmark is run by this planning change.

Cold and reuse costs are separate: first use includes extraction/index construction; repeat use may reuse only an index built from the same initial source snapshot, never answers, edits, session memory or evaluator material from another attempt. Record provider-cache observations rather than assuming a fresh chat has a cold cache. Refresh work belongs to the freshness phase. This tiny fixture may show no graph benefit; do not conclude graphs never help. If justified, a later preregistered medium synthetic corpus can test scale without real market data.

Record per attempt: configuration/version hashes, task/corpus hashes, actual tools invoked, session/route/model/effort evidence, start/end, correctness, all six evidence findings, cited-source accuracy, omissions, retries, human interventions, tool bytes, peak resources where observable, index build/refresh time, agent input/output/reasoning/cache counters where available and every helper model's usage. Missing counters are UNKNOWN, never zero. Avoid double-counting provider totals and cached categories. Report raw categories and documented accounting conventions; tokens are not subscription allowance or money. Exclude download bytes from model-token counts but include installation/setup wall time.

Quality gate: all 16 code cases on A, all six evidence findings on A/B, no critical omission/invented result/unsupported citation, and correct freshness response. A configuration that misses a gate is not promoted for smaller output. Review report quality blind to tool identity. Compare total observed usage across all attempts (including failures) per successful task, plus paired medians/ranges and cold/reuse break-even; zero successful tasks have no finite efficiency score. If savings are within observed variation or counters are missing, report INCONCLUSIVE. Keep existing retrieval available regardless of the outcome. Passing this synthetic task proves neither research correctness nor production-scale quality.

#### Add Agent and session lifecycle

Extend C9's existing profile preference rather than adding four unrelated global installers. Maintain an environment tool registry (reviewed version, install location, language dependencies, health, client compatibility) and a versioned tool-policy selection. At assignment preparation freeze tool versions/configuration, allowed source hashes and grants with the existing scope. At launch: resolve the chosen environment, prepare the isolated workspace, generate client-specific configuration, start only needed tools, verify a real project-scoped query, record readiness, and shut down session processes on completion/cancel. A mailbox session needs an acknowledged bootstrap/tool check; writing configuration files alone is not observation.

Separate **installed**, **requested**, **ready for this assignment**, **failed/unavailable** and **disabled**. Do not install/reconfigure tools merely by adding a roster member, restoring a workspace, or changing a model. Unsupported hosts retain an actionable status. Required tool failures block that assignment; optional tools can fall back to native retrieval only when the recorded policy explicitly permits it, and benchmark fallback attempts count as degraded, not successful plugin arms. No global client configuration overwrites, arbitrary renderer-supplied commands or automatic update-to-latest behavior.

Permissions precede graph/index/cache access. Isolate incompatible review scopes at ingestion as well as retrieval; do not create global summaries/embeddings that reveal forbidden evidence through permitted results. Keep indexes derived and rebuildable; source changes and permission revocation invalidate applicable entries. Shared runtime binaries are acceptable; initially use separate mutable indexes/processes for incompatible sessions. Serena project paths, worktrees and plugin settings do not prove OS isolation. Preserve section 1.1/C9 eligibility rules and the manual Colab experiment path.

## 4. Current implementation and settled baseline contracts

The foundation table that stood here (2026-09-08) is archived; current status is the section 11 tables. Paths are relative to `app/src`; tests are in `app/tests`. Old PM_A/B/C/D roles and legacy stages remain readable for historical replay. New stage functions are assignment metadata, not destructive renaming of saved profiles.

Settled contracts retained from earlier decisions:

1. New profiles Confirm after a fresh official exact provider/account/context check, with atomic observation+binding+agent creation. Old profiles remain unbound until explicit Verify; explicit Change creates a revision. Background refresh never rebinds; archived profiles are read-only. No invented multi-account isolation for a single active native context.
2. ProjectLocation separates optional local root, exact relative input allowlist, output root, inert legacy cloudWorkspace note and requested managed provider target. InputSnapshot is immutable and separately references actual observed remote environment. No automatic whole-repository upload/history/hooks/config.
3. Empty local root is valid for generated/text-only requests. First selection ceiling: 64 MiB of copied selected bytes plus actual transport limit; first implementation refuses network roots and symlink/junction/reparse traversal. Spaces/Unicode supported. Managed versioned outputs by default.
4. Metadata UI stale default: 5 minutes; capability eligibility expiry: 24 hours or relevant change. These are app policies, not provider guarantees. Every external launch additionally requires fresh durable identity validation.
5. Persist intent before an external call; ambiguity is UNKNOWN; do not retry without reconciliation. Terminal exit is not remote completion/cancellation. User-pasted session links are USER_REPORTED and cannot promote capabilities or scientific approval.
6. The office is a view of canonical workflow state. One root request, with multiple explicit jobs when authorized. Reviews/supersession/worker failure must not accidentally cancel or complete unrelated work.
7. The manual external run is the first-class experiment path (section 1.6): the office exports a frozen run package, holds durable user-wait states across restart and restore, and validates package-bound returns with user-run provenance retained. Agent tool execution is a separate contract governed by R5 route evidence or the supported manual handoff; developer worktrees are local development only.

## 5. Immediate repairs R0–R7

R0–R4, R6 and R7 are complete and VERIFIED_LOCAL (section 11). Their packet texts and the 2026-09-08 review notes are archived. R5 — the hosted single-agent path — is still BLOCKED_EXTERNAL, so its requirements stay here.

### 5.3. R5 — what the user needs to supply, and what the implementer must verify

Claude remains primary. Adding a Claude agent is an application profile; it does not prove every hosted operation works. Existing subscription sign-in should be reused. No API keys, passwords, tokens, cookie exports, cloud-workspace purchase or new research dataset are requested.

User assistance is conditional:

1. Make the existing official Claude interface available on the machine used for verification. If its CLI is already signed in, use that context; no repeat sign-in. If the chosen official browser/tool explicitly presents a sign-in, consent or subscription challenge, the user completes that interactive step themselves. Browser and CLI sign-in may be separate; do not transfer credentials between them.
2. Reconcile the already-created session session_01Aj1hpgmeoZLdgYVR9eQ6PB, linked in section 13, before creating another probe. If the assistant cannot access its official interface, the user can open it and report its terminal status and export proof.json/visible event evidence if present. User reports/imports stay USER_REPORTED or quarantined: they help reconcile but do not automatically verify provider capabilities.
3. Permit the specific tool operation through the normal approval mechanism when it is available. The usage-limit rejection applies to that mechanism; signing in again or installing another agent does not cure it. There is no request to buy credits. A pending/rejected action is never treated as executed or as permission for a workaround.
4. After the old session has a recorded disposition and supported routes are established, a tiny synthetic fixture may test remaining operations under the task's authorized scope. If an additional live run or cancellation needs interactive provider approval, show the exact action/fixture/session before that step. Never cancel user research or use real research data to test transport.

Implementer sequence and evidence requirements:

| Step | Required record / pass condition | If unavailable |
| --- | --- | --- |
| Inspect current official tool and documentation | Exact CLI version, supported hosted entry/attach/observe/output/cancel routes and current account/context; inspect help before reusing historical command syntax. Use primary provider documentation. | Record unsupported capability. Do not invent a flag or substitute local/API execution. |
| Reconcile existing session | Official ID and observed outcome, visible events and proof bytes where available; durable reconciliation tied to the historical attempt. | Leave its outcome unknown and forbid another probe. User testimony is separately labeled. |
| Freeze one permitted fixture | Real one-commit staged inventory, actual byte hashes, selected model/effort/delegation/tool/environment policy and durable attempt before any provider call. | No dispatch if the required scope cannot be enforced/verified. |
| Observe and retrieve | Real receipt, provider-reported events/outcome; download actual output bytes through a supported route into OutputService and verify hashes; report failures honestly. | Handoff remains partial and automatic start disabled. |
| Verify settings and isolation | Applied model/effort, Anthropic-managed hosting, selected-input-only transfer and separately verified delegation/confinement evidence for the exact route/account/tool version. | Requested text or an agent profile is not proof; keep missing controls blocked. |
| Restart and cancellation | Restart reconciles the same external ID without duplicate submission; suitable synthetic work receives provider cancellation acknowledgement. Local terminal exit is insufficient. | Keep operation-level evidence missing/unsupported. |
| Packaged native transport | Real PTY startup/cleanup under packaged Electron; missing/incompatible module failure tested without research. | Do not infer this from Node PTY success or a development build. |

R5 is complete only when its full required route scope is verified. The official product may not expose all required controls; in that case retain the supported partial handoff and a truthful blocker. The user is not responsible for creating capabilities the provider does not offer. Local C1–C7 fixtures may continue while this gate is open.

Scope (2026-09-14 contract correction): R5 verifies the hosted transport for automated agent-session dispatch — submit, observe, retrieve, follow-up and cancel for director/PM/worker assignments. It does not gate the user's manual experiment run, and "R5 blocked" is never reported as one indivisible obstacle to the whole application. Readiness is reported separately for: agent communication, agent tool execution where a stage requires it, the manual experiment handoff (export → wait → import), returned-result validation, and optional protected evaluation.

### R5. Complete and verify the hosted single-agent path (release gate)

Scope note (2026-09-14): this gate covers automated hosted dispatch of agent assignments only. The manual experiment run (section 1.6) and the manual terminal handoff for agent tasks do not depend on it; see slice C8 for the first-release milestone that proceeds while this gate is open.

The PTY implementation, native module inclusion and local terminal smoke are foundations, not this gate. main/pty.ts observe() always returns UNKNOWN and cancel() always returns acknowledged:false; there is no complete output/follow-up implementation. main/main.ts still selects TerminalHandoffAdapter for ordinary requests; no automatic dispatch handler is wired.

After R1–R4, establish supported official routes for observation, visible events, output retrieval, follow-up where required, cancellation request/acknowledgement, actual model/effort, managed environment and delegation controls. Verify against the installed provider tool and account; browse primary provider documentation when implementing external behavior. Never substitute APIs, local research, self-hosted routing or Colab. If controls remain unsupported, keep automatic dispatch blocked and retain the truthful partial handoff.

Acceptance: one permitted tiny hosted assignment with real ID, exact selected input bytes, verified settings/scope, visible output downloaded and hashed, restart reconciliation, no duplicate dispatch, provider-acknowledged cancellation on a suitable test. Test real native PTY startup/cleanup under packaged Electron (including missing/incompatible module), not only Node or require() success. Record exact evidence and unresolved job IDs. Do not create a new session just to refresh evidence while an older fixture is unresolved.

## 6. Domain records, permissions and state contracts

Implement the following as versioned schemas and main-owned operations on the existing event store; names are proposed types/modules, not claims they exist. UUID record IDs, UTC timestamps, SHA-256 canonical content hashes, explicit schemaVersion and expectedRevision for mutable projections. Immutable facts are never updated in place. Every event carries projectId, requestId, branchId/runId when applicable, actor/source, causationId and idempotencyKey. Optional fields on legacy records preserve replay compatibility; a missing gate/evidence field means unverified.

### 6.1 Required records and minimum fields

| Record | Minimum contract |
| --- | --- |
| ResearchBranch | id, projectId, requestId, familyId, parentBranchId, amendmentReason, specHash, state, revision; lineage persists across renames/forks. |
| FrozenResearchSpec | branchId, universe/version, entity keys, timestamp/timezone/calendar, feature availability and label interval definitions, horizon, data cutoffs, split manifests, cost/portfolio plans, search budget and seeds, metric definitions/thresholds, multiplicity policy, prediction, holdout policy, shadow/retirement policy, code/environment contract, role assignments and disclosure policy. No missing required value at FREEZE. |
| PredictionRecord | branchId/specHash, recordedAt, outcome definition, expected sign/range, probability, rationale reference, falsifiers, prior evidence exposures, prospective/retrospective flag. Hidden from blinded reviewers. |
| StageAttempt | branchId, stage, attemptId, state, input hash-set, assignmentIds, output refs, gate receipts, start/finish, failure detail, retry classification. Scientific followup allowance is separate from infrastructure retries. |
| RunManifest | runId, branch/spec/variant/trial IDs, code/lockfile/environment/data/model/config hashes, seeds, train/validation/test IDs and interval hashes, start/end, provider receipt or imported provenance, status, artifact inventory, metric schema version and diagnostic code version. FAILED/PARTIAL runs remain in ledger. |
| EvidenceArtifact | content hash, bytes, media/schema type, owner scope, run/stage, local managed object, verified provider locator when available, provenance, classification, completeness and retention. Extend current artifacts compatibly to INPUT/LOG/MODEL/PREDICTIONS/METRICS/REPORT/GATE_RECEIPT; do not reinterpret old RESULT as trusted. |
| EvidenceRef / QueryReceipt | artifact hash, exact locator (file lines/row keys/symbol), query text or normalized AST/hash, query-code version, population/filter/sort, offset/cursor, total matches, returned count, omitted count, coverage status, truncation reason, viewer scope and hash of returned bytes. |
| EvidenceBrief | task/spec/run refs, findings with supporting refs, counterevidence, uncertainty, coverage, failed/missing checks, next queries, appendix refs and omitted finding count; separate measured facts from interpretation. |
| GateDefinition / GateReceipt | gate ID/version/code hash, applicability, required inputs, thresholds/units/comparison, evaluator environment, result PASS/FAIL/BLOCKED/NOT_APPLICABLE, measurements, evidence refs, verified execution provenance and explanation. Receipt for an old dependency cannot authorize a new one. |
| DisclosureGrant | subject/context ID, role/stage, allowed artifact IDs/classifications, permitted query operations, purpose, expiry/revocation, input scope hash. Paths/knowing an artifact hash are not authorization. |
| ReviewPacket / ReviewReport | exact subject assignment/run/spec hash, isolated reviewer context receipt, allowed evidence view, independent first report hash, verdict/support/uncertainty/falsifiers or mechanisms, completion receipt, optional one rebuttal, invalidation references. |
| Decision | subject/version, director assignment, required gates/reports, PROMOTE_TO_HOLDOUT/RETIRE/DECISIVE_TEST/INCONCLUSIVE, reasons and evidence. Promotion is stage eligibility, never capital deployment. |
| TrialLedgerEntry | family/branch/candidate/variant, hypothesis, selection opportunity, registration time, outcome/failure, code/data/spec hashes, exposures and ancestry. Count portfolio and hyperparameter variants as well as feature variants; retries reuse a trial only when no new selection opportunity exists. |
| HoldoutReservation / Exposure | holdout version, family/candidate/spec hash, budget period, permit ID, requested/reserved/exposed/unknown state, disclosure time, evaluator receipt and returned result hash. Atomic reserve before delivery; no restore resets exposure. |
| CacheEntry | COMPUTATION or INTERPRETATION, canonical dependency key, artifact refs, origin run, completeness, invalidation reason, permissions; interpretations add exact model/prompt/context hash and review standing. No secrets/raw credentials. |
| ShadowPlan / Observation / RetirementPolicy | approved version, sampling/data source, prediction release clock, simulated execution assumptions, evaluation horizon/minimum observations, metrics/alarms, threshold version, evidence provenance, PAUSE/RETIRE/review events. Never a broker order. |

Default numeric policies are operational, not trading advice: one S7 decisive follow-up per candidate lineage; one final holdout exposure per holdout version; workspace holdout allowance one new exposure per calendar quarter in America/Los_Angeles, stored with timezone and explicit UTC boundary. No rollover or restore reset. A later prospective policy revision may change allowance but cannot erase prior exposure. Parallel reservations count against allowance and are atomic. UNKNOWN exposure consumes a slot until non-exposure is proven. Data-specific acceptance thresholds, horizons, costs, dates and shadow duration have no invented defaults: require concrete research-spec values before a real freeze; synthetic fixture values must be labeled test-only.

### 6.2 State machine rules

Branch states: DRAFT → FROZEN → ACTIVE → AWAITING_ADJUDICATION → AWAITING_HOLDOUT → SHADOW → MONITORING → RETIRED, with BLOCKED, INCONCLUSIVE and INVALIDATED outcomes. Stage state: PENDING → READY → RUNNING → PASSED/FAILED/BLOCKED/UNKNOWN/CANCELED. Keep provider job state separate. A completed remote job can still yield a failed scientific gate. Waiting on the user's manual run is an explicit durable stage state owned by the export/import handoff, not an agent assignment; it persists across restart and restore without resubmitting anything, and no agent or controller calls are made on the waiting experiment's behalf.

Main exposes allowed actions computed from exact prerequisites, disclosure grants, matching evidence, active profile/provider availability and cancellation state. No generic “set stage PASS.” Before a stage starts, persist StageAttempt plus assignment intent. A downstream stage requires current PASS receipts or a preregistered valid NOT_APPLICABLE; BLOCKED/UNKNOWN/absence prevents advancement. Retrying transport uncertainty never creates a new job without reconciliation. Failure does not delete artifacts or free an uncertain provider slot.

A specification change creates a new branch with parent/family link, frozen diff reason and invalidations. Code changes after review create a new candidate revision requiring S2/S3 again, even if the spec is unchanged. Changing a benchmark, cost coefficient, universe filter, portfolio rule, seed selection or threshold after evaluation is a scientific variant, not a harmless retry. Reusing exposed holdout data under a new branch does not make it unseen.

### 6.3 Access matrix and enforceable blinding

| Actor/function | May see | Must not see before permission |
| --- | --- | --- |
| Director | S0 plan, prior development evidence, post-gate briefs, sealed reports after both complete | Final holdout contents/results before S8. |
| Builder/workers | Frozen spec, approved development data, implementation context, permitted test diagnostics | Final holdout; correctness reviewer private report while preparing independent implementation evidence. |
| Correctness reviewer | Exact source/dependencies, timing/split/cost/portfolio definitions, synthetic fixtures, full check receipts | Candidate Sharpe/IC/AUC/MAE/equity charts, director prediction, performance hints in paths/prompts and other reviewers' conclusions. |
| Advocate and skeptic | Same versioned development evidence package and source/query access | Each other's first report until both immutable; final holdout before S8. |
| Cheap extraction worker | Explicit permitted artifact slice and extraction schema | Unscoped project data, holdout, approval authority. |
| Holdout custodian | Frozen candidate/evaluator contract plus sealed data in isolated authorized environment | Cannot change candidate/thresholds or produce negotiable gate outcomes. Not a conversational role with all data in its prompt. |

Enforce grants in retrieval/export/indexing and remote tool configuration, not only prompt text. A fresh chat in a shared unrestricted filesystem is not blinded. Search snippets, embeddings, cached answers, filenames, metadata counts and summaries must not leak restricted performance/holdout information. Disable broad filesystem/network/tool access to restricted stores where the provider permits it. If isolation cannot be verified, label REVIEW_UNBLINDED or HOLDOUT_UNSEALED and block the corresponding independent/holdout promotion claim. Accurate labels, not workflow blockage: user-run and user-attested progression remains available with its provenance shown, while the stronger claims stay blocked (section 1.6 evidence tiers).

For correctness, use an isolated source/synthetic-data packet; candidate real performance is computed later or stored in a separate inaccessible namespace. If a reviewer needs extra material, main validates an explicit scope expansion and logs it; material performance exposure invalidates blinding and requires another clean reviewer context. Do not let a builder suppress full dependency inspection by providing only favorable diffs.

### 6.4 Evidence/query/cache interfaces

Proposed main service operations: storeOutput(manifest,bytes), describeArtifact(id), queryEvidence(ref,query,cursor), readEvidence(ref,range), prepareContext(stageAttemptId), lookupComputation(key), recordComputation(receipt), invalidateDependencies(changedHashes). Renderer-facing endpoints take IDs and allowlisted query schemas; they never execute arbitrary code. Authorized research query scripts run through the provider adapter, return immutable receipts and have resource/timeout limits.

Start with exact text/JSON/table-slice retrieval; optional symbol indexes later. Stable cursors bind artifact hash/query/order; changing the source invalidates the cursor. Return totals or UNKNOWN_TOTAL explicitly. Raw expansion remains scoped and paged, with no silent truncation. Whole-file requests may be chunked, never silently replaced by a model summary. External artifact text is untrusted data and cannot modify workflow grants.

Computation cache key = hash(input artifact hashes + normalized query + analysis code/lockfile/environment hash + semantic config + seed/randomness policy + output schema). Nondeterministic execution records variability/tolerance and cannot claim bitwise reproducibility from a seed alone. Interpretation key additionally includes exact prompt/model/effort/context/disclosure-policy hashes; origin/provenance is visible. Authority/readiness and current gate standing are re-evaluated on every reuse. Different reviewer contexts cannot reuse one another's interpretation. A reused result creates a reuse receipt, not a fabricated fresh run.

## 7. Full research workflow S0–S10

This is a TEAM/explicit research template, not a mandatory path for questions, ordinary code review or SINGLE requests. Non-empirical work uses request → prepare → execute → evidence → optional authorized review. Any claim promoted as independently validated research must satisfy its applicable gates even if the user originally requested one agent; offer the needed explicit scope change, never silently add reviewers.

Model assignment is data: stage function → eligible profile ID/revision → verified provider/model/effort. Default director uses an eligible Claude profile because that is the user's established preference. Builder and advocate must be different assignments; builder is not counted as an independent advocate/reviewer for its own work. Correctness and skeptic require separate fresh contexts. Cross-family reviewer diversity is desirable when available, not a substitute for isolation or a hardcoded model entitlement. No automatic cheaper-model substitution.

### S0 — Register and freeze before candidate evaluation

**Owner:** Director prepares; main validates schema and ledger; the office's deterministic policy records the protected holdout scope (custody of the data itself is the separately scoped S8 concern). Existing known performance is disclosed, never relabeled a prediction.

Inputs: objective, universe/data provenance, timestamp availability and entity keys, label formula/horizon, permitted development dates, untouched holdout reference, practical constraints, independent evaluator method.

Required frozen decisions:

1. Outcome/estimand: predictive question and tradeable decision separately; forecast target, units, decision timestamp, availability lag, eligible universe at each timestamp, survivorship/delisting/corporate-action policy.
2. Split plan: explicit chronological outer folds with train/selection/evaluation interval hashes; preprocessing/encoding fitting scope; label-overlap purge rule; applicable gap/embargo; group constraints, refit schedule and final evaluation separation.
3. Search plan: candidate families, feature/hyperparameter/portfolio alternatives, maximum selection trials, selection rule, seeds/replicates and recording failed/pruned trials. An unregistered alternative cannot be promoted.
4. Cost contract: fees/spread/slippage/impact/borrow/financing where applicable, units, timestamp inputs, calibration provenance, scenario sweep and gross/net accounting. Check assumptions independently before freeze.
5. Portfolio contract: signal mapping/sizing, lag, rebalance, neutrality exposure definition and estimation window, caps, gross/net exposure, leverage policy, turnover constraint, liquidity/capacity, missing signal and untradeable/borrow failure behavior.
6. Metrics/gates: formulas, directions, thresholds, minimum samples, uncertainty method and multiplicity adjustment, slice definitions; mandatory versus diagnostic checks. Undefined numerical results block the relevant gate.
7. Prediction: expected outcome distribution/range, sign and falsifiers; priors are hidden from correctness review. Holdout allowance/exposure policy, one-followup limit, shadow minimum horizon/coverage and retirement rules.

Outputs: FrozenResearchSpec + PredictionRecord + first trial/ledger facts + protected Holdout reference. Gate G-SPEC requires all mandatory fields and validated consistency. No model can invent dataset-specific values from missing information; real freeze is BLOCKED with named missing inputs. Each code/spec/data change thereafter is versioned and invalidates affected gates.

### S1 — Build the frozen specification

**Owner:** Build lead with explicitly bounded workers. Inputs: S0, source snapshot, approved development-only data, task-specific context packet.

Implement data loading/availability, split engine, fold-local transforms, CatBoost or chosen model, diagnostics, portfolio and cost engines exactly as specified. Reuse standard libraries after verifying semantics. No training or research on the local desktop; local synthetic engine tests are permitted. Emit source diff/full dependency refs, environment lock, deterministic synthetic checks and named gate suite. No holdout mount or query token.

Workers return evidence briefs and exact artifact refs, not full histories. A failed test is preserved with raw output and exit status. Builders cannot change a gate/threshold to clear a failure. Output candidate code hash and implementation report; code fixes create a new candidate hash and rerun affected checks.

### S2 — Independent correctness review, blinded to performance

**Owner:** separate correctness assignment/context, not builder. Inputs: S0 excluding director prediction, source/dependencies, synthetic data and G-CORRECT receipts. Candidate performance does not exist in the reviewer packet.

Checks (stable gate IDs, not prose assertions):

| ID | Required check / regression |
| --- | --- |
| G-TIME | Features and universe membership were available before decision; labels finish after decision; delayed/revised vendor timestamps tested with planted look-ahead. |
| G-SPLIT | Fold row/entity/time IDs and label intervals obey the frozen chronological/purge/group rules; overlapping-label and wrong-time synthetic fixtures must fail. |
| G-FIT | Imputation/scaling/selection/encoding fitted only on allowed training data; validation and test never update transform state. CatBoost categorical handling does not excuse an upstream full-data transform. |
| G-TARGET | Fold-wise target statistics calculated in correct scope; deliberate target encoding leakage rejected. Reviewer sees structural/synthetic checks, not candidate economic outcomes. |
| G-SELECT | Early stopping/hyperparameter/feature/portfolio selection uses designated selection data; reported outer-test data never doubles as tuning set. |
| G-TRADETIME | Prediction precedes permitted execution price; no same-bar close used before availability; alignment/lag and missing calendars tested. |
| G-COST | Signed cashflows, fee/spread/slippage/borrow units, turnover convention and gross-to-net identity pass hand-computed fixtures. Assumption realism remains a separate report. |
| G-PORTFOLIO | Exposure/caps/neutralization/turnover/missingness use allowed data and specified policies; infeasible allocation fails explicitly. |
| G-INTEGRITY | Code/config/data/split hashes and object inventory match; no unselected file, hidden config or mutable dependency enters execution. |

Mechanical failures block absolutely. Reviewer can identify an untested issue: append a defect and a failing regression, mark REVIEW_BLOCKED, then repair and rerun. A finite CI suite does not prove absence of every bug. Output sealed CorrectnessReport bound to candidate/spec/check-code hashes plus a context-separation receipt labeled by actual evidence (section 1.6 tiers): controller-enforced context separation is the mandatory minimum for the manual pilot; a check the frozen spec requires to be independently executed may run inside the user's manual package or a separately provisioned service; signed provider attestation is a stronger separately scoped tier whose absence labels the review rather than blocking the manual workflow. S2 PASS requires mandatory checks PASS and no unresolved correctness defect; not a favorable Sharpe.

### S3 — Export the frozen package; the user runs it and returns the artifacts

**Owner:** the user, executing the approved package manually in Colab. The desktop prepares and exports the frozen package, holds a durable waiting state and validates the return; it never connects to, polls or controls Colab and makes no calls on the waiting experiment's behalf. Inputs: S0 frozen version and S2-approved candidate.

The exported package binds the fixed launcher and user instructions to code, configuration, relevant data identities, check definitions, environment requirements and the expected output inventory. Export records the exact package identity; a changed payload is a new version, never a silent mutation. The package contains no agent API calls, team callback, monitoring endpoint or remote-control listener.

The explicit user-wait state is durable across restart and restore: recovering the workspace recovers the same pending handoff without submitting any execution job. The legacy stage names `WAITING_FOR_USER_PREFLIGHT` / `WAITING_FOR_USER_RUN` describe this contract; retaining the names alone does not satisfy it.

On return, the user imports the produced files. Import binds returned bytes to the exact package identity; wrong-package, incomplete, corrupt and duplicate-conflicting returns are rejected with useful explanations. An eligible complete return is accepted for the applicable analysis with its user-run provenance retained — it is never relabeled independently hosted or custodial evidence. Only the registered train/selection/outer-evaluation procedure counts as the run. Preserve every fold/model/config/seed, failed trial, stdout/stderr, exit status, prediction row keys, model files, data availability contract, resource/provenance and final status from the return. Store metrics separately from S2 access. Check one out-of-fold prediction per expected eligible row (or declared repeats), no training-row masquerading as evaluation, matching labels and manifest inventory.

G-ARTIFACT requires verified returned bytes, complete split/prediction coverage or predeclared missingness policy, matching input/code/environment and honest run provenance. Partial/failed runs are evidence but do not pass as complete. A manually returned CatBoost result without pre-run registration is EXPLORATORY_IMPORTED: verify/archive it, perform diagnostics, and create a new prospective branch for confirmation; never manufacture a past S0 or unseen holdout.

A separately provisioned hosted executor remains an optional additional route with unchanged evidence requirements; it is not a prerequisite for this stage, and no provider session is required to complete it.

### S4 — Evaluate the signal and look for unexpected findings

**Owner:** deterministic diagnostic scripts shipped in the user-run package, plus a scoped analysis worker through an authorized agent route; no new training/selection on outer evaluation, and no silent diagnostic execution on the desktop. Inputs: verified S3 prediction/label data, fold/slice definitions and primary/secondary metric plan.

Compute applicable forecast loss/calibration and naive/linear baselines; cross-sectional Spearman rank IC per decision date with sample counts, average IC and dependence-aware uncertainty; horizon decay; bucket/decile spread and monotonicity; hit rate with denominator/decision definition. For single-series/non-cross-sectional work use the preregistered alternative, not fake IC. Slice by frozen year/regime/sector/liquidity definitions where populated; regime labels used for trading must be available at decision time.

Use HAC or block bootstrap as preregistered for autocorrelated/overlapping outcomes, with declared lag/block rule and coverage; do not use naive independent-observation t-statistics. Record insufficient-sample slices as BLOCKED/diagnostic insufficient, not zero effects. Include all failed/pruned variants in selection accounting. DSR or another justified multiplicity method must record assumptions and trial dependence; no automatic significance from an unadjusted large statistic.

Two paths: decision-focused metrics answer the S0 question; discovery path inspects extreme tails, missing/failed runs, chronology, sector/liquidity concentration, variance, duplicates and negative controls, plus reproducibly selected varied samples. Feature stability uses declared importance method, correlated feature groups, fold prediction agreement and allowed ablations. Importance rank shuffling is a flag, not an automatic hard failure.

Outputs: full diagnostics, plot/table artifacts, GateReceipts for preregistered criteria and EvidenceBrief with counterevidence/coverage/unperformed checks. Unexpected finding triggers investigation/retirement, not hidden retuning. New research analyses that create selection opportunities append a trial/variant; exploratory slice results cannot be promoted as preregistered confirmatory findings.

### S5 — Translate predictions into positions using the frozen rule

**Owner:** the frozen deterministic portfolio engine executes inside the user-run package (or a separately authorized hosted executor); the office validates and records the returned position artifacts, and the build lead diagnoses implementation failures without tuning. Inputs: S3 predictions and S0 portfolio contract. Code was built in S1; S5 applies it.

Compute lagged tradeable signals, normalization using permitted training/history, size/neutralize/cap positions, handle unavailable assets, enforce turnover/liquidity, and produce target position/order-intent artifacts (no broker orders). Record infeasible constraints, rounding and unallocated exposure. Every alternative neutralization/sizing/rebalance rule is a registered variant; choosing the best after seeing S4 remains development selection and requires new evaluation evidence.

Output portfolio manifest, positions by timestamp/entity, exposure/turnover diagnostics and G-PORTFOLIO receipt. Cannot advance with missing rules or hidden default tuning. Portfolio variant trial count stays in family ledger.

### S6 — Backtest net economics and robustness

**Owner:** the deterministic backtest/cost engine executes over approved outer-evaluation results inside the user-run package (or a separately authorized hosted executor); the office validates the returned economics. Do not rerun model fitting on test data to improve S6.

Generate gross/net return series, fees/spread/slippage/impact/borrow/financing breakdown, turnover, holding periods, exposure, drawdown/recovery, net risk-adjusted metrics with uncertainty, capacity scenarios and reference baseline. Document annualization frequency/risk-free convention and irregular timestamps; undefined Sharpe is not a pass.

Run preregistered base/1.5×/2× variable-cost diagnostic sweep (fixed fees retain their defined treatment), turnover/capacity and data-delay stress; record what is estimated versus observed. Frozen economic thresholds determine G-ECON. Arithmetic G-COST/G-TRADETIME/G-PORTFOLIO failures invalidate output; economically weak but correctly computed output is VALID_NEGATIVE and retired unless the predeclared follow-up process applies. Never lower S0 thresholds after a weak result.

No assertion that “walk-forward” alone removes leakage. Training/selection design from S0 and G-SPLIT remains binding. Outputs: complete net/gross series, cost audit, stress matrix and brief with evidence refs. Hard integrity/correctness/economic gates must pass for holdout eligibility; a model discussion cannot waive them.

### S7 — Independent advocate/skeptic and bounded adjudication

**Owner:** two separate assignments receiving the same S3–S6 development evidence version; director adjudicates after immutable first reports. Correctness reviewer conclusions may be available now but are not replaced by the debate.

Advocate: strongest evidence-supported real-effect case, economic mechanism, baseline comparison, counterevidence and explicit falsification tests. Skeptic: up to three concrete artifact explanations ranked by evidence (e.g. availability error, selection/regime concentration, execution-cost sensitivity), each with locator, proposed discriminating test and predicted result. They may agree the effect is absent/uncertain; neither must defend a prescribed conclusion. Both have full permitted retrieval, not only an analyst summary.

Seal first reports; only then allow one bounded response each to named contradictions. Director records PROMOTE_TO_HOLDOUT, RETIRE, INCONCLUSIVE, or DECISIVE_TEST. Promotion requires all current mandatory gates and the independence evidence the frozen spec names, tiered per section 1.6: sealed separate first reports and grant-checked retrieval are mandatory; signed hosted-runtime attestation is a separately scoped stronger tier whose absence constrains the claim, not the manual workflow. The one decisive test is preregistered on development data, with outcome-to-decision mapping and no holdout access; after it, adjudicate once without further scientific follow-up for this candidate lineage. If new work is warranted later, create a linked branch with shared family trial/exposure history. A correctness defect returns to repair/versioning, not debate.

### S8 — Final holdout evaluation under exposure accounting

**Owner:** policy service plus the evaluation route actually used — the user's manual run under exported-package custody (the default) or a separately provisioned isolated evaluator. No agent can fetch holdout through general search or request custom slices to tune a candidate.

Prerequisites: S7 promote, current gates, untouched holdout version, fixed candidate/training/refit recipe, unused reservation allowance and the isolation evidence the chosen route can actually supply. Freeze any final train-on-development refit recipe at S0; bind the final model/recipe hash before unseal. If the chosen route cannot isolate data from builders/director, block the corresponding protected-evaluation claim rather than relying on a “do not look” prompt — the manual route is labeled user custody, not independent custody.

Reserve exposure atomically before releasing sealed data or a one-time evaluation package. Log all views/queries/results as exposure. Default one candidate evaluation per holdout version and one workspace exposure per quarter; these are conservative product policies, not statistical corrections. Byte-identical retrieval of the same completed report consumes no new candidate trial; changed candidate/query/fitting against holdout is prohibited. Crash after release is EXPOSURE_UNKNOWN and consumes reservation pending reconciliation. Backups cannot roll the counter backward; reconcile an external exposure anchor/custodian journal or mark holdout spent/unknown after restore.

Return only preregistered final evaluation outputs and gate receipt. Compare with S0 prediction after evaluation. Failure retires or becomes inconclusive according to frozen policy. New tuning after viewing results makes that data development evidence forever; a new independent holdout requires new data and policy registration. No quarterly reset makes previously exposed data unseen.

Manual external execution is the default route: reserve exposure atomically before exporting the exact holdout evaluation package; an imported result keeps user-run provenance until provenance/isolation can be verified by a stronger route, and a manual holdout result is never called independently custodial evidence — its limitations constrain the claim without erasing the pilot's usefulness. Do not connect to Colab or execute there. No sealed data/keys in ordinary workspace backups accessible to research agents. Local event/hash storage alone is not a secure holdout custodian; a separately provisioned custodian service remains a scoped option for stronger custody claims, not a prerequisite for the manual pilot.

### S9 — Shadow evaluation with no capital

**Owner:** prospective signal-generation process in an authorized environment, with manual artifact handoff as the normal path and direct hosting as the separately scoped variant. S9 is a separately scoped lifecycle capability beyond the first pilot (section 1.6). The desktop does not place orders or start a market-data subscription.

Use the frozen signal/portfolio version; timestamp predictions before outcomes. Capture stale/missing inputs, latency, calendar issues, borrow assumptions, availability, simulated fills, missed signals, cost estimates, risk/exposure and realized subsequent market returns. Compare backtest distributions and operational assumptions, not only costs. Predeclare minimum elapsed time, independent observations and coverage; too little data is INCONCLUSIVE.

Output shadow manifest/diagnostics and G-SHADOW receipts. Clearly distinguish SIMULATED_FILL, OBSERVED_MARKET_QUOTE and ACTUAL_EXECUTION_IMPORT. Shadow/paper alone cannot validate own-order impact, queue priority or real slippage. Actual fills, if later supplied by the user, are separate evidence with provenance; this plan authorizes no capital experiment or broker integration. Passing S9 means shadow-qualified evidence, not permission to deploy money.

### S10 — Monitor, suspend and retire

**Owner:** deterministic policy evaluation plus scheduled-review records evaluated when supported/manual evidence arrives. S10 is a separately scoped lifecycle capability beyond the first pilot (section 1.6). This roadmap creates no desktop automation implicitly.

Track preregistered IC/economic decay, uncertainty/minimum observations, feature/input drift, data freshness, costs, exposure and operational violations; acknowledge drift as an alarm, not proof of failure. Specify threshold direction/window/hysteresis, missing-feed behavior and review cadence in S0. Critical data/identity/exposure breaches produce SUSPENDED; economic kill conditions produce RETIRE when defined prerequisites are met. Any agent may raise a stop request; no model may waive a mandatory halt.

Maintain ledger reasons and links to avoid rediscovering rejected hypotheses without checking ancestry. New evidence can motivate a new registered branch, never silently reopen the retired run or erase its trials. The application changes research eligibility and exports reports only; no claim it can flatten live positions without a separately authorized trading system.

## 8. Context-efficient workflow at every stage

### 8.1 Standard assignment packet

Every new model context gets: task ID/function; objective and acceptance criteria; immutable spec/candidate hashes; allowed actions/data scope; relevant EvidenceRefs; prior decisions/corrections needed for this task; open questions; output schema; stop/escalation rule; allowed retrieval handles. Do not send the entire director or predecessor transcript by default. Do not omit user corrections or unresolved contradictions for brevity.

A worker returns EvidenceBrief plus raw artifacts/QueryReceipts. Director sees completion/failure, brief and expansion handles. Logs never become compressed-only records. Full raw bytes remain retrievable within retention/disclosure policy. Correctness, advocate and skeptic each receive the independently authorized packet, not a prior worker's reasoning dressed as source evidence.

Proposed brief shape (fields mandatory; arrays may be empty with reason):

~~~json
{
  "schemaVersion": 1,
  "subject": {"runId": "uuid", "specHash": "sha256", "stage": "S4"},
  "findings": [{"claim": "...", "kind": "MEASUREMENT", "evidenceRefIds": ["uuid"]}],
  "counterevidence": [],
  "uncertainty": ["..."],
  "coverage": {"population": "...", "checked": 0, "total": null, "status": "UNKNOWN_TOTAL"},
  "unperformedChecks": [{"id": "...", "reason": "..."}],
  "nextQueries": [],
  "appendixRefIds": [],
  "omittedFindingCount": 0
}
~~~

The placeholders above describe a schema, not a valid completed research report. Runtime validates UUID/hash/reference ownership and disallows claimed measurements without refs. Distinguish not-applicable from not-performed. A brief does not grant access to its cited artifact.

### 8.2 One output adapter, progressive retrieval

Wrap adapter outputs once: store raw bytes/status → classify/check integrity → index authorized fields → emit metadata/brief references. For build/test commands retain command identity, frozen environment, exit code, stdout/stderr, parsed failing test IDs and warnings. A success summary cannot erase nonzero exit or warnings. Unknown parsers fall back to raw paged text, not optimistic filtering.

First read: artifact description, size/schema, indexed sections and coverage. Second: focused exact queries with counts. Third: original lines/rows/chunks and wider samples. UI offers Expand evidence/Read original and logs retrieval grants. A failed search reports query/index coverage and version; missing matches never certify absence.

No global model-readable index containing holdout/performance-blinded data. Retrieval grants must be checked before any result is sent to a model; a received disclosure cannot be undone by subsequently revoking a grant. Local storage indexes support desktop bookkeeping; hosted agents receive only explicitly granted outputs through a verified route. If remote query transport is unavailable, expose a manual prepared packet and mark interactive retrieval unavailable; do not label the stage autonomous or fully blinded without evidence.

### 8.3 Reuse and invalidation tests

One computation cache shared by authorized callers; review interpretation caches remain isolated. Dependency edges include code, data, feature transforms, split, costs, portfolio, query, environment, schema and random-state policy. Invalidate only affected derivations but transitively invalidate associated gate/review standing. The old result remains accessible as historical evidence.

Tests must change each dependency independently and observe a miss/invalidation. Test same bytes under another project/grant, omitted rows hiding a critical defect, source update during cursor paging, no raw-output loss, expired grants, forbidden holdout search snippets, reviewer cache poisoning and restored stale state. Missing compute receipts never become trusted reuse.

### 8.4 Efficiency acceptance experiment

Use fixed synthetic/known-answer coding and research fixtures with planted defects: leakage, omitted failed folds, cost sign/unit bug, rare-segment loss, contradictory output, stale cache and wrong-source index. Compare full-context baseline against on-demand packets with the same task budget and model settings; repeat when stochastic behavior matters. Include a reviewer expansion that must recover a fact omitted from the first brief.

Hard acceptance: all known critical fixtures remain discoverable; no hidden truncation, unsupported source claim, cross-project disclosure or stale-result approval. A small benchmark cannot prove zero missed findings universally; record coverage and failures. Track total observed input/output/cache tokens across all agents, diagnostic/index costs, retrieval counts, retries, elapsed latency and user intervention. Unknown counters stay unknown. Do not choose a cheaper routing policy merely because its first response is shorter. Optimize only after correctness acceptance; no promised savings threshold.

## 9. Desktop workflow and product UX

- New request keeps QUESTION/ANALYSIS/IMPLEMENTATION/CODE_REVIEW/EXPERIMENT and SINGLE/GROUP/TEAM. Experimental TEAM template offers the S0–S10 stages; default simple requests do not demand financial forms or reviewers.
- Research detail shows stage timeline, current version, next allowed action and exact missing gates, separate job state and scientific outcome. Button labels reflect action: Prepare, Open official handoff, Submit verified job, Export run package, Awaiting user run, Import returned results, Review evidence, Register decisive test, Request holdout evaluation, Import shadow results, Retire.
- The research detail shows the durable user-wait state, the exact exported package identity and the import validation outcome. A pending manual run is never rendered as a failed or missing provider job, and readiness is reported separately for agent communication, agent tool execution, manual experiment handoff, returned-result validation and optional protected evaluation (section 5.3).
- Role/stage assignment editor selects actual existing profiles. Display provider/account/model/effort readiness and context-isolation support separately. No hardcoded product model tiers or automatic four-PM population. Old role labels remain historical; reusable functions are BUILD/CORRECTNESS/ADVOCATE/SKEPTIC/EXTRACTION/DIRECTOR.
- Run page shows manifest, logs, prediction/portfolio/cost artifacts, diagnostics, coverage, source hashes and reuse origin. Selected-file disclosure preview lists exact inputs/bytes and requested managed environment; no cryptic internal transport configuration in the ordinary user flow.
- Evidence reader shows source/coverage/omitted counts and one-click expansion within grants. A warning means missing evidence, not a request to accept reduced quality. Blinded screens/services cannot reveal restricted performance through names, sort order, badges or counts.
- Review page labels independent provider-reviewed, user-attested, self-review, unblinded and stale explicitly. No single “Approved” badge inferred from two profiles on the same request. Display exact subject/output/spec hashes and unresolved issues.
- Ledger displays all trials/variants, negative outcomes, branch ancestry, predictions versus observed results, holdout exposure/reservations and policy revisions. Restoring a backup cannot visually hide unresolved exposure.
- Holdout UI explains immutable candidate and exposure consumption before the authorized action; no sliders or repeated custom queries after unseal. Missing isolation is a blocker with a specific remedy, never a decorative lock icon.
- Shadow/monitor page separates simulated fills and real imported executions, signal reliability and performance. “Qualified” does not mean broker deployment. No money/order controls in this revision.
- Retain office visualization, queue filters, archived read-only profiles, revision-aware drafts, task-scoped logs and data export. Office movement derives from fresh provider evidence; no movement from imported transcripts or reports alone. Idle/Unknown distinction and timer refresh are implemented. Travel/return movement and stable seat and meeting-room placement are implemented and verified locally (section 12.1).

## 10. Ordered implementation slices C1–C11

R0–R4 are prerequisites for integrating these records with external actions; schemas/reducers may be built with local fake adapters while R5 remains blocked. R5 is mandatory for live automated stages and verified hosted claims. Inspect existing code and reuse it before adding files. No new execution backend or optimizer dependency by default.

Realignment note (2026-09-14): C1–C7 were implemented against the pre-correction contract in which a signed independent runtime/harness and custodian were universal prerequisites. That code is retained — it satisfies a stronger contract than the corrected one — and slice C8 revised contract and implementation together so the manual pilot (section 1.6) is the first-release milestone.

Completed slices. Their full packet texts are archived; the section 11 rows hold the evidence.

| Slice | Status |
| --- | --- |
| C1 — Research spec, ledger and stage reducer | VERIFIED_LOCAL 2026-09-08 |
| C2 — Artifact/query layer and evidence briefs | VERIFIED_LOCAL 2026-09-08; provider token comparison BLOCKED_EXTERNAL |
| C3 — Deterministic research contracts and CatBoost result ingestion | VERIFIED_LOCAL 2026-09-08 |
| C4 — Stage orchestration and independent reviews | VERIFIED_LOCAL 2026-09-12 against its implemented contract; contract revised 2026-09-14 |
| C5 — Holdout custody and exposure accounting | VERIFIED_LOCAL 2026-09-12; real custody BLOCKED_EXTERNAL and separately scoped |
| C6 — Shadow, monitoring and research export | VERIFIED_LOCAL 2026-09-12 |
| C7 — UI, performance, evidence reporting and release | VERIFIED_LOCAL; provider experiment BLOCKED_EXTERNAL |
| C8 — Manual-run contract restoration and pilot acceptance | VERIFIED_LOCAL 2026-09-27 (user-run pilot intent satisfied live 2026-09-25); the formal S3 run-package live pilot is follow-up C8-S3 |

### C9 — Local CLI office agents — PARTIALLY_VERIFIED_LOCAL 2026-09-16

Established by user direction on 2026-09-15 with CLI probes run 2026-09-16. This slice adds local CLI agents (Devin/SWE-2, Claude Code, Codex) as a governed third execution surface for office labor only. Research compute — model training, evaluation, backtesting — remains exclusively the user's manual Colab workflow under section 1.6; nothing here runs research locally.

Probe results (2026-09-16, this machine): `devin 3000.10.21` exposes `auth status` (account observation; currently not logged in — the CLI credential is separate from the signed-in Desktop session), `models list` (real account model catalog), `acp` (Agent Client Protocol JSON-RPC over stdio with `--model` and tool-scoped agent types: default, summarizer, review), and `-p` print mode. `codex 0.154.0` exposes `exec` non-interactive runs with `--json`, `--sandbox <mode>`, `-C <dir>` working root, `--output-schema`, and `resume`/`fork`, beside the existing app-server `account/read`/`model/list`. `claude 2.1.273` exposes `-p` print mode with `--output-format`, `--input-format`, `--allowedTools`, `--model`, `--effort` and `auth status`; it exposes no model catalog, so curated aliases/pinned IDs remain its honest surface.

Motivation: the R5 hosted-dispatch gate is account-blocked (section 11), and a local route gives the office a usable agent workflow without waiting on it. The current unlimited local SWE-2 promotion is motivation only — the contract must not depend on free pricing.

Implementation areas, ordered; decompose into disjoint worker packets per section 1.5/D2:

1. Contract/schema: `Provider` gains 'devin'; `Agent.execution` widens from the `HOSTED_SETUP_REQUIRED` literal to include `LOCAL`; `Agent.toolProfile` added (`STANDARD` now, navigation profiles later); record `routeEnum` gains `LOCAL_MAILBOX`/`LOCAL_CLI_EXEC`/`LOCAL_ACP`; `operationEnum` gains `LOCAL_SUBMIT`/`LOCAL_OBSERVE`/`LOCAL_OUTPUT_FETCH`/`LOCAL_CANCEL`; `providerTarget.host` gains `LOCAL_MACHINE`; capability `transport` gains local kinds. Migration leaves existing agents unchanged and unrelocated.
2. Devin account observation: `subscriptions.status('devin')` via `devin auth status` + `devin models list`, credential-stripped environment, no token storage — same provider shape as the Codex app-server path.
3. Local session transports: a mailbox transport first — the office writes a scoped packet (packet.json + declared input files) to a dedicated workspace folder, the local agent reads it and writes result.json plus declared artifacts, and the office validates hashes and the closed inventory — then CLI-exec transports (`codex exec --sandbox read-only --json`, `claude -p --output-format json --allowedTools`, `devin acp`) where the office spawns, observes and kills the child process itself.
4. Readiness: a `LOCAL_DISPATCH` evidence family scoped by route; local agents dispatch only through local routes and never silently fall back to hosted routes or vice versa. Evidence for local ops is office-observed (the office writes/spawns/reads), labeled TOOL_SUPPORTED/OBSERVED, never ACCOUNT_VERIFIED provider attestation.
5. Renderer: Add Agent gains execution-environment and tool-profile fields plus the 'devin' provider option; profiles show environment and per-route readiness; dispatch records where the assignment actually ran.
6. Regressions: environment-scoped readiness, route resolution per agent environment, no silent local/hosted fallback, restart cannot duplicate a dispatch, migration leaves hosted agents unchanged.

First-milestone acceptance: add a local Devin/SWE-2 agent through the UI → the office writes a scoped packet to a dedicated workspace folder → the local session completes one bounded coding/analysis task → the office collects and hashes outputs labeled locally-observed → a mid-run kill cancels the local session → an app restart cannot duplicate the dispatch. Colab remains the only experiment-execution path throughout.

Explicit non-requirements: no local research compute; no change to blinding, holdout custody or verified-gate requirements (local agents are ineligible for those roles); no silent local/hosted fallback; a saved profile is never proof of runtime; no Devin capability claim beyond probed surfaces; no paid-API route; no usage-quota accounting for local agents (the roster here carries unlimited/free local seats only) — local sessions record their own observed evidence, never estimated subscription allowance.

### C10 — Office tool lifecycle and four-plugin evaluation — IMPLEMENTED_FOUNDATION 2026-09-16; trials MEASURED_LOCAL 2026-09-25 (no plugin enabled)

Exact packet: section 3.2. Fixture and plan exist; adapters, installations, live comparisons and savings evidence are NOT_STARTED. This is distinct from D1 developer navigation and extends the existing C9 tool-profile surface. No fifth optimizer or LightRAG/Graphify mandatory chain is in scope.

Ordered implementation packets (organizer owns shared contracts, IPC, dependencies and this roadmap):

1. **C10-A fixture/measurement:** use the checked-in small example; implement isolated attempt preparation, immutable manifests, usage ledger and blind report scoring. Acceptance: starter rejected, corrected implementation accepted, expected evidence/counterevidence scored, evaluator inaccessible, unknown counters preserved, setup/reuse/failure costs separated. The fixture self-check alone does not complete this packet.
2. **C10-B tool lifecycle:** extend C9 environment/profile contracts, assignment snapshots and readiness; environment installation versus session binding; scoped configuration, health, teardown and restart non-duplication. Acceptance: add a new code agent using existing environment setup, then verify actual tools for its assignment; wrong root, absent tool, changed grant/config/version and failed cleanup are observable. Existing agents retain their prior defaults. Product dispatch acceptance depends on the corresponding C9 route being verified.
3. **C10-C Serena + Ponytail:** integrate pinned client-supported Serena processes and task-scoped Ponytail guidance as independent options. Run A0/AS/AP, retaining exact-source fallback and every required check. Acceptance: correct symbols/callers, edit-triggered refresh, no reviewer writes, no suppressed validation, reversible configuration; model-specific measurements only.
4. **C10-D Graphify:** grant-scoped derived graph and source expansion; run AG/BG and the freshness phase. Acceptance: inferred links labeled, source locators valid, changed/deleted sources refreshed, no out-of-scope ingestion; total indexing/extraction cost recorded.
5. **C10-E LightRAG:** establish a permitted extraction/embedding/query route before integrating its document backend. Run B0/BL with context-only delivery where supported; preserve raw source expansion and counterevidence. Acceptance: current-source citations, no permission/cache leakage, model-call ledger including ingestion. If no route meets section 1.1, mark this packet BLOCKED_EXTERNAL and continue the other arms; do not introduce paid APIs or local model services implicitly.
6. **C10-F selection/UI:** run bounded confirmation and useful combinations, publish the actual scorecard as evidence linked here, then enable only supported role/task profiles through Add Agent. No blanket 'best plugin' selection from one fixture; large-corpus applicability stays unverified. Retain off/rollback paths and per-environment compatibility. Required checks: affected unit/type/schema/lifecycle/desktop tests for product changes; full combined checks before release. Fixture-only changes need only their own validation.

Exact next local work: implement C10-A attempt preparation/ledger and C10-B contracts on organizer-published packets; retain C9's separate local-session probe and pilot as outstanding. Local fixture work can proceed without changing R5 or waiting for real data. Do not start paid/live provider runs merely because a packet is written.

### C11 — Launch-readiness revision (LR packets) — DEVELOPMENT COMPLETE 2026-09-28; LR-0…LR-11, LR-14, LR-15, LR-17 merged and LR-16 code merged (`54aa5f7`); launch gates open: LR-16b (D-6), legal review; D-3 deferred

Source: the 2026-09-25 commercial launch-readiness review in section 17 (findings L1–L15).
Base: `origin/main` at or after `e0ce5d9` (rev-3/rev-4 merged; LR-0 merged as PR #18; re-anchored — see C11.0 rule 0). LR-1 is the next packet. New desktop-batch code rounds must branch from this formatted `main`. This slice is written so that a coding model
(the user runs **Devin SWE-2 Max**) can execute each packet mechanically. Every packet names the
exact files, the exact text to find, the exact change, the exact test and the exact commands with
their expected result. The `Model` field says which packets are for the coding model and which
are for the organizer (Claude Opus) or the user.

#### C11.D The user's decisions (answered 2026-09-26) — these are rules, not suggestions

Read this block before every packet. If a packet seems to conflict with it, this block wins;
stop and report the conflict instead of choosing yourself.

- **D-1 Agent isolation = "C now, A at launch".** During development, agents keep running with
  the user's own Windows permissions; the only protections are LR-4 (a consent checkbox) and LR-5
  (a prompt line saying input files are data). Do **not** add sandboxing, a separate Windows
  user, containers or permission changes in any development packet. Option A (a separate
  low-privilege Windows user for agent sessions) is packet LR-16 and belongs to the launch gate.
- **D-2 LR-6 is approved, in the lighter form written in LR-6 below.** Three rules may never be
  broken: (1) the permanent history (the `events` table) is authoritative and is never edited or
  deleted; (2) the quick-access copy (the `projection` row) is disposable and must always be
  rebuildable from the history; (3) every change has a lossless way back. Workspace data is
  **never** committed to Git — Git holds code only. The recovery checkpoint is an automatic copy
  of the workspace file made next to it before migrating.
- **D-3 Signing, installer, updates and fuses = deferred to the very last step.** The product
  must stay free to build. Do not buy, request or configure certificates, installers, update
  hosts or `@electron/fuses` until the user reopens D-3. The former LR-12 packet is parked in
  "Deferred — final step" below.
- **D-4 Provider terms = "C": both a legal review and an API-key mode.** Every user must use
  **their own** provider account or API key, never the developer's. LR-15 (API-key mode) and the
  legal review are launch-gate items. No development packet may add, embed or reference any
  developer account, e-mail, token or key.
- **D-5 Formatting and design.** Formatter = **Prettier, line width 120**, and it runs **first**
  (LR-0), before any other revision. Design = **unify the look, with light as the default
  theme** (LR-14). The dark theme stays available in Settings.
- **D-6 Agents run on the user's subscriptions only (2026-09-29).** Office agents run as local CLIs
  signed in with the user's own subscription, or as the provider's cloud sessions on that
  subscription. Provider API usage is billed separately from subscriptions, so no agent path may
  require, suggest or default to an API key. LR-15 API-key mode stays in the product as an opt-in
  only, to be reviewed after the legal decision. LR-16 isolation v1 authenticates isolated
  dispatches only with API keys, so isolation stays off in real workspaces until LR-16b adds
  subscription sign-in under the agent account. A cloud route (R5) is eligible only when its usage
  is billed inside the subscription.

#### C11.0 Rules for every packet (read these first, every time)

0. **⚓ Re-anchor gate.** The `Find` texts in LR-1…LR-16 were written against the code layout of
   `3be1a94`. Rev-3/rev-4 have since changed store and renderer code; LR-0 will also reformat every file. After LR-0 merges, old exact-text anchors cannot be assumed valid. The
   organizer (Claude Opus) then re-anchors this whole slice against the formatted `main` and
   re-verifies the prototypes, and writes a line `Re-anchored on <commit>` under this rule.
   **Do not start any packet other than LR-0 until that line exists.** If it exists, trust it.

   **Re-anchored on `e0ce5d9`** (LR-0 merged as PR #18) by the organizer (Claude Opus),
   2026-09-27. Every `Find` text in LR-1…LR-14 now matches the formatted code exactly once. Each
   code packet (LR-1…LR-7, LR-9, LR-14) was applied as written to a scratch copy of `e0ce5d9`:
   `pnpm format:check` and `pnpm typecheck` clean; full suite 917 tests, 916 pass, 0 fail,
   1 skipped (904 + the 13 new tests); `local-cli-exec.test.ts` alone passes 25 and exits in
   4 s; the packaged desktop e2e passes 3 of 3 with all of them applied. Two packets changed as a
   result: LR-7 now **awaits** the loading page, and LR-11 is now a regression guard with a
   corrected check (see each packet). The inserted code in the packets may stay dense;
   `pnpm format` re-wraps it.

1. **One packet = one branch = one PR.** Never combine packets unless the packet says so.
2. **Create the worktree** (PowerShell, from any folder):
   ```
   cd "C:\Users\louis\Desktop\AI\Quant Office\Worktrees"
   git -C token-diet fetch origin main
   git -C token-diet worktree add -b <branch> "C:\Users\louis\Desktop\AI\Quant Office\Worktrees\<folder>" origin/main
   ```
   Use the `Branch` and `Folder` values from the packet. Never work in `Quant Office\repo` or in
   `repo-sessions\*`. If `token-diet` no longer exists, use any existing worktree under
   `Worktrees\` for the `-C` argument.
3. **Install once per worktree** (from `<folder>\app`): `pnpm install --frozen-lockfile`.
   Expected: ends without `ERR`. If it fails, stop and report the last 20 lines.
4. **Standard checks** (from `<folder>\app`), run in this order:
   - `pnpm typecheck` → expected: no output lines containing `error TS`.
   - `pnpm exec tsx --test --test-concurrency=4 tests/*.test.ts` → expected: the summary line
     `ℹ fail 0`. The pass count must be at least the previous count plus the tests you added.
   - `node scripts/build.mjs` → expected: the line `Built Quant Research Office`.
   - After LR-0 is merged, first run `pnpm format`, and last run `pnpm format:check` → expected:
     `All matched files use Prettier code style!`.
5. **Find text, not line numbers.** Line numbers in this plan are hints from `3be1a94` and may
   drift. Always search for the quoted `Find` text. If the `Find` text is not found exactly once,
   **stop** and report which text was missing. Do not guess a different place.
6. **Only change what the packet says.** Do not reformat, rename, reorder or "improve" anything
   else. Keep the file's existing style (dense one-line code stays dense).
7. **Stop conditions.** Stop, do not improvise, and report when: a command's result differs from
   the `Expected` text; a test you did not touch fails; a step would need a new dependency, a
   download, or an edit outside the packet's `Files`; or anything asks for credentials.
8. **Never** touch the user's live data (`%APPDATA%\Quant Research Office`), never push to
   `main`, never force-push, never merge your own PR.
9. **Commit and PR.** One commit per packet unless stated. The message is the packet title, then a
   blank line, then `Co-Authored-By: <your model> <noreply@anthropic.com>`. Push the branch and open
   a PR against `main` with `gh pr create --base main`. The PR body must list: changed files,
   commands run with their final summary lines, and a "Proposed roadmap update" paragraph.
   Workers do not edit `docs/ROADMAP.md`; the organizer applies the proposal.
10. **UI packets** (they change `app/src/renderer`) also need the user-level check in AGENTS.md: run
    `node scripts/package.mjs`, open the packaged app with an isolated `QRO_USER_DATA_DIR` and look
    at the changed screen. Record what you saw in the PR.

#### C11.1 Order, dependencies and who does what

| Order | Packet | Finding | Who | Depends on |
| --- | --- | --- | --- | --- |
| 1 | LR-0 Format the code with Prettier (120) and check it in CI | L12 | Coding model | — |
| 2 | RA Re-anchor this slice on the formatted `main` (C11.0 rule 0) | — | Organizer (Claude Opus) | LR-0 |
| 3 | LR-1 Repair the desktop e2e suite and run it in CI | L6 | Coding model | RA |
| 4 | LR-2 Crash handling and a local log | L7 | Coding model | RA |
| 5 | LR-3 Long prompts through PROMPT.md | L8 | Coding model | RA |
| 6 | LR-5 Treat packet data as untrusted in the prompt | L1 | Coding model | RA |
| 7 | LR-4 Local-first Add agent defaults with risk consent | L5, L9, L1 | Coding model | LR-1 |
| 8 | LR-6 One model catalog per account in the quick-access copy | L2 | Coding model | RA |
| 9 | LR-7 Show the window before the workspace opens | L2 | Coding model | LR-6 |
| 10 | LR-8 Measure startup and decide on an integrity checkpoint (measured 4,999 ms → LR-17 added; LR-17 merged, 92–132 ms) | L2 | Coding model (measure only) | LR-6, LR-7 |
| 11 | LR-9 Plain provider status in Settings | L5, L10 | Coding model | LR-1 |
| 12 | LR-10 One date and number formatter | L11 | Coding model | LR-1 |
| 13 | LR-11 Accessible names for icon buttons | L13 | Coding model | LR-1 |
| 14 | LR-14 Unified look with light as the default theme | L14 | Coding model | LR-6, LR-1 |
| Launch gate | LR-15 API-key mode (merged PR #34, `b4c71ec`) | L4 | Organizer designs, coding model builds | all above |
| Launch gate | LR-16 Separate Windows user for agent sessions (v1 merged; real acceptance passed 2026-09-29, PR #46; needs LR-16b under D-6) | L1 | Organizer acceptance | all above |
| Launch gate | Legal review of provider terms | L4 | User (lawyer) | — |
| Very last | Deferred — signing, installer, updates, fuses (former LR-12) | L3 | User reopens D-3 first | everything |

L15 needs no code: until a repeated-measures benchmark exists, no public material may claim token
savings from memory or plugins.

#### C11.K Starting prompt for the coding model (paste as-is; change only the packet id)

The user starts each packet in Devin SWE-2 Max with this message. It works for every packet;
replace `LR-0` with the packet to run.

```
You are a coding worker on the Quant Office repository (github.com/louiskim132/Quant_Office).
Your task is exactly one packet: LR-0.

1. Read AGENTS.md at the repository root.
2. Read docs/ROADMAP.md section 10, slice "C11 — Launch-readiness revision":
   C11.D (the user's decisions — they are rules), C11.0 (rules for every packet),
   C11.1 (order), and the section for your packet only.
3. Check C11.0 rule 0 (re-anchor gate). If your packet is not LR-0 and the line
   "Re-anchored on <commit>" is missing, stop and tell me.
4. Follow your packet's steps in order, exactly as written. Do not do anything the packet
   does not say. Do not improve, rename, reorder or reformat other code.
5. If any step's result differs from its "Expected" text, or the "Find" text is missing,
   stop and tell me what you saw. Do not guess and do not work around it.
6. Do not edit docs/ROADMAP.md. Put the "Proposed roadmap update" in the PR body.
7. When done, reply with: the PR link, the commands you ran with their final summary lines,
   and anything you skipped or that surprised you.
```

After the coding model reports, the organizer (Claude Opus) reviews the PR against the packet's
"Done when" line before it is merged; after LR-0 merges, the organizer also runs the re-anchor
(C11.0 rule 0).

#### Launch gate — do not start during development

- **LR-15 API-key mode (D-4). DONE — merged PR #34 (`b4c71ec`) 2026-09-27.** The organizer writes the design first; the coding model builds it.
  Requirements already fixed by the user: every user signs in with their **own** provider account
  or enters their **own** API key; the developer's accounts are never used, embedded or
  referenced; keys are stored with Electron `safeStorage` (Windows DPAPI), never in the workspace,
  logs, Git or prompts; subscription mode stays available for users' own subscriptions.
- **Legal review (D-4).** The user has each provider's terms reviewed for commercial automated
  use before any sale. Record the outcome in section 17.
- **LR-16 Separate Windows user for agent sessions (D-1 option A). CODE MERGED (PRs #37–#40, #42); v1 real acceptance passed 2026-09-29 (PR #46); LR-16b open under D-6.** The organizer writes the
  design first. Direction: a dedicated low-privilege local account created once with the user's
  consent, agent CLIs started as that account, and file access limited to the packet folders.
  Real acceptance passed 5/5 on 2026-09-29 through the in-app Check isolation action (PR #46).
  Isolation v1 authenticates isolated dispatches only with a saved provider API key, so under D-6
  it stays off in real workspaces until LR-16b adds a subscription sign-in under the agent account.

#### Deferred — final step (D-3, reopen only when the user says so)

Parked until the user reopens D-3 (the product must stay free to build): code signing (Azure
Trusted Signing, OV or EV certificate), installer (MSIX or NSIS), update channel (GitHub
Releases, own host or Microsoft Store), `@electron/fuses` hardening (the former LR-12 steps,
kept below for later), and a release check that the packaged app contains no workspace data and
no developer account identifiers.

##### Parked: former LR-12 — Electron fuses in the packaged build (L3)

- **Parked (D-3 deferred).** Do not run until the user reopens D-3.
- Branch `fix/lr12-fuses`; Folder `lr12`. Files: `app/package.json`, `app/pnpm-lock.yaml`,
  `app/scripts/package.mjs`.

Steps:
1. From `lr12\app`: `pnpm add -D @electron/fuses` (only after approval).
2. In `app/scripts/package.mjs`, add at the top with the other imports:
   `import {flipFuses,FuseVersion,FuseV1Options} from '@electron/fuses';`
3. Find the line that starts `for(const path of output)console.log(` and insert directly
   **before** it:
   ```js
   // Release hardening. QRO_TEST_BUILD=1 keeps the inspector fuse on, because Playwright's
   // Electron launcher drives the app through it (the desktop e2e runs on test builds).
   for(const dir of output)await flipFuses(resolve(dir,'Quant Research Office.exe'),{
     version:FuseVersion.V1,
     [FuseV1Options.RunAsNode]:false,
     [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:false,
     [FuseV1Options.EnableNodeCliInspectArguments]:process.env.QRO_TEST_BUILD==='1',
     [FuseV1Options.EnableCookieEncryption]:true,
   });
   ```
   Do not enable `OnlyLoadAppFromAsar` or `EnableEmbeddedAsarIntegrityValidation` in this packet.
4. In `.github/workflows/verify.yml`, give LR-1's `Package` step `env: { QRO_TEST_BUILD: '1' }`.
5. Package without the variable and start the exe by double-click. Expected: the app opens.
   Package with `QRO_TEST_BUILD=1` and run LR-1's e2e. Expected: it passes.
- Done when: both expectations hold.

#### C11 exit criteria

Development phase done: LR-0…LR-11 and LR-14 merged, the desktop e2e and format check green in
CI, `bench-store.ts 1000` under 3 s to open. Launch: LR-15, LR-16 and the legal review done, then
the deferred D-3 items, a signed installer tested on a clean Windows machine, and the section 11
row moved to VERIFIED_LOCAL.

## 11. Execution checklist and progress record

Navigation (2026-09-24): the dated progress log for 2026-09-15 onward is section 17 at the end of this file. It was previously appended under the section 16 historical appendix. Read these tables first, then the newest dated entries in section 17.

Latest C9 qualification (2026-09-21) supersedes the historical C9 row's statement that CLI-exec is unimplemented: LOCAL_CLI_EXEC and automatic dependency relay are implemented and have passed the real three-agent acceptance below. The historical row retains its original evidence; it is not the current next-action list. Codex addendum (2026-09-27): the LocalCliExecAdapter declares `openai` alongside `devin`/`claude`, and the 2026-09-25 token-diet CLI A/B exercised the codex exec argv live on an implement packet at gpt-6-astra low — lean flags `-c mcp_servers={}`, the CODEX_DISABLED_FEATURES set and `-c model_reasoning_effort` mapping carried 374k → 147k input tokens and 12 → 7 commands. That is VERIFIED_LOCAL for the exercised implement-hop transport scope only: Codex dispatch variants (other hop kinds, multi-hop dependency chains), handoff, cancel and failure paths remain unexercised, and no office-driven end-to-end Codex dispatch has run — an exercised implement-hop argv is not a verified first-class Codex provider profile. The historical row's "local Codex provider unimplemented" residue therefore now means the unexercised office-driven lifecycle, not absent transport code.

| Current acceptance item | Status | Evidence / next item |
| --- | --- | --- |
| C9 automated Director → PM → Worker | VERIFIED_LOCAL for bounded live Claude CLI relay | Three distinct role profiles and real processes; one Director start, two event-driven dependent starts; exact inherited manifests, agent-consumed predecessor hashes, verified durable outputs and replay non-duplication. Two product defects repaired; 689/690 unit tests pass (one existing skip), typecheck/build and three development desktop suites pass. [Acceptance record](../records/reviews/three-agent-acceptance-2026-09-21.md). Next: reproduce output-storage failure recovery and retain process/watch bookkeeping until durable terminal admission. Mixed-provider chains, packaged acceptance and the C8 user-run Colab pilot are not established by this test. |
| Communication pipeline (comm-pipe-1..3) | VERIFIED_LOCAL on dev and packaged builds through rev-4 (2026-09-26); two targeted coverage gaps remain | Planning and result-analysis pipelines mint request-scoped hop sets; the terminal hop seals, AWAITING_DECISION binds the decision to the verified receipt, and `request.pipeline.decide` is idempotent and refuses stale hashes. 2026-09-24: both pipelines ran live end to end with a mixed Claude/Devin roster, and real Approve and Request-revision decisions were bound to verified receipts, after nine defects were fixed ([acceptance record](../records/reviews/office-live-acceptance-2026-09-24.md)). 2026-09-25 round `findings-rev-2` (head `7a4153c`): planning packets now blind `withheldPaths`; REVISE auto-mints a linked revision request whose brief inherits verified prior-round outputs and the decision note; pipeline cards carry a per-hop Observe/Retry/Cancel table with verified output previews and a named cancel confirmation; pre-launch failures settle FAILED with `lastObservation`; stored agent outputs and pipeline reviews are visible in Artifacts/Reviews. 2026-09-25 packaged acceptance round 3 on the taskbar install: planning + result-analysis pipelines ran live on real userData with dead-spawn retry, transient auto-retry, stranded-receipt reconcile and hash-bound decisions all exercised ([acceptance record](../records/reviews/office-live-acceptance-2026-09-25.md)). 2026-09-25 (same day): REVISE end-to-end, cancel cascade/dialog and withheld-path blinding all exercised live on the packaged install — verified. 2026-09-26 round `findings-rev-4` (head `4c113ad`, packaged acceptance round 4): request-form `analysisOf` no longer silently binds the newest plan — the select defaults to an explicit "None" and the link is emitted only on a real pick; dialog/card controls carry unique accessible names (label-wrapping collision fixed); `request.create` rejects a CANCELED `analysisOf` target; `npm test` bounded to `--test-concurrency=4`; `desktop.mjs` gained `reopen` for rejected slots. 904 tests — 903 pass/0 fail/1 skip; tsc + build clean; packaged check on `App\` (`app.asar` `44091982…`) verified all three behaviors live. Open: the formal C8 S3 run-package/return pilot; hosted-provider execution remains gated; provider effort/tool claims remain unverified beyond what the session result reports. |
| M-memory workstream (office-mem-1/2) | VERIFIED_LOCAL; external engines NOT_STARTED | Append-only finding/relationship ledgers, per-hop authorized memorySearch and digest mount (plan-synthesis/analysis-finalize only), Memory page graph/search/links, archive export and an evaluation harness with the Office baseline. Merged via PR #8/#9. Memory is office-recorded self-report, not verified fact. 2026-09-24 packaged-app audit: graph overlap, hidden search focus, stale notice and the missing Opus 5.5 option fixed on `fix/memory-page-bugs-20260924`. |

Status vocabulary: NOT_STARTED, IMPLEMENTED_FOUNDATION, IN_PROGRESS, PARTIALLY_VERIFIED_LOCAL, BLOCKED_EXTERNAL, VERIFIED_LOCAL, VERIFIED_HOSTED. PARTIALLY_VERIFIED_LOCAL means some tested code exists but parent acceptance is not met; list exact open subitems. PARTIALLY_IMPLEMENTED means the larger program still has unimplemented contracts/UI/tests. The latter requires actual provider evidence for the exact scope. A local test cannot advance a hosted gate. Keep this table in the same file.

| Item | Current status | Evidence / next action |
| --- | --- | --- |
| R0 | VERIFIED_LOCAL | Repaired 2026-09-08. Confinement now reads scoped DELEGATION_CONTROL evidence instead of the request's delegation flag; controller clock injected into readiness and into five test fixtures. 175/175 unit tests passed at that round; the current full-suite baseline is 382/382 (section 12.1). |
| R1-A | VERIFIED_LOCAL | Done 2026-09-08. Main handler refuses office:verify-transport before tool-path lookup, account observation, adapter construction or directory creation; the Settings live-create flow and its state are removed; bridge regression proves repeated direct calls reject with no connection, capability or event change. |
| R1-B | VERIFIED_LOCAL, action still contained | Done 2026-09-08. Real one-commit fixture through the ordinary R2 route, durable intent written before any provider contact, receipts persisted immediately, unresolved attempts refusing duplicates across restart with staging retained for reconciliation, framed receipt contract re-derived from section 13, honest model scope and classified failure metadata. R1 step 6 remains external. The Verify action stays contained pending R5. |
| D0 developer map | VERIFIED_LOCAL documentation | Section 1.3 map regenerated 2026-09-28 against `origin/main` as a module table without hash fingerprints; the 2026-09-08…12 hash tables are archived. |
| D2 parallel coding setup | VERIFIED_LOCAL tooling; desktop/provider sessions NOT_STARTED | 2026-09-13: the fixed local desktop state machine and detailed Session 1–7/Session 8 manual supplement the general worktree protocol. Four coordination tests pass, including seven simultaneous starts, atomic publication, role/path binding, immutable round hashes, stale review/head refusal, exact-SHA submission, scope enforcement, rejection, integration, close and next-round preservation. The eight prepared local worktrees under `quant-team-sessions/prepared-20260912` were fast-forwarded to setup commit `236ccda4817fcf5320e4ee95389af34bcb92dd46`; setup was run twice, all role/status checks returned the correct clean checkout and `NOT_READY`, and no product round was published. Installing ignored role files does not launch or authenticate a session. The merge policy now authorizes Session 8 to merge only its closed-round integration PR after current-main ancestry, exact-head `verify` success and conversation-resolution checks; direct main pushes and raw-token workarounds remain prohibited. The prior fresh locked install, typecheck, 382/382 application units and build passed in the setup worktree. GitHub main protection requires a strict `verify` check, PR, resolved conversations and admin enforcement, with no force-push/deletion. CI results are on [setup PR #1](https://github.com/louiskim132/Quant_Office/pull/1). Claude Code 2.1.270 reported a signed-in subscription; Codex saved-project path remains the parent folder; Devin browser was signed out and its repository grant/model choice remain unverified. Update 2026-09-14: the desktop workflow has since run two product rounds (list-views-001, ui-refresh-001) in batch prepared-20260912, integrated and merged through PR #2; a fresh batch (next-batch-001) is provisioned on the merged base for the next round. |
| D1 optional Serena trial | PARTIALLY_IMPLEMENTED, nonblocking | Project-local AGENTS.md and CLAUDE.md pointers plus the Git/worktree policy were added during repository setup on 2026-09-12. The optional Serena comparison and client configuration remain NOT_STARTED; no navigation plugin was installed. |
| C10 four-plugin office evaluation | MEASURED_LOCAL 2026-09-25 (CLI A/B, scratch installs); no plugin enabled by default | 2026-09-16: section 3.2 and C10 define the trials and `app/benchmarks/plugin-evaluation/`. 2026-09-25: Serena 1.7.0, Ponytail v4.10.0, Graphify 0.9.68 and LightRAG 1.5.7 (Ollama local) trialled alone and stacked on an office implement packet and a 7-item code-navigation task. No plugin or pair saved tokens beyond run-to-run noise; Serena adds ~8.7k tokens per call and is unused unless hinted; stacking adds context and lowered accuracy; LightRAG local indexing failed (5 of 11 files timed out in 2 h). Recommended set: office memory ledger only. See section 17 entry "plugin trials" of this date. |
| Token diet (pipeline token consumption) | VERIFIED_LOCAL on dev + packaged build; merged via PR #13/#14 (2026-09-25 local) | Branch `fix/token-diet-20260925` (base organizer `9356c2e`). Lean Claude/Codex launches, per-hop deliverables, hop-keyed inherited inputs, worker slices, packet essentials + `finish.py`, split contract, pre-registered analysis plan (`analysisOf`), QUICK round shape, implementation-only REVISE, claude launch spacing. Live: quick ema5 round 574k input tokens (was 2.50M), implementation-only revision 345k (was 3.10M), Codex implement 147k (was 374k). App\ `app.asar` `642139F3…`. Plugin trials done (C10 row). Follow-ups done on `fix/evidence-and-memory-20260925` (PR #14): evidence-surface args documented; memory capture restored and digest mounted at `plan-brief`. App\ `app.asar` `0901A8DF…` — see section 17 entries of this date. |
| Commercial launch readiness | IN_PROGRESS — coded series merged through LR-17 (`90c0e45`); L2 closed (openMs 92–132 ms); LR-16 v1 real acceptance passed 5/5 on 2026-09-29 (PR #46); LR-16b (subscription sign-in under QRO-Agent) is required by D-6; provider-terms legal review handled by a separate reviewer outside this project | Private/internal beta only. Merged 2026-09-27 as SWE-2 Max packets on protected main: LR-0 `e0ce5d9` (PR #18), LR-1 `232f273` (#21, packaged e2e in CI), LR-3 `54fd5be` (#23, PROMPT.md long prompts), LR-4 `c3a8a2a` (#24, local-first defaults + risk consent), LR-5 `36ff06e` (#25, inputs-as-data prompt boundary), LR-6 `ef2779a` (#26, projection compaction + schema 4 + downgrade tool), LR-2 `608ea06` (#27, crash diagnostics + bounded local log), LR-11 `fe00e4a` (#29, accessible-name e2e guard), LR-9 `fa3ac70` (#28, plain provider status in Settings), LR-14 `a54f29d` (#30, light default theme via schema 5), LR-10 `7b928c5` (#31, unified format.ts), LR-7 `abbe9a1` (#32, loading window), LR-15 `b4c71ec` (#34, API-key mode, safeStorage/DPAPI, schema-free), LR-17 `90c0e45` (#35, integrity checkpoint via schema 6 — open replays only the post-checkpoint tail and a chunked background full verify advances it; `bench-store.ts 1000` openMs 132 ms closes L2). LR-16 launcher follow-up PR #40 merged 2026-09-28 as `ba9b72d`; exact-head verify passed. Launch gates: LR-16b is open, and provider-terms legal review is user-owned. Signing/installer/updates/fuses and clean-machine release validation stay deferred under D-3. `App\` mirrors `ba9b72d` (asar `4CF93A09D322A6CF4EBE6171A5514E895C6B782E94CA540ECCDBF8C502CADB8D`). |
| OmniRoute routing extension | NOT_STARTED implementation; architecture reviewed 2026-09-11 | Section 3.1 proposes operation-specific model/session/research contracts and an optional bounded free-worker route. Current subscription-only runtime policy remains unchanged; no gateway installation, provider transfer or live compatibility test occurred. Integrate with C2/C4/C7 and retain R5/custody requirements. |
| R2 | VERIFIED_LOCAL within documented limits | Snapshot/output inventory is shared by backup and restore; both formats restore actual bytes into a new root. OutputService reserves real destinations on prepare/launch and stores versioned verified bytes. Required missing objects refuse backup. Snapshot identity rejects null/wrong request revisions. Remaining constraints: source swap races, recorded-platform Git reconstruction and R5 transport limits. |
| R3 | VERIFIED_LOCAL | Preserve exact per-operation scope, durable evidence order, independent confinement and frozen account context. No new live capability evidence in this pass. |
| R4 | VERIFIED_LOCAL | Local lifecycle/output repairs and all-handler restore admission verified by V1 on 2026-09-08; see section 5.2. The earlier approval-review interruption is historical. No live-provider or packaged-release claim. |
| R5 | BLOCKED_EXTERNAL / capability incomplete | 2026-09-12 CLI reconciliation: session_01Aj1hpgmeoZLdgYVR9eQ6PB is live and accepted a non-interactive follow-up (provider "Sent to cloud session" receipt), but interactive attach is refused account-wide ("not enabled for your account") and no CLI read route returns session output. Outcome reconciled at USER_REPORTED level: web transcript shows the fixture ran to completion (proof.json = {"fixture":"qro-cloud","status":"ok"} in /home/user/repo), env "Default" hibernates/resumes, Sonnet 5/Medium selectors visible, and web stop produced "stopping..." -> "stopped". Missing for R5: programmatic observe/retrieve/cancel routes - CLI can create and send but not read output or cancel; interactive attach is account-gated. Details: app/test-output/claude-cloud-spike-SP2mlL/reconcile-2026-09-12.json. Section 5.3 still governs remaining steps. Scope clarified 2026-09-14: R5 gates automated hosted agent-session dispatch only; it does not gate the manual experiment run or the C8 pilot, and readiness is reported per the split in section 5.3. |
| C1 | VERIFIED_LOCAL | Completed 2026-09-08. Research schemas, narrow commands, S0–S10 reducer, lineage counters and forecast/exposure bookkeeping in shared/research.ts and core/store.ts; nine exit tests in tests/research.test.ts. |
| C2 | VERIFIED_LOCAL; provider token comparison BLOCKED_EXTERNAL | Evidence retrieval, grants, cache invalidation and exact-source expansion remain verified. Section 8.4 measured local retrieval on 137 objects recovered all seven planted defects in both policies; actual byte/latency results are in section 12.1. Provider token/model counters remain unknown. |
| C3 | VERIFIED_LOCAL | Completed 2026-09-08. shared/research-contracts.ts, shared/research-diagnostics.ts, core/research-gates.ts, main/research-templates.ts, the inspectResearchPackage importer in main/artifacts.ts, versioned templates and a hand-computed golden fixture under app/research-templates/, tests/research-gates.test.ts (19) and tests/research-import.test.ts (7). 287/287 unit tests, typecheck, build, desktop and revision-desktop suites pass. No dataset performance claim. Realignment note 2026-09-14: the versioned templates become contents of the user-run package under the corrected contract; "hosted job template" describes an optional separately scoped route, not the required path. |
| C4 | VERIFIED_LOCAL against its implemented contract; contract revised 2026-09-14 | Completed signed independent-runtime admission and S2/S7 delivery/review/rebuttal/adjudication machinery. End-to-end synthetic workflow reaches S10 through real application services; no provider-authored gate approval or live isolation claim. See section 12.1. The 2026-09-14 alignment review found the implemented contract exceeds the corrected product contract: mandatory signed-runtime/harness admission is now the stronger evidence tier, not the prerequisite. C8 revises gate contract and implementation together; current code still refuses S2/S7 without a configured runtime and rewrites unsigned PASS reports to BLOCKED. |
| C5 | VERIFIED_LOCAL; real custody BLOCKED_EXTERNAL and separately scoped | Application registration/reserve/evaluate/export/import paths, exact S8 result admission, nonrollback journal/checkpoints and durable result recovery verified with synthetic custody. Real evaluator/access isolation and R5 are not established. Realignment note 2026-09-14: manual user custody is the default S8 route for the pilot; a manual holdout return is labeled user-run, never independently custodial. An independent custodian remains a separately scoped capability for stronger claims. |
| C6 | VERIFIED_LOCAL | Durable shadow/quote/simulated-fill ingestion, separate actual execution provenance, lifecycle/coverage, G-SHADOW binding, renderer panels, negative-result reuse and research export integrated. Software evidence only; no trading permission. |
| R6 / C1–C6 | VERIFIED_LOCAL; VERIFIED_HOSTED blocked | Local staged research contracts and integrated independent-runtime fixtures complete. Actual external provider isolation, signed authority provisioning and real custody remain required before live automated acceptance — those are separately scoped capabilities under the 2026-09-14 contract, not prerequisites for the C8 manual pilot. |
| C7 | VERIFIED_LOCAL; provider experiment BLOCKED_EXTERNAL | Current-source UI, paging, scale/retrieval measurement, migration/backup/recovery and fresh packaged/native acceptance complete. The final full suite passed 382/382 on the packaged revision's source, after a consolidated 370/382 run and targeted repairs. No measured provider token or model-quality claim. |
| R7 / C7 | VERIFIED_LOCAL | Canonical activity/readiness, scoped paged views, stable room/seat placement, integrated research/monitoring UI and current-source packaged/native acceptance verified. |
| Roadmap consolidation | VERIFIED_LOCAL documentation | Comment/report evaluated; one active roadmap; old entry points redirected. Local links/anchors, fences and complete R0–R7/C1–C7/S0–S10 inventory checked. No source implementation or new application test run in this consolidation. 2026-09-28: history split — superseded status paragraphs, completed packet texts and log entries before 2026-09-27 moved verbatim to `docs/history/roadmap-archive-2026-09.md` (6,221 → about 1,250 lines; lossless check passed); redirect stubs removed and historical design documents moved to `docs/history/`. |
| C8 manual-pilot realignment | VERIFIED_LOCAL; user-run pilot intent satisfied live 2026-09-25 | Round c8-impl (2026-09-15) implemented the corrected contract end to end: shared RUN_PACKAGE/RUN_RETURN schemas and tiered gate provenance, store admission (bound return identity, closed inventory, conflict/idempotency, durable AWAITING_RETURN), S3 as the user-run stage with office stages for S5/S6/S8/S9/S10, runtime-free separated S2/S7 review, the five-capability readiness split, the real zip codec (`main/run-package.ts`, fflate) shipping `launcher.v1.py`, the stdlib-only Colab launcher producing `run-return.zip`, renderer export/await/import/validate controls, and organizer wiring of the codec into buildPipeline. Combined verification: typecheck clean, 408/408 unit tests, build clean — including a full S0→S10 journey on user-run evidence alone. Two worker packets were blocked by an organizer-owned separated-review staging defect (fixed at c75d589) and their committed deliverables were integrated by cherry-pick. Pilot intent satisfied on the packaged install 2026-09-25 (acceptance round 3): ema3 planning APPROVE `6ee27338` → the user's own Colab run of the office-verified `ema3.py` → imported return `ema3_result.csv` (user-run provenance; byte-identical to local ground truth) → result-analysis APPROVE `31c2b22c` with unanimous CORRECT — `records/reviews/office-live-acceptance-2026-09-25.md` and the dated entries of that day. Remaining follow-up, separately tracked rather than a C8 blocker: the formal S3 run-package/run-return live pilot (durable AWAITING_RETURN plus live wrong-package/incomplete/corrupt/duplicate return rejections) — named C8-S3; the acceptance record itself notes the ema3 cycle replicates the C8 pattern but is not the formal S3 pilot. The packaged desktop suites were re-run against the built app on 2026-09-15 — pipeline.desktop, revision.desktop, packaged-native (real node-pty I/O) and desktop.e2e all pass after correcting stale old-contract assertions. |
| C9 local CLI office agents | PARTIALLY_VERIFIED_LOCAL | Established 2026-09-16 from the 2026-09-15 user direction. CLI probes on this machine verified the surfaces the contract names: devin 3000.10.21 (auth status, models list, acp stdio server with tool-scoped agent types, -p), codex 0.154.0 (exec --json --sandbox -C, resume/fork, existing app-server account/read+model/list), claude 2.1.273 (-p with --output-format/--allowedTools/--model/--effort; no model catalog — curated aliases remain). devin CLI is not currently logged in; its credential is separate from the Desktop session. Landed in round c9-impl: 'devin' provider with real CLI discovery (auth status + `models list --format json`, DEVIN_* env stripped, no API-key fallback), Agent.execution/toolProfile persisted with a pre-C9 hosted default, LOCAL routes/transports/operation evidence, LOCAL_DISPATCH readiness family scoped by route (hosted evidence never satisfies a local scope or vice versa), AssignmentController per-route adapter resolution that fails closed on a miss, LocalMailboxAdapter (hash-manifested packet out, hash-verified result.json + artifacts back, honest cancel sentinel) wired for local agents, renderer execution-environment/tool-profile surfaces and Devin option, and workflow/evidence docs. Verification: typecheck clean, 430/430 unit, build clean. Evidence bootstrap f779ecd (2026-09-16): store.recordTransportEvidence merges office-observed entries into capability snapshots (route stamped, scope-key supersession, ACCOUNT_VERIFIED refused); LocalMailboxAdapter exposes submit/observe/cancel evidence hooks and result.json applied-model/effort/delegation self-reports; verified() is family-aware so office-observed TOOL_SUPPORTED satisfies only local scopes while hosted scopes keep requiring provider attestation; dispatch routes LOCAL_* through assertLocalExecution and records UNKNOWN + the office-created session identity. Verification at f779ecd: typecheck clean, 446/446 unit, build clean. Open items before first-milestone acceptance: the user-run pilot — sign in the Devin CLI, add a local Devin agent → packet written (first LOCAL_* OBSERVED evidence accrues) → user-run session → verified outputs → cancel → restart non-duplication. CLI-exec/ACP transports and local Claude/Codex providers are still unimplemented. |

## 12. Validation evidence

The evidence records that stood here (12.1 final C4–C7 verification, 12.2 independent confirmation audit and 12.3 earlier slice boundaries, all 2026-09-12) are archived. Current verification evidence is recorded with each dated entry in section 17 and on the `verify` check of each PR: the newest entry states the full-suite, typecheck, format, build and packaged-e2e results for the commit it describes.

## 13. Existing cloud fixture — historical evidence, not a new authorization

The transport discovery, the fixture and its one created session, and the Windows sandbox detail are archived verbatim. They authorize nothing; R5 (section 5) governs any new hosted operation.

## 14. Commands, tooling and release protocol

Run application commands from `app` with Node 24.19.0 and the locked pnpm dependencies. If `node` is not on `PATH`, use `C:\Program Files\nodejs\node.exe`. The commands that stood here until 2026-09-28 are archived.

~~~powershell
pnpm install --frozen-lockfile
pnpm format:check   # Prettier, width 120 (LR-0)
pnpm typecheck      # tsc over src, tests and scripts; unused locals and parameters are errors
pnpm test           # every unit test: tsx --test --test-concurrency=4 tests/*.test.ts
pnpm build          # node scripts/build.mjs
pnpm package        # node scripts/package.mjs
~~~

CI (`.github/workflows/verify.yml`) runs the coordination tests (`node --test tools/parallel.test.mjs tools/desktop.test.mjs`), then the locked install, format check, typecheck, unit tests, build, package and the packaged desktop e2e. To run the packaged e2e locally after `pnpm package`:

~~~powershell
$env:QRO_EXECUTABLE = "$PWD\release\Quant Research Office-win32-x64\Quant Research Office.exe"
pnpm exec tsx tests/desktop.e2e.ts
~~~

The other desktop suites run on demand against a packaged or development build: `tests/revision.desktop.ts`, `pipeline.desktop.ts`, `pipeline-request.desktop.ts`, `office-chat.desktop.ts` and `packaged-native.desktop.ts`. `tests/agents.e2e.ts` and `tests/three-agent.live.ts` use real accounts and run only when a task explicitly authorizes them. The store benchmark is `pnpm exec tsx scripts/bench-store.ts 1000`; opening must stay under 3 s.

Release protocol: after an integrated change touching `app/`, rebuild and repackage, confirm the installed app is closed, mirror `app/release/Quant Research Office-win32-x64` into `Quant Office/App/`, and record the SHA-256 of `App/resources/app.asar` in the dated entry.

Changes to `OfficeAPI` require the shared types, preload, main-handler validation and the bridge-key list in `tests/desktop.e2e.ts` together. Persisted schema changes need a migration, a backup copy before migrating, and replay checks (section 1.1). For documentation-only edits, validate links and anchors; do not rebuild or claim tests that did not run.

## 15. Source and rationale register

- Prior source audit: 2026-09-08; raw unit log linked in section 12. Findings are source-inspection defects unless explicitly reproduced by that log. Revalidate after implementation changes.
- Token Optimization conversation: task 01a07fcc-7bd4-7b92-87be-d7be92ddbaf0, including later September 8 messages at 10:46–10:53 UTC about repeated source reading, shared developer context and Serena. The task reader returned empty items for those last two turns; their visible user/assistant messages were recovered from the matching local session record. Sections 1.3–1.4 incorporate them. Earlier blanket deferral of navigation plugins is scoped to the product pipeline; a developer trial is now explicit and nonblocking. No hidden reasoning was used.
- Token-optimization report: C:/Users/louis/Desktop/Codex/token-optimization-revision-report.md, dated 2026-09-08. Numeric rankings are conceptual opinions. Section 3 incorporates the accepted decisions; optional named tool maturity/compatibility was not benchmarked.
- User-supplied staged-team comment: evaluated in section 2; its fixed model hierarchy, forced conclusions, universal trading thresholds and shadow-slippage claims are not adopted as facts.
- Technical primary sources are linked next to their supporting rationale in sections 2–3. Financial/statistical methods and provider behavior must be checked against primary documentation when implemented; no source establishes profitability or a guarantee of zero missed findings.

This roadmap is sufficient to continue in another conversation: start at section 1, execute the next open item, record the result in section 17 and the matching section 11 row, and preserve evidence. The intended end state is a reliable research controller with traceable evidence and selective context. Capital execution requires a separate, explicitly authorized system.

## 16. Original 0.4 audit — historical appendix

Archived verbatim. The findings describe the September 7 review, not current implementation status.

## 17. Dated progress log

Newest entries are last. Entries dated 2026-09-15 to 2026-09-26, and the section 11 entries before 2026-09-15, are archived verbatim in [history/roadmap-archive-2026-09.md](history/roadmap-archive-2026-09.md).

### 2026-09-27 — Organizer 8.2 progress audit and revision-plan correction

Scope: read-only inspection of Devin session `glowing-thunder` (title `Quant_Office - Organizer (8.2)`), batch close records, fetched `origin/main`, GitHub PR/CI state, source and package hashes. Documentation changes only, on `docs/organizer-review-20260927`, base `0cfc1b9739d59e5118d2191c8b31f7a37347f947`. This is a review date, not an implementation completion date.

**Why progress appeared stopped.** The last saved Organizer response (2026-09-26 16:34 PDT) ends normally and asks whether to hold or do another targeted acceptance pass. `current.json` says findings-rev-4 CLOSED; its close record names organizer head `2c175f9`. PR #16 and #17 are MERGED, and the inspected PR #17 verify checks passed. No worker or merge blocker is evidenced. The session database contains 7,381 message nodes (including duplicate records); this is not 7,381 user turns and does not by itself prove a UI performance cause. No session restart, message dispatch or process termination was performed.

**Completed and checked.** Rev-3 fixed the briefing retry/Observe controls, typed withheld paths, attempt/superseded-output labels and regression coverage. Rev-4 fixed silent newest-plan selection in the request form, accessible-name collisions and the canceled-plan create guard. Its close record reports 904 tests / 903 pass / 0 fail / 1 conditional skip, clean typecheck/build, and packaged form checks. The installed App and organizer release app.asar hashes were independently recomputed and match `440919823ADF0C11ADA9569C4D0F09BF5265D22B2F94D4A717574BC4F33045D2`. These tests were reported by the organizer and corroborated by CI; this audit did not rerun the unit suite or live acceptance.

**Open issues and revised order.** An empty findings-rev queue does not mean the C11 defect backlog is empty.

| Priority / owner | Next action | Completion evidence |
| --- | --- | --- |
| Next implementation — coding worker | Run LR-0 alone from current main; then organizer RA re-anchors every remaining packet on the merged formatted commit. | Fresh before/after unit baseline, typecheck/build, format CI, then an actual `Re-anchored on <commit>` line. Do not write that line before RA happens. |
| First functional follow-up — LR-1 | Repair desktop e2e copy/bridge expectations and enable Windows desktop CI. The current source still has bridge keys absent from the test snapshot. | Packaged e2e passes and runs in CI; passing unit CI alone does not close this. |
| Reliability — LR-2 / LR-3 | Add crash diagnostics and handle long Windows CLI prompts according to the existing packets after RA. | Crash/recovery and long-prompt regression evidence, plus standard checks. No new runtime reproduction is claimed here. |
| Startup — LR-6 → LR-7 → LR-8 | Compact the disposable catalog projection without altering history; show the loading window before store work; measure startup. Source still constructs OfficeStore before BrowserWindow. | Scratch-workspace round-trip/downgrade tests and repeated startup measurements. The reported 166-second launch may include host contention; it does not rule out the separately measured store/startup defect. Never reset live data to improve timing. |
| Coverage — desktop organizer | Exercise typed withheld-path entry in the packaged UI against scratch data: save a directory prefix, reload, verify persistence, remove it, and confirm BLIND excludes / FULL includes the expected files. | Exact build hash, UI actions, saved state and packet-path evidence. Existing packet-blinding checks do not prove this new editor was exercised. |
| Coverage — desktop organizer | When a live provider test is explicitly authorized, exercise two Claude test agents launching in one phase. | Record agent/model/effort, actual spawn timestamps, at least the configured four-second spacing and completion/recovery results. The one-Claude QUICK roster cannot close this gap. |
| Remaining C11 packets | None; LR-0…LR-11 and LR-14…LR-17 are merged and development exit criteria are met. | Launch gates remain LR-16b (D-6; the v1 real acceptance passed 2026-09-29, PR #46) and counsel's provider-terms decision. Fail-closed evidence evaluation is covered; D-3 stays deferred. |
| External/user gates | Keep C8 manual Colab return, R5 hosted evidence, LR-16b (isolated agents on the user's subscription, D-6) and provider-terms legal review separately tracked. | LR-16 v1 acceptance passed 2026-09-29 through the in-app Check isolation action (the DPAPI credential stayed synchronized) and counts on `main` once PR #46 merges; the legal source packet does not substitute for counsel approval. Their own evidence; none is closed by local tests. Signing/installer/updates/fuses remain deferred under D-3. |

Do not publish findings-rev-5 without a reproducible new defect. Scratch acceptance can proceed independently of formatting, but it writes scratch state and may launch agents: it is not literally read-only and does not authorize live-data mutation or paid/provider runs. Any resulting code packet should be based on the formatted main after RA.

**Planning defects corrected.** Section 11 incorrectly said packaged live acceptance was NOT_STARTED and token-diet work was not merged. Both are now reconciled with the dated evidence. Organizer's last response also described C10 trials as still requiring installs, but the C10 row records completed local trials on 2026-09-25; do not repeat those installations merely to clear an obsolete checklist. An existing uncommitted C11 draft in `Worktrees/c11-after-rev4/docs/ROADMAP.md` was inspected and left intact. Useful sequencing/base updates are reflected here, but its unverified claim of an independent full-suite run and its assertion that chat length caused slowness are not adopted. This branch is a proposed canonical-roadmap update pending integration; it does not change the live desktop batch's state or start an LR worker.


### 2026-09-27 — LR-0 implementation and targeted acceptance follow-up

User requested remaining work. LR-0 is implemented on `chore/lr0-prettier` in `Worktrees/lr0`, based on `0cfc1b9`; [PR #18](https://github.com/louiskim132/Quant_Office/pull/18) targets main. Status is IN_PROGRESS, not merged or released. Setup commit `f2c6195` pins Prettier 3.9.9, formatting commit `1a1a55f` reformats 212 source/test/script files, `333a400` adds format CI and blame-ignore metadata, and `97d1d58` adds LF checkout attributes after CI exposed Windows CRLF restoration. The formatting pass preserves one existing untyped-import suppression using `prettier-ignore`; no runtime logic was changed. A second format pass was needed for stable output.

Fresh local validation: unformatted and formatted suites both report **904 tests, 903 pass, 0 fail, 1 existing conditional skip** (397.8 s and 563.4 s respectively). Frozen-lockfile install, typecheck, format check, build and package passed. Packaged sidebar acceptance visited Office, Agents, Projects, Reviews, Artifacts, Memory, History, Usage and Settings in a fresh scratch workspace with zero renderer errors. Package app.asar SHA-256: `12AC44C80B93DEE38C02BCFBB0E83F99ACDAC69A92AB1E87289BA39A85B94F8D`. The installed App and live workspace were not changed. The first CI run failed format due to CRLF checkout; the LF-attribute follow-up is awaiting CI. Do not mark LR-0 complete until the exact latest PR head passes and is reviewed/merged.

Targeted acceptance:
- **Typed withheld-path editor: UI gap closed locally.** In the packaged build, created a synthetic project, selected a scratch folder, typed `results/`, added/saved it, observed normalized `results` in state, reloaded/reopened the project and verified the visible entry, then removed/saved it and verified an empty withheld set. Zero renderer errors. The first driver attempt omitted reopening the project after reload; the corrected run passed. The full unit run independently passed BLIND/FULL packet tests; no new end-to-end provider blinding run is claimed.
- **Two-Claude launch spacing: production-adapter live evidence now available.** Claude Code 2.1.280; agents Test PM A and Test PM B; requested model alias `opus`, effort `low` (requested settings, not an independently verified model identity). Concurrent handoffs through the production LocalCliExecAdapter spawned 4,005 ms apart, exceeding its 4,000 ms setting. Both completed and their synthetic role/nonce reports were stored and hash-verified. This was two independent assignments in a scratch OfficeStore, not a full packaged pipeline DAG; retain that narrower remaining UI/DAG coverage distinction. No paid API fallback or research execution.

Evidence retained locally under `Worktrees/lr0/app/`: `baseline-lr0.log`, `formatted-lr0.log`, `test-output/lr0-sidebar.json`, `test-output/withheld-ui.json`, corresponding screenshots/drivers, and `test-output/claude-gap-live-2026-09-27T18-49-47-555Z/acceptance.json`. Scratch data remained outside the live office workspace.

Next: exact-head CI and independent review/merge of PR #18, then organizer RA on the actual merged commit, then LR-1 onward. C11.0 prohibits a coding worker from merging its own PR and gates later LR packets on the merged re-anchor. This review has not bypassed those gates or started unrelated packets.

### 2026-09-27 — LR-0 merged; C11 re-anchored (RA) and prototypes re-verified

Organizer (Claude Opus) reviewed PR #18 against LR-0's "Done when": the format commit `1a1a55f`
touches only `.ts/.tsx/.css/.mjs` files under `app/src`, `app/tests` and `app/scripts`;
`.git-blame-ignore-revs` names exactly that commit; Prettier is pinned to `3.9.9`; the one
`prettier-ignore` keeps an existing `@ts-expect-error` on its diagnostic; `.gitattributes` forces
LF only on formatter-covered paths; CI `verify` (including `Format check`) passed on head
`97d1d58`. Merged as `e0ce5d9`. PR #19 (this roadmap reconciliation) was brought up to date with
`main` and carries this entry.

RA (C11.0 rule 0), on `e0ce5d9`:
- Rewrote every stale `Find` text in LR-1…LR-14 to the formatted code (LR-2 `main.ts`, LR-3 test
  adapter call, LR-4 `agents.tsx`, LR-6 `store.ts`/`types.ts`/`connections.test.ts`, LR-7
  `build.mjs`/`main.ts`, LR-9 Settings row, LR-11 e2e, LR-14 `blank()`, `core.test.ts` and the
  40-row CSS table with Prettier's value spelling). A script applied each code packet exactly as
  written to a scratch copy; every anchor matched once.
- Results with LR-1…LR-7, LR-9 and LR-14 applied together: format check and typecheck clean;
  full suite **917 tests, 916 pass, 0 fail, 1 skipped** (904 + 13 new); packaged desktop e2e
  3 of 3 after the LR-7 fix below. LR-1 alone on `e0ce5d9`: e2e 3 of 3; the missing bridge keys
  are still exactly the four listed.
- **Defects found in the plan and fixed:** (1) LR-7's `void win.loadFile(loadingHtml)` raced the
  real UI load — the e2e's first screenshot timed out in 3 of 4 runs; `await …catch(() =>
  undefined)` passed 3 of 3, and without the loading page 3 of 3. (2) LR-11's check used
  `innerText`, which is empty for some labelled buttons ("Save request revision", "Prepare Claude
  handoff") and gave false failures, and was inserted before the first app close, which broke the
  later backup step. It now uses `textContent` at the last close; with that, no visible button on
  the nine pages lacks a name, so LR-11 is a regression guard. (3) LR-4 now also stops a provider
  switch from resetting the environment to hosted (new step 3).
- Earlier acceptance recorded above (withheld-path editor UI, two-Claude spawn gap of 4,005 ms)
  stands; RA did not repeat live provider runs.

Next: LR-1 by the coding model (C11.K prompt with `LR-1`), then the C11.1 order. The desktop
batch stays on hold unless a new reproducible finding appears; any new round branches from
formatted `main`.

### 2026-09-27 — Status reconciliation: C8 pilot intent satisfied; Codex implement-hop transport verified-local

Documentation-only corrections to section 11 on the formatted main; no product code changed.
Two stale claims reconciled against the dated evidence.

**C8 — user-run pilot intent satisfied.** The section 11 row's "user-run pilot pending" was
stale. The 2026-09-25 packaged acceptance round 3 ran the pilot shape end to end on the
taskbar install with real userData: the "Write ema3 code" planning round (APPROVE bound to
`6ee27338`) → the user's own Colab run of the office-verified `ema3.py` → import of the
returned `ema3_result.csv` (user-run provenance; byte-identical to the local `--seed first`
ground truth — pandas `ewm(span=3, adjust=False)` parity, 98/98 rows, identical time order) →
the "Analyze ema3 results" round (every stage independently CORRECT, APPROVE bound to
`31c2b22c` through the hash-checked decision chain). Evidence:
`records/reviews/office-live-acceptance-2026-09-25.md` plus the 2026-09-25 entries above. That
satisfies the C8 pilot intent — the office produces, the user runs externally, the office
verifies the return and a bound decision lands. The C8 row and slice header are updated
accordingly.

Named follow-up — **C8-S3 live run-package pilot** (separately tracked, not a C8 blocker): the
formal S3 RUN_PACKAGE export → durable AWAITING_RETURN → bound RUN_RETURN import stage machine
has not had a live user run. The same acceptance record states the ema3 cycle "replicates the
C8 *pattern* … but is *not* the formal S3 run-package/run-return pilot"; the live
wrong-package, incomplete, corrupt and duplicate-conflicting return rejections also remain
unexercised.

**Codex local route — VERIFIED_LOCAL for the exercised implement-hop transport scope.** The
2026-09-25 token-diet CLI A/B exercised the office's codex exec argv — the launch surface the
LocalCliExecAdapter builds for `openai` bindings — live on a real implement packet at
gpt-6-astra low: `-c mcp_servers={}`, the CODEX_DISABLED_FEATURES set and `-c
model_reasoning_effort` mapping carried 374k → 147k input tokens and 12 → 7 commands.
Residual limits, recorded here rather than as verification: Codex dispatch variants (other
hop kinds, multi-hop dependency chains), handoff, cancel and failure paths are unexercised
for Codex, and no office-driven end-to-end Codex dispatch has run — an exercised implement-hop
argv is not a verified first-class Codex provider profile, even though the product surface
(`openai` + LOCAL + LOCAL_CLI_EXEC, app-server account observation) exists. Reconciliation:
the section 11 C9 qualification already supersedes the historical row's "CLI-exec
unimplemented" statement; its "local Codex provider unimplemented" residue now names the
unexercised office-driven lifecycle, not absent transport code — the adapter declares
`['devin','claude','openai']` and `mapToolFlags` builds the codex argv.

Next: LR-1 by a SWE-2 Max coding worker (C11.K prompt verbatim), then the C11.1 order.

### 2026-09-27 — LR-1 merged (`232f273`); desktop e2e now runs packaged in CI; worker wave dispatched

**LR-1 by Devin SWE-2 Max** (orchestrator session `593fc35b`, packet
`repo-sessions/next-batch-001/LR_Series/lr1/PACKET.md`, C11.K prompt verbatim). Organizer
review of [PR #21](https://github.com/louiskim132/Quant_Office/pull/21) against the packet's
"Done when": the diff contains exactly the two permitted fixes — the shortened shared-folder
regex and the four re-verified missing bridge keys (`jobOutputPreview`, `memoryGraph`,
`retryPipelineHop`, `searchMemory`) — plus the verbatim `Package` /
`Desktop end-to-end` CI steps and `timeout-minutes` 20→40; only the two packet files changed.
CI `verify` on head `525f926` ran the new steps green ("Desktop end-to-end checks passed.");
the worker reported three consecutive local packaged runs. Branch updated with `origin/main`
(clean merge, docs-only PR #20), verify re-passed on `d18676c` (10m39s), merged as `232f273`.

**Repackage + mirror.** The merged tree (`d18676c` ≡ `232f273`) was built and packaged in the
worker worktree; `release` was mirrored to `Quant Office\App\` (app verified closed first).
`App\resources\app.asar` SHA-256 `12AC44C80B93DEE38C02BCFBB0E83F99ACDAC69A92AB1E87289BA39A85B94F8D`
— byte-identical to the LR-0 package, as expected since LR-1 changed only tests and CI, not
packaged inputs. The previous install's asar `44091982…` (pre-LR0 build) is now refreshed.

**Worker wave dispatched** (one SWE-2 Max session per packet, C11.K verbatim, own
worktree/branch): LR-2 `ce7f6368`, LR-3 `f92bb82f`, LR-5 `dda2d554`, LR-6 `edd27cd3` — all
RA-unblocked with disjoint file sets — and LR-4 `85c25faf`, unblocked by LR-1's merge. Held
for overlapping Find texts rather than dependencies: LR-9/LR-10 behind LR-4 (`agents.tsx`),
LR-11 behind LR-4 (`desktop.e2e.ts`), LR-7 behind LR-6 + LR-2 (`main.ts`), LR-14 behind LR-6
(`store.ts`). Worker note: `pnpm` is absent from PATH on this machine — `corepack pnpm@11.19.0`
is the working invocation (Node 24's bundled corepack; same pin as CI).

### 2026-09-27 — LR-2…LR-14 wave merged through protected route; eight packets integrated

All merges below: SWE-2 Max worker packets (C11.K verbatim, own worktree/branch), organizer review
of the exact diff against each packet's "Done when", `verify` green on the exact head, merge via
GitHub only. Branch protection is `strict` — each branch was updated to current `origin/main`
before merge, so every head verified contains all prior merges.

- **LR-3 → `54fd5be` (PR #23).** Long prompts go through `PROMPT.md` instead of the Windows
  command line; exported verbatim prompt builder + suffix constant; argument-leak regression test.
  `verify` on `d4286e0` 8m59s. Mirror asar `9B74651E91341CF96152D6EEA3C170D134A7604D64F4E9891841FBDE07406C07`.
- **LR-4 → `c3a8a2a` (PR #24).** Add Agent defaults to `LOCAL` + `LOCAL_CLI_EXEC`, provider switches
  preserve execution mode, and Add stays disabled until the unattended-execution risk consent is
  checked (runs under the user's Windows permissions — D-1). Worker packaged check: consent gate
  and local defaults observed in the packaged UI with scratch `QRO_USER_DATA_DIR`. Mirror asar
  `08A946AB6B5C0B59B7D9F569B2A00246393FA0726001265E12E207BAEFA7BC99`.
- **LR-5 → `36ff06e` (PR #25).** Packet prompt now declares everything under `inputs/` (including
  `inputs/inherited/`) as data, not instructions; regression assert added. `verify` on `4beb1d8`
  11m14s. Mirror asar `CE83FFAAADFE54CE06576FC33E95BAAD05712322B0D4B1C303D8B2F0C1F89EED`.
- **LR-6 → `ef2779a` (PR #26).** One model catalog per connection in the disposable projection
  (`modelsOmitted` marker; event log untouched per D-2), `SCHEMA_VERSION` 4, automatic
  `VACUUM INTO` backup before rebuild, `downgradeWorkspaceToV3` + `app/scripts/downgrade-workspace.ts`.
  Worker bench: projection 5,855,685 → 172,643 bytes, openMs 38,289 → 1,016, snapshotMs 732 → 5.7;
  scratch v3 workspace migrated → downgraded → opened by the pre-LR-6 build. `verify` on `1184ba0`
  9m55s. Mirror asar `D8ECB8B054E3F2745283E5341F51DD5016FDF42F493275018019B04C7E4A1DD3`.
  **Incident (recorded, resolved):** the worker once launched the new build without
  `QRO_USER_DATA_DIR`, briefly opening the live workspace (~10 s, migration rolled back on kill).
  Organizer independently verified the live DB: `user_version=3`, 1,416 events, `integrity=ok`;
  safety copy preserved outside Git at
  `Quant Office\Archive\workspace-live-interrupted-v4-migration-backup-20260927.sqlite`. All
  packets now carry an explicit `QRO_USER_DATA_DIR` + `ELECTRON_RUN_AS_NODE` launch rule.
- **LR-2 → `608ea06` (PR #27).** `diagnostics.ts` rotating `main.log` (5 MB × 3, never throws) +
  `describeError`; uncaughtException/unhandledRejection dialog, render-process-gone reload dialog,
  child-process-gone WARN, startup INFO, Help → Open logs folder. The worker's content was
  packet-verbatim but uncommitted when its session stalled; the organizer committed/pushed/PR'd it
  and the worker confirmed the pushed diff byte-identical and filed its full report (908 tests,
  907 pass). `verify` on `3d99140` 10m4s. Organizer packaged check on the merged build: scratch
  `logs/main.log` carried the `INFO start` line and crash hooks fired on termination. Mirror asar
  `08C5825F7DFBFE88F581405476B382B0C3C7697C5F9EB1033E1A3FF5D3FAD676`.
- **LR-11 → `fe00e4a` (PR #29).** Nine-page accessible-name regression guard in the packaged e2e
  (`textContent`, inserted above the last close pair per the re-anchor); step 2 found nothing —
  all sidebar-page buttons already named. Tests-only change; no repackage (LR-1's merge established
  tests are not package inputs — asar unchanged at `08C5825F…`). `verify` on `77c0366` 10m33s.
- **LR-9 → `fa3ac70` (PR #28).** Settings shows one plain sentence per provider (local CLI state +
  "Provider-hosted: not available in this version") above a collapsed "Technical details"; all
  providers now evaluated with `{ execution: 'LOCAL' }`. Worker packaged Playwright check:
  collapsed-by-default, reveals on click. `verify` on `5c187f5` 10m52s. Mirror asar
  `03BD3903EBDE9F42DAE4D1003A87819DEC0061F81087867AFCAE1CC3C2358CE3`.
- **LR-14 → `a54f29d` (PR #30).** Light default theme through schema 5: `blank()` seeds `light`,
  `downgradeWorkspaceToV3` accepts v4/v5 and rebuilds the v3 projection with `dark`; the 40-row
  `office-chat.css` table now follows theme variables (heading bar and shadows untouched). Worker
  packaged check: fresh profile light, Settings toggle to dark and back, chat panel follows. `verify`
  on `35b4592` 10m31s. Mirror asar `EDDC52E463534C7A062608F35E001721F97B1D8393578619785C5765119B2DC1`.
  **User-facing note:** the installed app now carries schema 5 — the next real launch migrates the
  live workspace (v3 → v5) with an automatic `.before-v5-*.sqlite` backup beside the workspace, and
  new/unsettled profiles render light (explicit theme choices are preserved via event history).

- **LR-10 → `7b928c5` (PR #31).** New `app/src/renderer/format.ts` (`UI_LOCALE='en-US'`,
  `formatDateTime`, `formatNumber`); 19 `toLocale*` uses replaced across nine renderer files; the
  five remaining uses all carry format options and are listed in the PR per step 3. Worker packaged
  check: Settings provider cards render the new format, nine pages visited, zero page errors.
  `verify` on `1215b68` 10m53s. Mirror asar `2A11B7393EBFC91BA73BCD6D20C037691102DECC6F70357FBBB2348B2FB1DF3E`.
- **LR-7 → `abbe9a1` (PR #32).** `build.mjs` emits a CSP-locked `loading.html`; the BrowserWindow
  block moved to the top of `start()` (after LR-2's writeLog) so `await win.loadFile(loadingHtml)`
  paints "Opening your workspace…" before the store verifies history; `loadWindowWithRetry` then
  swaps in the real UI. Worker: packaged e2e passed 3/3 (the re-anchor's `await` holds); step-4
  timing observed on packaged builds — loading page rendered at ~390 ms (small workspace) / ~1.3 s
  (600-event), office by ~1.4 s / ~4.1 s. `verify` on `db65a18` 11m49s. Mirror asar
  `A498E677F61206D3F50A27B79AF7BF4ABAB4C2E06037DF1463134F950BF71B88`.

**Known flake under watch:** two independent workers saw the full unit suite stall in
`local-cli-exec.test.ts` when suites ran concurrently — `FSWatcher` rename storms on a removed
session fixture dir; the adapter's session watchers are not disposed before `removeTreeSync`.
Isolated runs pass in seconds and CI is green; tracked as a test-harness bug, not a product defect.

- **LR-8 — measured (no merge; measure-only packet).** Worker ran `tsx scripts/bench-store.ts
  1000` on `abbe9a1` (LR-6 + LR-7 merged):
  `{"observations":1000,"projectionBytes":747045,"writeMs":534208,"openMs":4999,"snapshotMs":12.9}`.
  `openMs` 4,999 ms ≥ 3,000 → **L2 is not closed**; the projection rebuild on open now costs ~5 s
  for 1,000 events even after LR-6 compaction. Per the packet's decision table the organizer opens
  a design packet for an integrity checkpoint: persist (sequence, event hash, projection hash)
  after each full verification, verify only post-checkpoint events on open, run full verification
  in the background. Worker also noted `writeMs` ~534 ms/observation (the write path canonicalizes
  the whole projection per event) — context for the same design.

**Remaining:** every coded LR packet is merged; L2 stays open pending the checkpoint design packet
(organizer work). Launch gates LR-15/LR-16 still require organizer design first; legal review is
user-owned. `App\` currently mirrors `abbe9a1` (asar `A498E677…`).

- 2026-09-27 — LR-15 and LR-17 merged through the protected route; the development-phase exit
  criteria for C11 are now all met (e2e green in CI, `bench-store.ts 1000` openMs < 3,000 ms).
  - **LR-15 (PR #34 → `b4c71ec`, worker SWE-2 Max):** per-provider API-key mode beside the
    existing subscription mode. New `app/src/main/secrets.ts` stores keys in
    `<userData>\secrets.dat` — Electron `safeStorage` (Windows DPAPI) ciphertext, atomic-ish
    tmp+rename writes, fail-closed when encryption is unavailable, corrupt files renamed aside to
    `secrets.broken-*.dat` and read empty. Presence of a saved key IS the mode: `observe()`
    short-circuits to an honest `api-key-local` observation (`UNKNOWN`/`DOCUMENTED`, empty
    identity, zero provider spawns); `agentEnvironment(provider)` injects exactly one var
    (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`DEVIN_API_KEY`) at the agent-spawn seam only;
    `LaunchRecord.authMode` records which credential context ran (metadata, never the key). IPC
    validates keys (≤512 chars, single-line) and redacts key material from thrown errors; Settings
    gained the "Use my own API key" disclosure with the required own-billing copy, password input
    with accessible label, saved-state + Remove-key UI. No developer credentials exist or are
    referenced. Tests: 925 pass incl. the redaction sweep (no key bytes in events/snapshot/logs)
    and zero-spawn api-key observe. Packaged check on scratch userData: save → restart →
    persisted → remove → subscription UI restored. Deviation recorded: `office:provider-key-state`
    IPC added (the third key op the packet specified). Flagged for follow-up (pre-existing, out of
    scope): `artifacts.backup()` reads `manifest.lastEvent` from the live store after copying —
    a concurrent event append can throw `Backup lineage tip does not match its manifest.`
  - **LR-17 (PR #35 → `90c0e45`, worker SWE-2 Max):** the LR-8-prescribed integrity checkpoint.
    Schema 6 adds `integrity_checkpoint` (sequence, event hash, projection hash + verified
    projection state). `verifyIntegrity` writes the checkpoint after each completed full pass;
    open replays only post-checkpoint events (`verifyTail` — anchor-hash check + shared
    `checkEventChain`/`checkStorageIntegrity`/`parseEventRow` helpers so tail and full paths cannot
    drift) and schedules `verifyInBackground` (chunked, 25-event yields, mid-scan-append guard,
    aborts cleanly on close); background failure logs and raises the error dialog via
    `onBackgroundVerifyError`. `downgradeWorkspaceToV3` accepts v4/v5/v6 and drops the table.
    `bench-store.ts 1000` on the merged code:
    `{"observations":1000,"projectionBytes":747045,"writeMs":831324,"openMs":132,"snapshotMs":17.55,"tailEvents":0}`
    — `openMs` 132 ms < 3,000 ms → **L2 closed**. (`writeMs` ~832 s for 1,000 events is the
    pre-existing O(n²) write path; a separate scalability concern, not an open-time gate.)
  - **App\ mirror:** `90c0e45`, asar `704BFE0B…` (verified file-for-file after each merge).
  - **Test roster reset (user-directed, live workspace):** all seven seats cleared via
    `agent.remove`/`agent.delete` and re-created through the real `connect→confirm` flow as
    devin/swe-2-max/default LOCAL+LOCAL_CLI_EXEC, bound to the user's own signed-in Devin account
    (`devin auth status`/`devin models list` probed live for each binding — real evidence, no
    fabricated identities). Live DB migrated v3→v6 on open with the migration's own
    `workspace.sqlite.before-v6-*.sqlite` copy; organizer backup preserved at
    `Archive\workspace-live-before-agent-reset-20260927.sqlite`; integrity_check ok; checkpoint at
    seq 1416 covers pre-reset history. All future acceptance/test agents run SWE-2 Max unless the
    user says otherwise; orchestration workers are SWE-2 Max.
  - **Remaining launch gates:** LR-16 separate-Windows-user design packet is written and a worker
    is in flight (`feat/lr16-agent-isolation`); the real elevated end-to-end (create QRO-Agent →
    isolated dispatch → whoami/access-denied checks) is organizer acceptance after merge. Legal
    review of provider terms is user-owned and still pending. D-3 (signing, installer, updates,
    fuses, clean-machine validation) remains deferred until the user reopens it.

### 2026-09-28 — LR-16 launcher follow-up merged; real isolation acceptance remains open

- **Integrated code:** LR-16 implementation PR #37 (`481c6da`) and follow-ups PR #38 (`c76f428`, BOM-safe setup result), PR #39 (`645eb74`, standard Users-group membership), and PR #40 (commit `7b3951c`, merged as `ba9b72d`, bootstrap working directory inside the granted host tree and direct .NET SecureString construction). PR #40 `verify` passed on the exact head, including format, typecheck, unit tests, build, package and desktop e2e. Local checks for this follow-up: 16 isolation tests pass; full suite 945 pass, 0 fail, 1 skip; typecheck, Prettier and build pass.
- **Real acceptance is not established.** The scratch setup configured QRO-Agent, but the four probes never ran: host startup failed in the Codex-managed Windows process environment with Node's `ncrypto::CSPRNG(nullptr, 0)` assertion and PowerShell `Access is denied`. A separate Node launch under `-UseNewEnvironment` reproduced the CSPRNG error in this shell. The harness treats some host-start errors as passing for the negative checks, so those lines are not valid evidence. Rerun the real elevated acceptance in a normal desktop process environment before closing LR-16.
- **Installed package:** rebuilt from merged `ba9b72d` and mirrored file-for-file into `Quant Office\App\`; all 95 files matched. `resources/app.asar` SHA-256: `4CF93A09D322A6CF4EBE6171A5514E895C6B782E94CA540ECCDBF8C502CADB8D`. The app was closed during mirroring; live Office user data was not touched.
- **Still open:** LR-16 real elevated acceptance and the user-owned provider-terms legal review. C11 development exit criteria and L2 are complete; D-3 remains deferred.

### 2026-09-28 — PR #42 merged; LR-16 evidence checks fail closed, provider review prepared

- **Acceptance evidence and regression coverage:** Added a pure evidence evaluator in
  `app/src/main/agent-isolation-acceptance.ts`. It requires a successful `whoami`, exact QRO-Agent
  identity, non-admin group output, explicit access-denied text for the office profile, and the
  host's exact cwd-boundary refusal. Process-launch errors, timeouts and missing output cannot
  count as negative-test success. Three tests cover passing evidence, host-launch failures and
  missing denial/boundary evidence. Focused LR-16 tests: 19 passed. Full app suite: 948 passed,
  0 failed, 1 skipped (949 total; 8m14s); typecheck, Prettier check and build passed. A standalone
  runner was withheld after review found its setup path would rotate the machine's QRO-Agent
  password while keeping the replacement only in memory, desynchronizing the app's DPAPI-protected
  credential. The real-account acceptance remains **not run**; execute it through a normal desktop
  app-backed process with scratch probe data, then retain the LR-16 gate as open until every check
  passes.
- **Terms review preparation:** Added
  `records/reviews/provider-terms-review-prep-2026-09-28.md`, based on official OpenAI,
  Anthropic and Cognition terms/help pages checked 2026-09-28. It identifies account-mode,
  automated CLI/output capture, financial-research, product-embedding and data-handling questions
  for qualified counsel. This is issue spotting only; provider-terms approval remains open and the
  product stays private/internal beta until counsel records a provider-by-provider decision.
- **Integration and installed package:** PR #42 merged through GitHub as e11e22246e42999f1572707136b15a71d8a7b3f2 after verify passed on exact head cbcb02d91bf98c541c4ba339d5657fe40cc20a6a (10m44s). Rebuilt and packaged from the merged commit; mirrored into Quant Office\App after confirming the app was closed. All 95 files matched; app.asar SHA-256: 25922E5A701BD1768B4F72792BEBD84BEF079D7CEC1EAEA668F458EAC6F5C5BC.
- **Changed files:** `app/src/main/agent-isolation-acceptance.ts`,
  `app/tests/agent-isolation.test.ts`, this roadmap, and the counsel prep record. C11 development
  exit criteria remain met; D-3 remains deferred.

### 2026-09-28 — Organizer verification of C11 on `54aa5f7`; development complete, two launch gates open

- **Scope checked:** `origin/main` at `54aa5f7` (PR #43), which contains every C11 code packet: LR-0 (#18), LR-1 (#21), LR-2…LR-14 (#23–#32), LR-15 (#34), LR-17 (#35) and LR-16 with its follow-ups (#37–#40, #42). LR-8 was a measurement packet with no branch; its result produced LR-17. LR-12 stays parked under D-3.
- **Independent re-run in a clean worktree on `54aa5f7`:** `pnpm install --frozen-lockfile` clean; `pnpm typecheck` 0 `error TS`; `pnpm format:check` "All matched files use Prettier code style!"; `node scripts/build.mjs` "Built Quant Research Office 0.5.0"; full unit suite 949 tests, 948 pass, 0 fail, 1 skipped (matches PR #42's report). `bench-store.ts 1000`: openMs **92 ms**, tailEvents 0 — under the 3 s exit criterion, so L2 stays closed.
- **CI:** `verify` on main head `54aa5f7` succeeded (run 36485341602), including the packaged desktop e2e. One earlier main run failed: PR #41 (`70a5dd9`, docs-only) failed `archive.test.ts` "a large workspace streams past the in-memory format limits" with `unexpected EOF` in the inflate worker. The next two main runs passed without code changes to the archive path, so this is recorded as an **intermittent CI failure, not yet reproduced**. Watch it; if it recurs, open a finding against the archive streaming reader.
- **C11 development exit criteria:** met — LR-0…LR-11 and LR-14 merged, desktop e2e and format check green in CI, open time under 3 s.
- **Launch gates still open (not closed by this entry):**
  1. **LR-16 real elevated acceptance — NOT RUN.** The `QRO-Agent` local account exists, is active and belongs only to `Users`, but no passing probe evidence exists anywhere in the repo, the worktrees or the temp folder; the only attempt failed at host startup in the Codex-managed process environment. The user must run it from a normal desktop session through the app, with scratch probe data, and the fail-closed evaluator must pass every check.
  2. **Provider-terms legal review — handled outside this project by a separate reviewer (user decision 2026-09-28).** It is off the development track and no packet waits on it; it still gates any sale. Counsel prep is in `records/reviews/provider-terms-review-prep-2026-09-28.md`.
- **Still deferred (D-3):** signing, installer, updates, fuses (former LR-12) and clean-machine release validation. The section 11 commercial-launch row therefore stays IN_PROGRESS and the product stays private/internal beta.

### 2026-09-28 — Project audit and cleanup

- **Scope and record:** whole-project audit of `54aa5f7` (plus PR #44); findings, method and coverage are in `records/reviews/project-audit-2026-09-28.md`. Branch `chore/project-audit-20260928`.
- **Code:** `OfficeStore` caches the canonical projection text it verified or wrote (snapshot 35.6 ms → 5.1 ms on a real-size workspace; integrity checks still read the stored row). The local CLI route's cancel and run limit now end the whole Windows process tree, with a regression test. `LocalCliExecAdapter` takes named options, and tests no longer inherit the 4 s Claude launch gap (full suite 5 m 43 s → 1 m 43 s). Startup and automatic-observation failures are logged. The research-status capability text is corrected. The never-wired 0.4 guard prototypes and 82 unused declarations are removed; `tsconfig.json` rejects unused locals and parameters and type-checks `scripts/`. Unused devDependencies `@electron/windows-sign` and `@types/pngjs` are removed.
- **Docs and configuration:** this roadmap split into a working file and a verbatim archive (6,221 → 1,248 lines; lossless check passed), with sections 1.1, 1.2, 1.3, 1.5, 4, 5, 10, 12–14, 16 and 17 revised. AGENTS.md, CLAUDE.md and both READMEs rewritten; historical design documents moved to `docs/history/`; `reopen` documented in the session manual; PR template updated. CI actions move to `checkout@v7`, `setup-node@v7`, `pnpm/action-setup@v6` with pnpm 12.3.4; `.gitattributes` keeps every text file LF.
- **Verification:** format check clean; typecheck 0 errors; 945 tests, 944 pass, 0 fail, 1 skipped; build and package clean; packaged desktop e2e passed; packaged UI check of the Location & inputs panel with a scratch data folder, no page errors.
- **Not changed here:** PRs #45 (Electron fuses) and #46 (LR-16 in-app check) stay separate; PR #44's commits are included. The installed `App` copy is not re-mirrored until this change merges.
- **Next:** decide whether to wire or delete the unwired research-policy helpers listed in the audit record; trim capability history from state pushes; LR-16 real acceptance and worktree cleanup are the user's.

### 2026-09-29 — LR-16 real QRO-Agent acceptance passed; host launch fixed

- **How it ran:** from a normal desktop session on branch `feat/lr16-verify-action` (PR #46), driving
  the development app with a scratch `QRO_USER_DATA_DIR` (`%TEMP%\qro-lr16-accept-20260929`). The
  user approved the UAC prompt for Settings → Set up agent isolation, then the app's own Check
  isolation action ran the probes through the saved DPAPI credential. Live Office user data was not
  touched and had no isolation configured, so the password rotation by setup broke nothing.
- **First run failed closed (0/5):** the agent host never reported ready. Three causes were found and
  fixed in the credential bootstrap in `app/src/main/agent-isolation.ts` (commit `49f1922`):
  1. `Start-Process -UseNewEnvironment` builds the environment from the registry only. That drops
     `SystemRoot`, so node.exe aborted on `ncrypto::CSPRNG`, and it copied the office user's HKCU
     variables. Without the flag, the Start-Process credential logon was refused ("Access is
     denied"). The host now starts through `ProcessStartInfo` with an explicit environment:
     system-wide keys (`HOST_ENV_KEEP`), the machine Path and a TEMP inside the ACL'd host tree.
  2. node realpaths its main script by lstat-ing every parent folder, and QRO-Agent is denied
     `C:\Users\<office user>`. `--preserve-symlinks --preserve-symlinks-main` skip that walk.
  3. The host's stderr was discarded; it is now passed back, so a start failure is reported.
  These match the 2026-09-28 Codex failure (the same CSPRNG assertion and "Access is denied").
- **Result after the fix: passed 5/5**, twice (after the fix and again on the final build). whoami
  is `qro-agent`; its groups are standard (Users, no Administrators); `dir` of the office profile
  returns "Access is denied."; a `C:\` working folder is refused by the host boundary. The evidence
  JSON stays in the scratch folder's `acceptance\` directory (not committed; it contains the
  machine name).
- **Verification (local; GitHub Actions paused for quota):** isolation tests 24/24 (3 new
  regression tests); full suite 953 passed, 0 failed, 1 skipped; desktop e2e passed; typecheck and
  Prettier clean.
- **Still open:** merge PR #46 once Actions is available and verify passes; then rebuild and mirror
  `App\`. Do **not** set up isolation in the real app: v1 needs a provider API key for every
  isolated dispatch, and D-6 (the user's rule of 2026-09-29) keeps agents on subscriptions. LR-16b
  is the follow-up.
