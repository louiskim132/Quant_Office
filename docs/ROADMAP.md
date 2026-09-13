# Quant Research Office — single implementation roadmap

Updated 2026-09-13 after the fixed eight-session desktop coordination layer was implemented and exercised. The complete locally actionable C4–C7 revision, static review, consolidated verification with targeted repairs, and fresh packaged/native acceptance remain the application baseline. This is the sole active roadmap. Sections 11 and 12 distinguish VERIFIED_LOCAL implementation from BLOCKED_EXTERNAL live capability evidence. Earlier slice reports are historical. Section 3.1 remains a proposal, not an enabled provider route.

## 1. Start here: scope, priority and execution rules

Workspace: C:/Users/louis/Desktop/Codex/quant-team. Application: C:/Users/louis/Desktop/Codex/quant-team/app. Version observed: 0.5.0. At the last application audit the folder was not a Git repository; Git was subsequently initialized and connected to `https://github.com/louiskim132/Quant_Office.git` on the `main` branch on 2026-09-12. Check current files, Git state and applicable AGENTS.md before editing. Do not fabricate a branch, commit, test result, cloud receipt or missing configuration.

**Local C4–C7 implementation and acceptance are complete.** The accepted S0/S1 work was retained and extended through the independent-runtime S2–S10 workflow. The consolidated pass reported 370/382 with twelve failures; after the repairs a final full-suite run on the same unchanged source passed 382/382. Typecheck, build, three development desktop suites, a fresh package, three packaged desktop suites and actual packaged native PTY acceptance also passed. C4–C7 are VERIFIED_LOCAL within the synthetic and desktop acceptance scope. Live research remains BLOCKED_EXTERNAL: the shipping application does not configure a trusted independent ResearchRuntime or isolated custodian, and the official provider route has no verified isolated-context capability. R5 requires the external session reconciliation and scope-specific evidence in section 5.3. No local fixture installs hosted trust or enables real research. Next is external provider/harness/custodian provisioning and verification; no repeated local baseline, new profile setup, paid API, real holdout, or brokerage action is authorized by these results.

User decisions: Claude is primary. Existing signed-in profiles need no repeat setup unless the official tool reports a problem. Design ambiguities, including old 10.5/10.6, are delegated and settled here. No approval poll for ordinary local code/document/test-fixture work. External provider challenges/permissions and actual project-specific research inputs may require facts from the user; never invent them to pass a gate.

### 1.1 Boundaries that every implementation must preserve

- The desktop owns UI, records, deterministic policy enforcement, authentication checks, storage, indexing, explicit transfers and recovery. Agent research, model training, backtesting and research diagnostics execute only through verified provider-hosted infrastructure. “Mechanical/no model” does not mean “run research locally.” Synthetic app regression fixtures may run locally.
- Official subscription authentication only. No paid inference API fallback, custom credential client, self-hosted Claude, local research execution or Colab connection. Manually exported code and manually imported result files remain a supported external handoff; never control that external runtime.
- Imported outputs start as USER_IMPORTED/QUARANTINED. Matching hashes prove byte identity, not correct execution, independence, profitable research or provider hosting. Promotion requires the relevant evidence below.
- The pipeline includes shadow/monitoring artifact contracts and imported evidence, not brokerage integration or real-money order placement. Do not add trading connectors, recurring automation, market-data purchases or capital deployment as implied work.
- Preserve unlimited roster/role membership. Schedule explicit assignments on demand; do not require permanent four-PM teams. Single-agent requests remain single agent, with delegation off unless the user explicitly changes scope.
- State/evidence transitions are main-process/store controlled. Renderer supplies typed IDs, revisions and user intent, never provider receipts, arbitrary shell text, approval facts or trusted observation fields.
- A deterministic gate can fail or lack evidence. Missing/unsupported evidence never equals PASS. No model can override a failed mandatory gate; a legitimate repair appends a new version and reruns affected gates. Pin the independently maintained gate harness outside the candidate's writable scope; candidate code cannot edit its own admission checks, signing material or gate version. A gate-spec defect blocks the branch pending a reviewed prospective correction, never an in-place waiver.
- Preserve old event bytes, user files and historical evidence. Append migrations with backup/replay checks. No automatic external dispatch on restore, relink or migration.

### 1.2 How a simple coding model should execute this document

1. Read section 1, the current progress row in section 11, and the next incomplete task packet. Use section 1.3 to locate relevant symbols/callers/tests. Read other roadmap sections only when the task depends on them. Verify changed source before trusting old findings; never require a full-roadmap/full-repository reread for every small revision.
2. Track bounded implementation steps within the full authorized deliverable. When the user requests the entire roadmap, continue through all independently actionable remaining work; a completed step is not a reason to stop. Keep unrelated behavior unchanged. Reuse existing modules and libraries; evaluate the specific routing proposal in section 3.1 without installing an unrelated optimizer stack.
3. Implement runtime schema/type changes together, then store/reducer, main service, narrow IPC/preload and UI where needed. Keep old records readable. No renderer authority shortcuts.
4. Add targeted positive and negative regressions described by the work item. Tests must assert behavior, not mirror implementation or replace integration evidence with fabricated production records.
5. Batch the authorized code revisions, then run one consolidated verification pass. Do not rerun tests after each minor edit. Rerun affected checks only for failures or subsequent changes. Run full unit/build/desktop checks before packaging a release. Inspect failures; never weaken gates, skip tests or change every fixture's mode just to obtain green output.
6. Update section 11 in this same file: changed files, commands, actual outcomes, migration impact, remaining blockers and exact next item. Link dated raw logs. Do not maintain a second continuation guide.
7. A blocked provider operation does not block independent fixture implementation. Keep the live feature disabled and record the exact missing capability. End each slice with a concrete status, not an unsupported completion claim.

### 1.3 Compact code map and freshness checks — development workflow

This section is the shared code map; section 11 is current state; sections 1–3 and each work item's rationale are decisions. Do not create separate code-map.md/current-state.md/decisions.md files or copy this roadmap into agent instructions. The later Token Optimization conversation proposed those three functions; this single-file layout fulfills them without competing sources of truth.

Map refreshed after the local R completion pass on 2026-09-08. The 12-character SHA-256 prefixes identify reviewed raw source bytes for navigation, not approval or executable-cache identities. Paths are workspace-relative. Recheck changed files and affected callers/tests; no full-repository reread is required for each slice.

| Area / start symbol | Source path | Relevant caller / tests | Reviewed hash prefix |
| --- | --- | --- | --- |
| Trusted IPC, workspace epoch admission, service rebuild on restore | app/src/main/main.ts: register, buildController, storeEpoch/openRequestActions/workspaceLocked | preload → main → services; tests/desktop.e2e.ts | 88fc2082943a |
| Assignment lifecycle / shared launch guard / frozen payload and account context | app/src/main/controller.ts: AssignmentController, launchGuard, refreshFrozenAccount, frozenPayload | main.ts; controller/cooperation/handoff/pty tests | fe5276adbacf |
| Contained session probe (no production caller) | app/src/main/probe.ts: probeCloudTransport | reachable only past the R1-A refusal in main.ts; probe.test.ts | e587eaf6fcc7 |
| Transport verification containment | app/src/shared/transport.ts: TRANSPORT_PROBE_CONTAINMENT, assertTransportProbeAllowed | main.ts office:verify-transport; renderer/agents.tsx; probe.test.ts | 266a521d6b1d |
| PTY submission / receipt parsing / local module status | app/src/main/pty.ts: PtyCloudAdapter, readReceipt, transportModuleStatus | main.ts/probe.ts; pty.test.ts | 5953236c0fa9 |
| Explicit terminal handoff | app/src/main/handoff.ts: TerminalHandoffAdapter | controller/main; handoff.test.ts | 349062e7ea8c |
| Official account/model observations | app/src/main/subscriptions.ts: Subscriptions | main.ts connection/binding handlers; subscriptions/connections tests | cefee5cbf08a |
| Capability scope and action readiness | app/src/shared/readiness.ts: effectiveEvidence, scopeMismatches, RequestedScope, agentDispatchReadiness | controller and UI; readiness/binding/cooperation tests | c5a3d6e5f066 |
| Shared public types / OfficeAPI | app/src/shared/types.ts: FrozenAssignmentPayload | store schemas, main, preload, renderer | e4392bd5f929 |
| Runtime schemas / transaction / replay / bindings | app/src/core/store.ts: OfficeStore | main services; core/binding/connections tests | f5e535056967 |
| Selected inputs / staging / transfer verification / reconstruction / output allocation | app/src/main/locations.ts: prepareInputSnapshot, verifySnapshotForTransfer, reconstructSnapshot, reserveOutputDestination, RESERVED_DIRECTORY | main.ts prepare handler; controller.ts dispatch and handoff; locations.test.ts | 4f7270c00a6f |
| Artifact and snapshot objects / import / backup / export | app/src/main/artifacts.ts: ArtifactService, backedUpObjects | main.ts; artifacts/large-backup/recovery tests | 5110747b7e7e |
| Connections UI (live-create flow removed) | app/src/renderer/agents.tsx: ProviderConnections | window.office APIs; desktop.e2e.ts | 18f64d86be0f |
| Renderer bridge | app/src/main/preload.ts: api.verifyCloudTransport | office:verify-transport handler | c400ae691662 |
| Desktop bridge assertions and fixtures | app/tests/desktop.e2e.ts | built app/packaged app; no research calls | bd8d64c114f2 |
| Output preflight and durable result materialization | app/src/main/outputs.ts: OutputService | controller/main; controller tests | 6641f426cbee |
| Shared backup/restore object registry | app/src/core/object-inventory.ts: objectInventory | artifacts/recovery; controller/large-backup tests | 9f74bf3d3be3 |

Updated affected entries, 2026-09-09 (no Git repository; all local changes are source state):

| Area | Source | SHA-256 prefix |
| --- | --- | --- |
| Research page integration | app/src/renderer/main.tsx | 4f4d3c75f186 |
| Project-scoped pipeline and evidence reader | app/src/renderer/pipeline.tsx | c4c0283cdb4a |
| Research templates included in package | app/scripts/package.mjs | 08e8ad226819 |

Routing review freshness, 2026-09-11: no `.git` exists in the workspace, so local source bytes include all in-flight edits. `main/controller.ts` (fe5276adbacf) and `shared/readiness.ts` (c5a3d6e5f066) still match their reviewed map entries. `shared/types.ts` is now 42218075e119 and `core/store.ts` is f2eb40a14df6; their earlier hashes and passed test counts do not validate these later integration edits. Targeted routing inspection also covered `main/research-controller.ts:scheduleStage` (5287b2029115). It resolves functions to agent profiles; `controller.ts:prepare/launchGuard` uses an account-bound session adapter; `readiness.ts:providerReadiness` requires every `CLOUD_DISPATCH` capability for automatic start. These are navigation observations, not new acceptance results.

Confirmation-audit freshness, 2026-09-12 (supersedes older entries for these files; no Git repository):

| Area | Source | SHA-256 prefix |
| --- | --- | --- |
| Exact research launch/payload | app/src/main/controller.ts | c806c8ba1cb0 |
| Contained pipeline collection/admission | app/src/main/pipeline.ts | 2abc8d6af449 |
| Scheduler status and mandatory applicability | app/src/main/research-controller.ts | 0c68c740c8fe |
| Stage context identity/report schema | app/src/shared/pipeline.ts | 52a12b4162e9 |
| Shared integration containment | app/src/shared/research.ts | d3890b46cea7 |
| Gate writes, replay and stage admission | app/src/core/store.ts | eadb416fe8b2 |
| Pipeline regressions | app/tests/pipeline.test.ts | f4ee16b7e4e6 |
| Adjudication regressions | app/tests/research-controller.test.ts | 9d86635cfa81 |
| Pipeline IPC/UI containment fixture | app/tests/pipeline.desktop.ts | 038fcb2b2515 |
| Exact subject selector accessibility | app/src/renderer/pipeline.tsx | 5c40d754fac8 |

Final C4–C7 revision freshness, 2026-09-12 (supersedes every earlier entry for these files; no Git repository, so these prefixes identify the reviewed local source bytes of the verified and packaged revision):

| Area | Source | SHA-256 prefix |
| --- | --- | --- |
| Runtime schemas, transactions, review/harness/custody admission, derived read indexes | app/src/core/store.ts | a5b43ba4271f |
| Independent-runtime receipt trust and version pins | app/src/core/research-admission.ts | 08a8af3da237 |
| Adjudication outcomes, lineage suspension and follow-up accounting | app/src/core/adjudication.ts | 432a104206b0 |
| Monitoring standing, alarms and retirement | app/src/core/monitoring.ts | 4b481ed3848c |
| Shadow ledger ingestion and coverage | app/src/core/shadow-ledger.ts | cfd9ce3f2507 |
| Backup/restore object registry | app/src/core/object-inventory.ts | 5a27ead64cd1 |
| Stage preparation, dispatch, atomic collection and harness intents | app/src/main/pipeline.ts | 8bd5958c7e80 |
| Stage scheduling, review rounds, rebuttal and status projection | app/src/main/research-controller.ts | efc26479463f |
| Isolated context construction and blinded/same-evidence policy | app/src/main/context-policy.ts | 1b8c3a00ec54 |
| Holdout registration, reservation, journal/checkpoint and result recovery | app/src/main/holdout.ts | 5a3a5fa078cf |
| Evidence query, paging, cache and measured retrieval | app/src/main/evidence.ts | d83c16f82d75 |
| Artifact objects, research export/import and backup coverage | app/src/main/artifacts.ts | ea77c71fe1c8 |
| Assignment lifecycle and frozen payload | app/src/main/controller.ts | 0d85982993f5 |
| Trusted IPC surface and service rebuild | app/src/main/main.ts | 782c7dcb82ff |
| Renderer bridge | app/src/main/preload.ts | 00c187d86bec |
| Restore and recovery integration | app/src/main/recovery.ts | 34f0b080e15f |
| Output reservation and materialization | app/src/main/outputs.ts | 5ebcc440c4bf |
| Input snapshots and reserved destinations | app/src/main/locations.ts | 5f74dd991185 |
| Contained probe | app/src/main/probe.ts | 342dc9f5cb65 |
| Research/review/holdout/shadow contracts | app/src/shared/research.ts 8b45dacc0db0; research-admission.ts 3be4a3689886; pipeline.ts 7402c99e3cce; holdout.ts 090f85674f51; shadow.ts a1f15c201d2c; evidence.ts 37093ffad6e9; types.ts e835bd7f5377 | see cells |
| Research, shadow/monitor, office and profile views | app/src/renderer/pipeline.tsx 3a7eeadb804c; office.tsx d1f72736715b; profile.tsx 0baf28227f00; dispatch.tsx 90f85d0da53a | see cells |
| Integrated and targeted fixtures | app/tests/research-workflow.test.ts bb5c059e7155; fixtures/research-workflow.ts 3bff8bf91272; holdout.test.ts 5b60e8d78bf1; holdout-recovery.test.ts 9d7647a981ae; shadow.test.ts b14b111b63c2; shadow-ledger.test.ts 401d4360886c; paging.test.ts 1f987ce7da7c; research-pages.test.ts 0ed32fbc8d6a; evidence-experiment.test.ts 6c3ecc095575; research.test.ts db9c89501524; desktop.e2e.ts f83acdf2ccc3; pipeline.desktop.ts b5b4d942840d; fixtures/pipeline.ts 2aa95b78754d | see cells |

Normal discovery roots: app/src, app/tests and the specific required scripts. Exclude app/node_modules, release, dist, .pnpm-store, datasets, model checkpoints, run archives and old test-output from broad search; explicitly read a dated log/artifact when the task requires it. Use targeted rg/symbol lookup before a full file read. Read affected implementation, relevant callers, types/schemas and tests; expand whenever evidence/uncertainty warrants it. Never treat the map as proof that a function is safe.

No Git repository was present at the prior application audit, so its hash records remain historical navigation evidence. Git now exists; use actual HEAD plus staged/unstaged/untracked state and the worktree/branch identity for new work. HEAD alone does not identify local edits.

### 1.4 Shared developer context and optional Serena trial (D1)

Scope distinction: this is how Codex/Claude Code developers revise the local desktop application. It is separate from the product's provider-hosted research pipeline and C2 artifact analysis. Local source navigation and synthetic app tests do not authorize local training/backtesting. A navigation plugin is not a research executor or coordinator.

Decisions from the later Token Optimization discussion:

- Keep the desktop workflow and same intended checkout. Changing to a PowerShell window does not share conversations, model understanding or provider caches; the shared material is files, versioned findings and task evidence.
- One writer at a time in a shared checkout; implementation followed by independent review. No simultaneous edits by two clients. Separate worktrees become an option only when a real Git repository exists and parallel work is explicitly authorized; record checkout/revision in each handoff.
- Native targeted search is the baseline. Serena is the first optional navigation trial for repeated symbol/caller reading; it is not needed for R1-A and must not delay safety repairs. Graphify remains an alternative if cross-module relationships, rather than exact symbols, are the bottleneck. Do not install both initially.
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

### 1.5 Parallel coding: organizer and up to seven workers (D2)

This is developer coordination for changing this application. It does not enable the application's R5 research transport. User requested one organizer plus 5–7 concurrent SWE-2 coding sessions on 2026-09-12. The worker runtime is selectable in the actual coding client; no specific model access or account concurrency has been verified here.

**Organizer owns the outcome.** Freeze objective, interfaces, file ownership and acceptance before dispatch. Keep main stable. Workers each get an isolated local worktree or hosted clone, a unique branch, the same frozen base SHA, and one bounded task. Workers propose; organizer reviews exact SHAs, rejects out-of-scope changes, resolves integration conflicts, tests the combined application and opens one PR to main. The user retains final main merge. Git and instructions coordinate changes; they do not share conversations or automatically create model sessions.

Shared types (`app/src/shared/`), `core/store.ts`, `main/main.ts`, `main/preload.ts`, dependencies/lockfiles, CI, agent instructions and this roadmap are organizer-owned. An interface or layer restructure is a prerequisite when other workers depend on it: land the contract first, then start a new batch at that commit. Do not simultaneously ask one worker to redesign the layers and six others to code against the old layers. Assign disjoint tests along with implementation files. Workers propose roadmap changes in their PR body; organizer updates section 11 once, preventing seven edits of this file.

Suggested planning lanes (not active feature authorizations): UI shell/styles; office/dispatch UI; research/evidence UI; prompt construction; isolated service refactor; targeted regression tests; independent review. Give each a concrete acceptance packet and non-overlapping paths before starting it. The reviewer can stay read-only; five well-scoped writers are preferable to seven overlapping writers. Prompts embedded in shared types/controllers may require an organizer contract change first.

**Fixed local desktop batch.** The executable [desktop session manual](DESKTOP-SESSIONS.md) defines the prepared Session 1–7 worker plus Session 8 organizer workflow. `tools/desktop.mjs` binds each checkout to one role, publishes all seven slots atomically from the organizer's clean `HEAD`, gives each worker only its own immutable packet on `start`, records submissions by exact commit SHA, refuses stale/out-of-scope results and reviews, and merges accepted commits only into the organizer checkout. A round closes only after every slot is resolved and the organizer records actual combined unit, typecheck and build outcomes plus the canonical roadmap update. This coordination metadata is an execution log, not a competing product plan. It cannot authenticate a model, make two desktop applications respect one-writer ownership, independently prove a self-reported check, create provider sessions or connect an isolated hosted clone to the local mailbox.

From repository root, with Node 24 and Git installed:

~~~powershell
git fetch origin
node tools/parallel.mjs init ui-round-1 7
# Use the absolute batch directory printed by init in place of <batch-dir>.
node tools/parallel.mjs status <batch-dir>
node tools/parallel.mjs assign <batch-dir> worker-1 <task.json>
node tools/parallel.mjs check <batch-dir> worker-1
~~~

Task JSON has `objective` (string), `allowedPaths` (array of exact relative files or directory prefixes ending in `/`) and `acceptance` (nonempty array of strings). Example shape: `{"objective":"Implement the organizer-approved office spacing specification","allowedPaths":["app/src/renderer/office.css"],"acceptance":["No label overlap at the specified viewports","Attach before/after screenshots"]}`. This example does not itself assign a feature. The organizer writes the actual spec before assignment. `assign` refuses duplicate assignment, overlap, traversal and organizer-owned paths, then emits the worker prompt and saves its packet under the batch's `assignments` directory. Only the organizer uses assignment commands; issue them sequentially. The local batch manifest is execution metadata, not a second roadmap. It is not committed or copied into remote sessions automatically.

`init` defaults to the fetched `origin/main`, accepts 1–7 workers, creates an organizer plus workers under a sibling sessions directory, and preserves a manifest before creating worktrees. It refuses an existing batch/branch and a dirty source checkout. If creation fails halfway, inspect `status` and the retained paths; it never deletes existing work. No dependencies, credentials, node_modules, app data or historical logs are copied. For a reviewed setup pilot before main merge, its third argument can be an explicit setup branch/commit; report this deviation and start production batches from main after review.

Local clients: open each exact worker directory in Codex/Claude Code/Windsurf and paste its generated packet. Select the model in that client. Codex's currently saved `Agent Team` project points to the parent folder, so add the actual `quant-team` repository or individual worker directories as projects. Codex managed worktrees also work, but record their actual branch/base in the task packet. Separate clients must never write the same checkout. Each worker installs its own locked dependencies in `app` (`pnpm install --frozen-lockfile`, Node 24.19.0, pnpm 11.19.0); native Electron tests require the supported Windows environment. Do not share writable node_modules or production app-data across sessions. Existing ignored test-output evidence stays in the original checkout; it is not available in a fresh clone.

Devin hosted: first connect `louiskim132/Quant_Office` in Devin's GitHub connection and configure its repository environment. Each session uses a fresh hosted clone, the packet's exact frozen commit/branch and its objective. The packet's local Windows path is only for local clients. Push the organizer branch before creating worker PRs; workers target that branch. `AGENTS.md` is supported by Devin. No Devin login, repo grant, SWE-2 selection or 5–7 live sessions can be inferred from a successful local Git push. Current browser inspection reached the signed-out Devin site. Complete sign-in/connection in the provider's own interface; do not paste tokens into task packets.

Organizer review procedure:

1. Obtain worker commit SHA, actual tests/screenshots, unresolved defects, interface/migration impact and proposed roadmap entry. Fetch the worker branch (or PR head) from GitHub into this repository for hosted workers.
2. Run `node tools/parallel.mjs check <batch-dir> worker-N <exact-fetched-SHA>` for hosted work, or omit SHA to check the local worker's clean checkout/branch. This checks ancestry, whitespace and final file scope only; it does not certify behavior or tests. Never infer independent review from a worker self-report.
3. In a clean organizer checkout, review the exact diff and merge only the approved SHA, one worker at a time. If a merge conflicts, stop integration and resolve or request a narrow repair; never use blanket ours/theirs conflict resolution. Existing worker work stays isolated. Repeat affected checks after each meaningful integration and the full unit/typecheck/build checks on the final combined result. Desktop and packaged acceptance are still required before a release.
4. Update the roadmap and open the organizer-to-main PR. Require the `verify` check, fresh review after changes and resolved conversations. The GitHub protection state must be verified separately; instructions and CODEOWNERS alone cannot prohibit a push. Keep worker branches until their accepted changes are merged. Cleanup is explicit and only after checking uncommitted work and unmerged commits.

Organizer kickoff prompt: "Read AGENTS.md and ROADMAP sections 1, 1.5 and 11. Organize the requested change into up to seven bounded packets from one frozen base. Define shared interfaces first, give workers disjoint file/test ownership, record dependencies and acceptance, then review their exact commits and test the combined result in your organizer checkout. Return one integration PR for human review. Do not claim workers were launched without actual session IDs."

Primary references: [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [Devin GitHub connection](https://docs.devin.ai/integrations/gh), [Devin AGENTS.md](https://docs.devin.ai/onboard-devin/agents-md), [Devin environment setup](https://docs.devin.ai/onboard-devin/environment).

## 2. Evaluation of the proposed research architecture

Adopt the comment's core: stage-based orchestration, preregistration/prediction, deterministic enforcement, performance-blinded correctness, and bounded adversarial analysis. Do not adopt its absolutes or named-model assignments as technical facts.

| Proposal | Decision | Exact rule for this application |
| --- | --- | --- |
| Move deterministic work out of models | Adopt | Scripts calculate metrics and enforce versioned gates. Models select justified methods, inspect assumptions and interpret evidence; research scripts still use the permitted hosted execution boundary. |
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
- Programmatic diagnostics operate on complete authorized results, return evidence references and coverage, and execute within the hosted boundary. Never let a cheaper summarizer be the only path to evidence.
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
| Data transformations used in research, diagnostics, training, backtests and final holdout evaluation | Verified hosted executor; separate custodian for holdout | Frozen code/input/gate identities, execution receipts and verified outputs. Even deterministic research processing keeps the hosted boundary. |

Separate three capabilities in the application contract:

1. `ModelGateway`: bounded text/JSON request and response, with eligible models, context/output limits, data policy, quota and usage evidence. No desktop filesystem, shell, recursive delegation or arbitrary tool execution exposed to these workers.
2. `AgentSession`: a tool-using task with its own verified environment, input transfer, submit/observe/cancel/reconcile/output lifecycle and isolated context. Continue using direct official adapters where necessary.
3. `ResearchExecutor`: execution of pinned research code against authorized data, with deterministic gate verification and separate holdout custody. A remote inference response alone does not establish where tool calls ran.

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

## 4. Current implementation and settled baseline contracts

| Foundation | Current source evidence | Status / next item |
| --- | --- | --- |
| Lifecycle/flexible requests | shared/queue.ts, core/store.ts, revision tests | Local baseline exists; full job-aware cancellation/archive in R4. |
| Accounts and readiness | shared/readiness.ts, main/subscriptions.ts, connections/readiness tests | Per-operation evidence/order/expiry exists; exact scope/fresh launch checks in R3. |
| Profile binding | confirmAgentBinding/bindAgentConnection; binding tests and UI | Implemented; preserve original setup identity and frozen assignment binding in R3/R4. |
| Locations/snapshots | main/locations.ts, renderer/location.tsx; locations tests | Local staging, reserved output paths and small/streamed backup reconstruction tested; residual swap-race/platform constraints remain explicit in R2. |
| Controller/jobs | core/jobs.ts, main/controller.ts; controller tests | Implemented fake-adapter lifecycle; R0 verified locally; remaining integration repairs R4. |
| Terminal/PTY/probe | main/handoff.ts, pty.ts, probe.ts; related tests | Default app adapter is handoff. R1 probe repairs tested and still contained; the complete hosted path remains R5. |
| Cooperation/review | shared/cooperation.ts, teams/messages/decisions in store | Delivery, isolated contexts, sealed rounds, rebuttal and adjudication are implemented and verified locally through C4 (section 12.1). Observed reviewer isolation on a real external runtime is still missing. |
| Activity/UI/scale | shared/activity.ts, profile tabs, cursor APIs, streamed backup, migration | C7 complete and VERIFIED_LOCAL: canonical activity, bounded cursor queries, derived read indexes, stable scene placement, migration/backup/recovery and packaged acceptance (section 12.1). Provider token/quality measurement remains external. |

Paths in tables are relative to app/src; tests are in app/tests. Old PM_A/B/C/D roles and legacy stages remain readable for historical replay. New stage functions are assignment metadata, not destructive renaming of saved profiles.

Settled contracts retained from earlier decisions:

1. New profiles Confirm after a fresh official exact provider/account/context check, with atomic observation+binding+agent creation. Old profiles remain unbound until explicit Verify; explicit Change creates a revision. Background refresh never rebinds; archived profiles are read-only. No invented multi-account isolation for a single active native context.
2. ProjectLocation separates optional local root, exact relative input allowlist, output root, inert legacy cloudWorkspace note and requested managed provider target. InputSnapshot is immutable and separately references actual observed remote environment. No automatic whole-repository upload/history/hooks/config.
3. Empty local root is valid for generated/text-only requests. First selection ceiling: 64 MiB of copied selected bytes plus actual transport limit; first implementation refuses network roots and symlink/junction/reparse traversal. Spaces/Unicode supported. Managed versioned outputs by default.
4. Metadata UI stale default: 5 minutes; capability eligibility expiry: 24 hours or relevant change. These are app policies, not provider guarantees. Every external launch additionally requires fresh durable identity validation.
5. Persist intent before an external call; ambiguity is UNKNOWN; do not retry without reconciliation. Terminal exit is not remote completion/cancellation. User-pasted session links are USER_REPORTED and cannot promote capabilities or scientific approval.
6. The office is a view of canonical workflow state. One root request, with multiple explicit jobs when authorized. Reviews/supersession/worker failure must not accidentally cancel or complete unrelated work.

## 5. Immediate repairs R0–R7

The local R0–R4 repair packets have been implemented, including the integration corrections in section 5.2. V1 passed (section 5.2). R6/R7 are complete for their local scope through C1–C7 (section 12.1). R5 remains the separate live gate. Do not rereun old repair packets merely because their historical instructions are retained below.

### 5.1. Review correction and next repair packets — 2026-09-08

The R2–R4 report accurately describes substantial new code and the saved 195-test success. Its header calling R2/R3/R4 complete is too strong: helper-only implementation, untested async paths and explicit residual work still remain. The findings below come from source inspection, not newly executed reproduction tests. Add the named regressions before changing implementation. Retain all existing passing tests and completed repairs.

| Scope | Current status / confirmed progress | Remaining boundary |
| --- | --- | --- |
| R2 | VERIFIED_LOCAL within documented limits | Snapshot/output inventory is shared by backup and restore; both formats restore actual bytes into a new root. OutputService reserves real destinations on prepare/launch and stores versioned verified bytes. Required missing objects refuse backup. Snapshot identity rejects null/wrong request revisions. Remaining constraints: source swap races, recorded-platform Git reconstruction and R5 transport limits. |
| R3 | VERIFIED_LOCAL | Preserve exact per-operation scope, durable evidence order, independent confinement and frozen account context. No new live capability evidence in this pass. |
| R4 | VERIFIED_LOCAL | Local lifecycle/output repairs and all-handler restore admission verified by V1 on 2026-09-08; see section 5.2. The earlier approval-review interruption is historical. No live-provider or packaged-release claim. |
| R1-B | VERIFIED_LOCAL, action still contained | Done 2026-09-08. Real one-commit fixture, durable intent before any provider contact, duplicate refusal across restart with staging retained, framed receipt contract, honest model scope, classified failure metadata. R1 step 6 needs external access. Containment is deliberately not lifted: a repaired implementation is not evidence the route works. |
| R5 | BLOCKED_EXTERNAL / capability incomplete | 2026-09-12 CLI reconciliation: session_01Aj1hpgmeoZLdgYVR9eQ6PB is live and accepted a non-interactive follow-up (provider "Sent to cloud session" receipt), but interactive attach is refused account-wide ("not enabled for your account") and no CLI read route returns session output. Outcome reconciled at USER_REPORTED level: web transcript shows the fixture ran to completion (proof.json = {"fixture":"qro-cloud","status":"ok"} in /home/user/repo), env "Default" hibernates/resumes, Sonnet 5/Medium selectors visible, and web stop produced "stopping..." -> "stopped". Missing for R5: programmatic observe/retrieve/cancel routes - CLI can create and send but not read output or cancel; interactive attach is account-gated. Details: app/test-output/claude-cloud-spike-SP2mlL/reconcile-2026-09-12.json. Section 5.3 still governs remaining steps. |

The claim that pinned dates make a Git commit a pure function of its tree is incorrect. A commit also depends on parent list, author/committer identity, message, timestamps, serialization/object format; file modes affect the tree. The passing test establishes same-commit reconstruction of one saved fixture under its pinned conditions, not a general cross-platform guarantee. Preserve that positive result and record/normalize every required commit input for the supported reconstruction contract.

### R4-A. Close launch and restore races (P0) — COMPLETE 2026-09-08

Status: done and VERIFIED_LOCAL. The packet below is kept as the record of what was required; the result, the two source gaps it exposed and one unreachable scenario are in section 11.

Start files: app/src/main/main.ts dispatch/transfer/restore/recheckAccountBeforeExternalAction; app/src/main/controller.ts dispatch/handoff; app/src/core/store.ts job/lifecycle transitions; controller/handoff/recovery and desktop tests. Read those symbols and their callers first; no whole-roadmap reread.

Source evidence:

- dispatch() captures state, checks eligibility, then awaits verifyTransfer(snapshot) and submits without rereading lifecycle/binding. handoff() similarly awaits verification after recording SUBMITTING. Generic office:command and binding operations can change state while verification is pending.
- main dispatch() wrapper checks only dispatchBusy, not transferBusy. Restore checks dispatchBusy once, closes store, then awaits commitRestore; a new request action can enter while transferBusy is true. Rebuilding the controller afterward does not prevent this race. Denial after prepareRestore also needs candidate cleanup.
- recheckAccountBeforeExternalAction checks active identity and agent revision, not complete frozen connection/context identity; it is wired only to handoff. The controller's handoff has no provider/adapter compatibility check, so a bound OpenAI agent can reach the default Claude handoff adapter. Automatic dispatch's provider check does not protect this route.

Implement in order:

1. Use one main-owned workspace-operation admission/epoch mechanism for restore versus request actions. Block requests for the entire restore preparation/commit lifecycle; deny restore while an external action is pending. After every async boundary, reject results from a superseded store epoch. Clean prepared restore candidates on refusal/failure. Keep ordinary reads intentionally defined; no accidental reads/writes against a closed store.
2. Share route/provider/frozen-account guards across handoff and dispatch. Reject an OpenAI-to-Claude pairing before any external observation/launch. Fresh official observation must be durable and match frozen connection ID, provider, identity and credential context; current agent binding must still reference that connection. Put the guard behind a controller/service boundary future callers cannot bypass.
3. Perform local preflight before marking a provider attempt SUBMITTING. If staging is invalid and no adapter call happened, keep a safe prepared/blocked state, not ambiguous remote UNKNOWN. Re-read/revalidate request/project/archive/participant/binding/required revisions after transfer verification and immediately before the adapter call; no intervening await that can invalidate the checked state without another guard.
4. Once an adapter call starts, preserve UNKNOWN on ambiguous outcomes and forbid retries without reconciliation. Do not convert actual submission uncertainty to “not submitted” while fixing preflight errors.
5. Keep R0 clock injection and R1-A containment intact. No provider session is needed for this slice.

Required deterministic regressions: pause verifyTransfer with a deferred promise, then cancel request/archive project/archive or rebind profile; release verification and assert submit/launch count zero. Exercise both dispatch and handoff. Request admitted during paused restore must be rejected before store access; restore attempted during paused request must leave workspace intact and clean candidate resources. After successful restore, prepare/observe/cancel use the replacement store. OpenAI handoff never reaches the Claude adapter. Preflight failure remains undispatched/recoverable. Test exact context mismatch even with same identity. Use controlled promises, not 10ms timing guesses.

Verification: relevant new unit tests, full unit/typecheck, build and development desktop coverage of affected main bridge/restore paths. Packaged checks only if packaging is included. Write a dated review-followup log; preserve the 195-test log. Completion is R4-A VERIFIED_LOCAL only. Next: R3-A.

### R3-A. Exact evidence provenance and truthful confinement (P0) — COMPLETE 2026-09-08

Status: done and VERIFIED_LOCAL, all five items. The packet below is kept as the record of what was required; the result and one deliberate simplification are in section 11.

Files: shared/readiness.ts RequestedScope/scopeMismatches/effectiveEvidence; types/store capability schemas; subscriptions observations; controller scope building; readiness tests.

1. effectiveEvidence currently filters connection/tool/model/environment/effort/delegation, but not each candidate's transport/adapter provenance. scopeMismatches checks only the latest snapshot's transport. Require every required operation to match the exact supported route or an explicitly verified equivalence; terminal handoff and automated PTY are not automatically equivalent because both map to OFFICIAL_CLI_TERMINAL.
2. Do not use the newest metadata-only snapshot's NONE/empty environment as the execution-scope identity. Preserve effective transport/environment per observation scope and invalidate explicitly on actual relevant change. Bind assignments to the complete effective capability ID set, not just latestCapability.id.
3. effectiveEvidence still chooses by verifiedAt timestamp, so a future-dated older result can outrank a later invalidation and is not expired (negative age). Resolve supersession by durable observation/invalidation order and refuse impossible future validity. Keep provider-wide catalog/account semantics separate. Add future-observed capability tests, not only active-account ordering tests.
4. The current code equates “all scope operations match” and boolean DELEGATION_CONTROL with toolsConfined. Define actual allowed tool/filesystem/network/environment policy and independent verification evidence; delegation control only describes delegation policy. No model boolean or a frozen requested policy proves enforced confinement.
5. Keep UI allowed actions and controller gates consistent; UI currently does not receive route/exact effort/delegation scope. Unsupported controls remain blocked. Live evidence unavailable is not a reason to fabricate stronger fields in production records; fake evidence remains test-internal.

Acceptance: old pipe evidence plus new terminal metadata cannot enable PTY; metadata refresh neither erases nor renews valid transport evidence; future-timestamp observation cannot defeat later invalidation; same identity/different context is refused; delegation=false without tool-policy evidence stays blocked; exact operation IDs survive snapshot/restart. Next: R2-B.

### R2-B. Close remaining staging and Git trust gaps (P0) — COMPLETE 2026-09-08

Status: done and VERIFIED_LOCAL for items 1–4, with the swap-race limitation documented rather than claimed solved. The packet below is kept as the record of what was required; the result is in section 11.

Files: main/locations.ts root/component validators, gitEnvironment/GIT_SAFETY, verifySnapshotForTransfer and reconstructSnapshot; locations tests. Existing reserved namespace/object format should be retained.

Source findings: ensureLocalRoot realpaths first and only checks the root leaf; a junction in an ancestor is missed. verifyStagedSnapshot does not reject a linked staging root and walkStaged skips .git. Git checks HEAD/status/rev-list but rev-list failure is ignored and there is no explicit committed-tree comparison. GIT_SAFETY disables some settings but does not define every filter/attribute/diff behavior; a writable staging .git/config or .git indirection must not be trusted. The source-copy check after copying is not by itself proof against a directory swap-and-restore race.

Work:

1. Validate all root and descendant components before reading/copying/deleting/restoring; check resolved destination stays under the app-owned staging root. Reject staging-root/.git links, .git file indirection and alternate stores. Protect against junction/reparse swaps using a supported handle-based or otherwise demonstrated stable-read design; document any remaining unsupported case rather than claim all races solved.
2. Run Git verification in a controlled repository environment. Refuse or sanitize untrusted repository metadata/config before Git can execute a configured helper; cover attributes/filter/diff/external config, replace refs/grafts/alternates and case-insensitive inherited GIT_* variables on Windows. Never run research/user hooks as validation.
3. Enumerate actual committed tree paths, modes and blob identities and compare to the full frozen manifest. Verify one parentless commit with recorded identity inputs and fail on any Git check error, not just unequal successful output. Independently detect an index hiding a changed working file, unrelated refs/history and added objects that the transport may bundle.
4. Retain same-snapshot reconstructability under recorded supported Git/platform metadata. Do not generalize the existing same-commit test to arbitrary systems. Harden reconstruction deletion/path checks before wiring the helper to main.

Acceptance: ancestor junction, linked staging root/.git, altered metadata/config with a harmless sentinel helper that must never execute, failed rev-list, committed extra file, mode/blob mismatch, hidden index modifications, source swap during read, reconstruction under a validated destination. Scope local fixtures only. Next: R2-A.

### R2-A. Wire reconstruction, exact request identity and output reservation (P0) — COMPLETE 2026-09-08

Status: implemented and locally tested, including both real backup writers/readers, commitRestore into a new root, stored output objects and snapshot reconstruction. Section 5.2 replaces the earlier helper-only coverage caveat.

Files: main/locations.ts helpers; core/store.ts recordInputSnapshot/createAssignment; main request preparation/launch and recovery; artifacts backup; renderer/dispatch.tsx; locations/controller/recovery tests.

1. reconstructSnapshot is currently a standalone helper with no main/controller caller. Add main-owned recovery of missing disposable staging from managed snapshot objects, anchored to a validated managed root and immutable snapshot ID. Persist the runtime staging locator separately; do not mutate historical snapshot bytes. Never reread an external source folder or launch on restore. Show explicit unreconstructable state for missing legacy objects.
2. prepareInputSnapshot checks request revision before asynchronous Git work, but store.recordInputSnapshot only checks request membership, and createAssignment accepts any snapshot from the same project. Recheck exact request ID/revision and location revision transactionally at recording/assignment creation for text-only and selected inputs. A snapshot for another request/revision must be rejected even within one project. Legacy/project-only snapshots require explicit request-specific preparation.
3. allocateOutputDestination is a pure candidate-path lookup, not an allocation: two callers or an existing empty directory may select the same attempt. Add durable atomic reservation of a unique project/request/assignment/attempt identity and exclusive directory creation. Reuse only the same idempotent attempt; never appropriate another empty reserved directory.
4. Wire writable-output validation/reservation and the exact file/byte/destination preview into the actual preflight path. Validate ancestor links and scope of generated paths/IDs before any write. The helper's unit tests do not establish production usage. Distinguish reservation from remote acceptance; failed preflight releases only proven-unused resources by policy.
5. Verify both backup formats restore snapshot objects and then exercise the application's recovery/preflight workflow from a different workspace root after deleting fixture staging/source. Keep output objects and receipt identity ready for R4-B retrieval.

Acceptance: same-project wrong-request snapshot; edit/location change while Git is paused; text-only revision mismatch; restore-to-new-root then prepare/handoff preflight reconstructs exact bytes; two concurrent/duplicate reservations; empty existing attempt; readonly destination; no folder upload without exact preview. Next: R4-B.

### R4-B. Finish request scope, payload, output and action integration — COMPLETE 2026-09-08

Status: implemented, including multi-job UI selection, undispatched preparation discard/retry, group-job cancellation isolation, durable output handling and output reservation. Core tests pass; V1 verified final all-handler restore admission (section 5.2). The packet below records its original requirements.

Files: controller/store/queue; main/handoff.ts and pty.ts; renderer/dispatch.tsx; cooperation and artifacts/tests.

1. Frozen fields exist, but actual adapters do not consume the full contract: PTY writes objective and ignores acceptanceCriteria/instructions/model/effort; handoff launches the request name and does not deliver that full payload. Define one prepared, reviewable provider payload including required instructions/criteria and enforce supported settings; verify actual transmitted bytes. Unsupported settings remain blocked. Remove the launcher failure's stale “Nothing was submitted” assertion when acceptance may be uncertain.
2. R4 removed GROUP/TEAM participant checks because reviewers can differ from authors. Independence does not authorize arbitrary new participants. Require explicit scoped review/function/delegation grants tied to the request; preserve legitimate independent reviewer assignments by registering those grants in fixtures, not by allowing every agent. SINGLE remains closed unless user explicitly expands scope.
3. Finish request aggregation over all jobs, queued dependencies, cancellation/archive rules and per-action projection. An INTENT blocked by preflight must have a safe retry/reprepare path; active/UNKNOWN jobs cannot be hidden by the latest completed job. Keep local pre-submit cancellation separate from provider acknowledgement.
4. Output metadata from ObserveResult is not retrieved bytes. Implement storage/hash verification, versioned reserved output identity, event deduplication, retrieval failure/restart and late-output behavior using fake adapter byte streams locally. Keep live output retrieval disabled until R5 evidence exists. Do not let a hash string alone certify a deliverable.
5. Preserve the repaired OFFICE_LOCAL unsupported-observation branch, but use explicit observation provenance for future real UNKNOWN reports instead of assuming every UNKNOWN is necessarily local. Finish tests for thrown cancel/observe errors and repeated actions.

Acceptance: adapter receives exact frozen criteria/instructions; settings enforcement or explicit blocker; unlisted agent without grant refused while authorized independent reviewer works; multi-job canonical state; stale action refusal; output hash mismatch/partial stream/restart; no fabricated scientific approval. Next: R1-B local implementation, then consider C1 with explicit remaining live gates.

### 5.2. Latest local repair pass and V1 validation handoff

This pass implemented code; it was not another documentation-only audit. Earlier 224-test completion claims missed real integration defects. Keep the implementation and the passing evidence below; do not redo completed helpers or weaken any provider gate.

Completed local changes:

1. **Durable output workflow (R2-A/R4-B):** main builds OutputService alongside the controller. Preparation, launch preflight and command preview reserve the frozen user-selected output folder or the current workspace's managed results root. Exclusive reservation markers bind project/request/assignment/attempt. Result bytes are checked for safe relative paths, sizes and hashes, stored in managed content-addressed storage and materialized under attempt/files/hash/path. Repeated writes verify existing bytes. Live retrieval remains absent/disabled until R5; the storage path itself is wired and tested with fake bytes.
2. **Retrieval recovery (R4-B):** a fetcher without a durable sink cannot certify output. Partial/mismatched inventories do not settle a job after one successful file; a local failure event is recorded and observation can retry across restart without redispatch. Same-state output observations store new bytes and deduplicate repeats. The stored flag is added only after the sink succeeds. Prior output records without that flag remain historical, not silently upgraded.
3. **Backup/restore integration (R2/R7):** core/object-inventory.ts covers imported artifacts, selected/generated snapshot objects and job outputs. Both archive formats validate that inventory, restore objects into the actual objects/hash-prefix/hash layout and refuse missing required bytes. New snapshots mark objectsStored; old records remain readable, with missing legacy bytes optional and unreconstructable. Integration tests invoke actual backup, prepareRestore, commitRestore in a new root, remove original fixture staging/source, reconstruct the same snapshot and verify its tree/commit. No restore launches a provider.
4. **Lifecycle and UI (R4/R7):** restart leaves INTENT prepared because SUBMITTING was never reached. discardPreparation is a narrow validated main/preload bridge action limited to undispatched jobs; it retires only that preparation and permits a fresh one. Canceling a GROUP/TEAM job no longer cancels the whole request. Request UI selects from every job, keeps unresolved jobs visible, prevents reopening a dispatched handoff and displays exact staged inventory and reserved result path. Idle is preserved separately from Unknown; activity/readiness refresh on timers.
5. **Review and export correctness (R6/R7 foundations):** a recorded reviewer needs a separate completed provider session and stored report. Different subjects, bundles or artifact sets cannot pool reviewer counts; a rebuttal supersedes that reviewer's first verdict within the exact scope. These checks do not prove blinded isolation or scientific approval. Project planning exports include scoped assignments/jobs/snapshots/messages/decisions/grants/events and available object bytes, exclude unrelated project records and retain the no-approval warning.
6. **Restore admission (R4-A):** the shared main handler tracks all asynchronous workspace calls, including account/metadata callbacks, not just request calls. Restore refuses while any such handler is active; all new handlers refuse during the locked prepare/confirm/commit interval. This prevents a late account observation from being committed into a replacement workspace. Source typechecked and built; the final desktop regression passed as V1 below.
7. **Containment (R1):** unchanged refusal before any probe effect. Updated its explanation to hosted verification/session reconciliation, since the local submission-tracking repairs now exist. Latest targeted probe suite passed 10/10.

**V1 — PASSED 2026-09-08.** The approval-review usage limit that blocked the rerun has since reset and the run executed normally; no workaround was used and no tool, account or execution mechanism was switched. Result: `node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts`, exit 0, report timestamp 2026-09-08T20:43:09.606Z, status PASS, 18 checks, `pageErrors: []`. Log: [v1-desktop-2026-09-08.log](../app/test-output/v1-desktop-2026-09-08.log); the source was rebuilt first, log [v1-build-2026-09-08.log](../app/test-output/v1-build-2026-09-08.log). The earlier failure evidence is preserved. One correction was needed and is recorded in section 11: the restore-lock assertions ran and passed, but the report's `checks` array never named them, so the saved evidence understated what had been verified.

The original packet, kept as the record of what was required:

- File: app/tests/desktop.e2e.ts. The new controlled-promise test pauses the actual restore confirmation dialog, asserts state/account bridge calls refuse while locked, declines restore, then confirms the workspace is still usable. The earlier concurrent-missing-ID smoke is not a substitute.
- The first new inert-profile fixture used invalid account/timestamp fields; corrected and a desktop run passed at 2026-09-08T18:52:42.512Z. The subsequent restore-lock test first tried writing a backup inside the protected live workspace; the application correctly refused. Its path is now app/test-output/r-local-admission-backup.zip, outside the isolated live workspace.
- The corrected rerun did not start: automatic approval review rejected it due to a usage limit and explicitly prohibited an indirect workaround. This is a validation blocker, not a code-test failure and not evidence that Claude sign-in is missing.
- When the approval mechanism allows the action, run from app: node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts. Preserve the existing failure log; write a new dated V1 log. No provider session is required. Do not switch tools/accounts/execution mechanisms to bypass the rejection. If source changed afterward, typecheck/build the changed source before the desktop run; do not rerun the entire suite merely to inflate evidence.
- On PASS record the actual report timestamp and command exit code, update R4 to VERIFIED_LOCAL and move the next pointer to C1. On failure fix the specific assertion and retain its evidence. No packaging or live readiness claim follows from V1.

Current remaining program: C7 plus the open C4–C6 subitems in section 11, with R5 independently required for live stages. R6/R7 are not complete merely because they are mapped to C items. Source swap-and-restore races and cross-platform Git commit reproducibility remain explicit R2 limitations; do not claim unsupported filesystem isolation.

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

### R0. Restore the current regression baseline — COMPLETE 2026-09-08

Status: done. The repair, changed files, commands and remaining caveat are recorded in section 11. The description below is the original defect statement, kept as the record of what was wrong.


The audit ran all 173 unit tests: 164 passed and 9 failed. Three failures are in tests/activity-queue.test.ts and six in tests/cooperation.test.ts. Every failure stops at assertHostedExecution via AssignmentController.dispatch with “Only constrained provider-hosted execution is allowed; no local or Colab access.” Source inspection shows dispatch passes constrainedTools: assignment.delegation === false; GROUP fixtures use delegation, so delegation policy and tool confinement are conflated.

Original R0 acceptance instruction (fulfilled; do not repeat as the next task): reproduce those two files, and separate the request's explicit collaboration/delegation policy from verified tool confinement. Keep provider hosting, no-local-execution and no-Colab guards intact. Do not simply bypass the guard for group mode or change every fixture to SINGLE to obtain green tests. Verify that allowed explicit group work proceeds under the fake adapter with properly scoped confinement evidence while uncontrolled delegation/local execution still fails. Inject a consistent clock through controller/readiness tests; several fixtures use fixed September 8 timestamps while readiness consults Date.now(), so future test runs must not depend on the calendar date.

Exit: both failing suites and the full unit suite pass, typecheck passes, and negative confinement/delegation tests remain meaningful. Record actual counts and commands in section 11 of this roadmap. No provider calls required.

### R1-A. Task packet — containment only (COMPLETE 2026-09-08)

Status: done and VERIFIED_LOCAL. The packet below is kept as the record of what was required. Result, commands and the one recorded deviation are in section 11.

**Objective:** make the currently exposed session-creating verification action unable to contact a provider or create local probe state. Keep account reads, historical evidence and local module diagnostics available. R1-A is a small fail-closed product fix, not the full probe redesign or a live capability test.

**Read only to start:** section 1.1 boundaries; this task packet; main.ts office:verify-transport handler; renderer/agents.tsx ProviderConnections probe state/buttons; preload.ts verifyCloudTransport; shared/types.ts OfficeAPI signature; desktop.e2e.ts bridge/Settings assertions. Expand into probe.ts/pty.ts to confirm there are no other production probe callers. Keep R0 controller changes intact.

Current path: Settings “Verify cloud transport…” → confirmation → “Create one real session now” → window.office.verifyCloudTransport → office:verify-transport → module check/account observation/new PtyCloudAdapter/probeCloudTransport. Existing confirmation is not containment; main must deny stale or direct bridge calls too.

Implementation sequence:

1. Preserve the narrow OfficeAPI/preload method for compatibility. In its trusted main handler, validate the existing input shape, then reject with a stable descriptive error before tool-path lookup, account observation, adapter construction, directory creation or any provider process. Suggested text: “Cloud transport verification is temporarily unavailable while submission tracking is repaired. No probe was started by this action.” This claim is only valid because rejection occurs before effects; it says nothing about the historical session.
2. Remove the live-create confirmation flow and its reachable buttons from ProviderConnections. Show a disabled action or an explanatory status: “Cloud transport verification unavailable — submission tracking repair required.” Remove now-unused local state/handlers/imports. Do not erase old capability snapshots, fabricate UNAVAILABLE provider evidence or ask users to sign in again.
3. Keep Check account, provider-usage links, existing connection display and getInfo transport-module status behavior. “Module available” must not mean “cloud verified.” Do not change ordinary handoff/dispatch routes in this slice; their R2–R4 repairs remain tracked.
4. Keep existing probe/PTY internal implementation and fixture tests for later R1-B work. Remove unused production imports where appropriate. No renderer/environment override, feature flag or hidden endpoint may re-enable creation. A UI-only disabled button is insufficient.
5. Add a regression through the actual desktop bridge: direct valid verifyCloudTransport input rejects immediately; repeated calls reject; state/evidence is unchanged. Add appropriate main-side fixture/spies if needed to prove zero account observation, adapter submit and staging calls without contacting a real provider. Keep injection test-internal, not an additional production bridge. Verify the old live-create confirmation cannot be opened in Settings and unaffected diagnostics remain visible.
6. Run one post-edit verification set: typecheck, full unit suite, build and the development desktop suite covering the changed Settings/IPC behavior. Do not rerun unrelated research or packaged suites absent a package change/new failure. If packaging this round is explicitly included, also run packaged desktop checks; otherwise report source/dev validation only. A failure justifies a targeted fix and rerun of affected checks, not hiding the earlier failure.
7. Update this task/progress row, relevant map hashes, changed files, exact commands/exit codes and a new dated log in section 11. Preserve the 175-test R0 log. Record actual test count after new regressions; do not assert the count must stay 175.

Completion: no production route from the verification control or direct bridge call creates a session/probe; no account/probe effects occur before rejection; metadata/module diagnostics are usable; current tests plus containment regression pass; no stored provider capability or historical session is rewritten. Mark **R1-A VERIFIED_LOCAL**, not “R1 complete” or “cloud verified.” Next code item is R2; finish R1-B only after R2/R3/R4 prerequisites.

Explicit exclusions: no live probe/attach/new fixture; no Serena installation/MCP setup; no schema migration; no training/backtesting; no rework of R0's defensive SINGLE invariant; no expansion into C1–C7.

### R1-B. Remaining probe/receipt redesign — COMPLETE 2026-09-08

Status: done and VERIFIED_LOCAL for R1 steps 2, 3, 4 and 5. Step 6, reconciling the historical session with the provider, still needs external access and is untouched. The probe implementation is repaired but the action stays contained: R1-A containment is deliberately not lifted, because that needs R5 live evidence. Details in section 11.

The parent R1 contract below remains unfinished after containment. Use real R2 snapshots, R3 exact evidence/fresh account and R4 durable intent/lifecycle. Replace the contained handler only when its full tests pass, and retain live release gates; no mere re-enabling of the old probe. Decoder tests must include partial identifiers and false/echoed URLs. Record unresolved attempts across restart. The actual historical cloud job still requires allowed reconciliation before another fixture.

### R1. Full transport probe and receipt contract (P0; R1-A + R1-B)

Evidence: main/probe.ts creates a plain directory with a fabricated stagingCommit and manifest hash; no Git repository is initialized. It calls adapter.submit without a durable intent, removes staging in finally, and records any error as “did not produce a session.” The UI can repeat the probe. main/pty.ts readReceipt accepts any session-looking substring, including an identifier prefix at the end of a partial chunk. Requested model is recorded as submission scope even though plan() does not pass a model.

1. Until repaired, disable the session-creating Verify transport action in main and renderer; retain metadata/module diagnostics. Do not exercise it during this audit or treat installed node-pty as cloud readiness.
2. Reuse real generated-only snapshot preparation: create and validate an actual one-commit fixture, manifest and hashes. Never fabricate identifiers or commit hashes to pass a production contract.
3. Persist probe intent and account/context/tool/route before the external call. Persist receipts immediately. A timeout/exit/persistence failure after launch is UNKNOWN, never proof of non-submission. Retain enough staging/provenance to reconcile and reject another probe while an attempt is unresolved.
4. Require a complete framed creation receipt, bounded identifier and official URL; arbitrary echoed IDs, unrelated URLs, ANSI fragments and truncated IDs cannot establish acceptance. Do not terminate on a prefix that happens to meet a minimum length.
5. Record only exercised submission evidence. Do not claim applied/requested-model scope is verified when no model was selected/observed. Parse allowlisted failure metadata rather than persisting raw CLI exceptions that may contain secrets.
6. Reconcile the existing historical session before authorizing an additional fixture; preserve the prior approval rejection as history, never bypass it. Missing provider access does not block steps 1–5.

Acceptance: no provider call before durable intent; real Git fixture verified locally; one unresolved attempt prevents duplicates across restart; timeout remains UNKNOWN; write failure preserves reconciliation; receipt tests split within a valid-looking ID and include unrelated/echoed IDs; model evidence stays unverified. No live call required for these regressions.

### R2. Make input snapshots exact, recoverable and safe to transfer (P0)

Current review status: PARTIALLY_VERIFIED_LOCAL. Preserve implemented namespace/inventory/object-storage helpers. R2-B and R2-A above are still required; output allocation/reconstruction are not yet application workflows. The original defect/contract below is historical target context, not a claim the old code is unchanged.

Status: **complete 2026-09-08**, with one part of item 7 blocked. Items 1–6 are implemented and regression-tested. The only outstanding part is item 7's actual transport bundle-limit verification, which cannot be measured while R5 has no available transport; the 64 MiB app limit and the preview-versus-transferable rule are enforced. Details in section 11.

Evidence: main/locations.ts copies selected bytes and records hashes, then overwrites root README.md and office-manifest.json with generated files. verifyStagedSnapshot() checks selected-file hashes only and has no caller in dispatch/handoff. main/artifacts.ts backs up the database and artifact objects, not snapshot file bytes; the location backup test verifies records rather than reconstruction.

1. Put generated bookkeeping in a reserved namespace and reject explicit collisions before copying. Preserve a selected README.md byte-for-byte; include generated content and exact inventory in the verified manifest. Do not let generated files or Git ignore rules silently change the intended upload.
2. Validate the complete staged tree and Git commit/tree against the frozen manifest immediately before every handoff or automatic submit. Detect missing/changed/extra files, changed HEAD/history, generated manifest tampering and symlink/reparse substitutions; call this check from the actual transfer path, not just tests.
3. Isolate Git from inherited GIT_DIR/GIT_WORK_TREE/config/template/filter/hook overrides and selected executable configuration. Keep staging bookkeeping from invoking user code. Reject junction/reparse traversal in the root and every path component, including links that resolve inside the root. Guard validation-to-copy races.
4. Store copied bytes as durable content-addressed objects and include them in both backup formats. Reconstruct staging from those bytes after restore without reading the old source folder. External source folders remain excluded; frozen bytes deliberately selected for a request are workspace-owned input objects. Legacy snapshots with missing bytes must be marked unreconstructable and require explicit re-preparation, never silently reread sources.
5. Validate request ID/revision and location revision for text-only and selected-file snapshots alike. Repeated preparation must either reuse the same frozen intent or explicitly produce a new version without leaking staging directories or associating the wrong request's inputs.
6. Finish writable destination checks, managed versioned output allocation by project/request/assignment/attempt, and collision policy. A readable read-only input is valid; an unwritable output destination blocks transfer. Show exact files, bytes and requested destination before sharing.
7. Keep the 64 MiB selected-byte app limit and additionally verify actual bundle limits when the transport is available. Git unavailable may leave a clearly labeled local preview, but never a transferable snapshot.

Acceptance: selected README/manifest collisions; tampered/extra staged files; changed commit; inherited Git hook/filter/config fixtures; junction and source-swap fixtures; backup → remove original staging/source in disposable fixture → restore → byte-exact reconstruction; wrong-request/revision input rejected; output write/collision checks. Do not mark metadata-only backup tests as satisfying reconstruction.

### R3. Finish exact capability scope and fresh-account enforcement (P0)

Current review status: PARTIALLY_VERIFIED_LOCAL. RequestedScope and exact policy values are useful progress; R3-A and the shared handoff guard in R4-A remain. Do not mark complete from the four new readiness tests alone.

Status: **complete 2026-09-08.** Items 1, 3, 4 and 5 implemented; item 2's remaining untested cases (clock skew, future timestamps) added, with its existing invalidation, A→B→A, metadata-deduplication and per-operation expiry behaviour preserved. The R0 delegation check has been replaced by exact scope semantics, as this item required. Details in section 11.

R0 is a local regression repair, not proof that the complete confinement contract exists. Its current DELEGATION_CONTROL evidence check must remain until R3 adds exact policy semantics. Distinguish capability to control delegation, whether this assignment authorizes delegation, and which tools/network/filesystem scopes were actually confined. Introduce explicit confinement evidence or an equally strict typed policy record; the mere existence of a DELEGATION_CONTROL operation must not certify every tool restriction. Preserve R0 positive-group/negative-hosting and clock regressions while strengthening this gate.

Evidence: shared/readiness.ts selects evidence by connection/tool version, but does not compare the chosen transport to a requested adapter route. Missing model/environment fields can match selected scope; dispatch callers omit environment, and effort/delegation values are not represented as exact requested scope. Account freshness is a five-minute cached check, not a new check at launch. The single native controller is a Claude terminal adapter even when a request selects an OpenAI profile.

1. Define one normalized scope: provider, connection identity, credential context, installed tool/version, adapter route, environment identity, selected model, exact effort and delegation policy. Require all relevant operation evidence to match this scope; allow provider-wide catalog metadata only for catalog display. Do not combine incompatible operation scopes into ready.
2. Resolve evidence by immutable observation/invalidation order; test clock skew, future timestamps, context changes and A → B → A without resurrecting stale transport verification. Keep the implemented metadata deduplication and per-operation expiry behavior.
3. Main rechecks the official account immediately before any external handoff/submit and commits that observation durably. Revalidate after async boundaries and against the frozen assignment binding. UI freshness alone authorizes no external call.
4. Route by provider and supported adapter explicitly. Reject OpenAI assignments through a Claude adapter and reject unsupported routes without substitution. Automatic Start must consider adapter implementation availability as well as evidence. Preserve the labeled handoff's distinction from enforced model/effort/delegation guarantees.
5. Preserve original setup identity separately from current bound identity. bindAgentConnection currently replaces agent.account on CHANGE although the UI describes it as setup identity; migrate compatibly using historical events where recoverable and label uncertain legacy data honestly.

Acceptance: mixed transports/environments cannot become ready; absent scope cannot authorize exact controls; non-default effort and delegation mismatches block; account switch between preparation and launch blocks; failed observation write blocks; wrong-provider adapter never invoked; explicit rebinding preserves original history. Keep automatic Start unavailable until R5 is satisfied.

### R4. Repair controller lifecycle, frozen inputs and restored services (P0)

Current review status: PARTIALLY_VERIFIED_LOCAL. Frozen data and controller rebuilding exist; R4-A/R4-B plus R2-A exact identity/output integration remain. The two listed open items in the previous report were not the complete residual scope.

Status: **complete 2026-09-08** for items 1, 2 (except multi-job aggregation), 3, 4 and 6. Item 5 is partly done: cancellation is preserved against stub observations, but the allowed-actions projection is not yet wired through the renderer. Details and the exact remainder are in section 11.

Evidence: main/controller.ts uses the current request objective at launch and gates the current agent without checking all frozen revisions/identity/settings. createAssignment validates a snapshot's project but not exact request/revision. observe() labels adapter UNKNOWN placeholders PROVIDER_REPORTED. main/main.ts restore replaces store/artifacts but leaves controller referencing the closed store; dispatch and transfer use separate busy flags.

1. Persist the complete frozen request/profile payload required by the adapter (objective, acceptance criteria, instructions, model/effort, account binding and all effective capability IDs), not only a hash or latest metadata snapshot. At launch either use that immutable payload or reject changes and require explicit re-preparation. Never mix a current prompt with old input hashes/account provenance.
2. Require snapshot request/revision/location matching and participant eligibility. Enforce request/project cancellation/archive status through every prepare/handoff/submit path, not just initial creation. Multi-job requests aggregate all applicable jobs; the latest assignment cannot hide another active job.
3. Coordinate workspace replacement with all async request and file operations. After restore rebuild the controller/adapters against the new store and reconcile deliberately. Test restore followed by prepare, observe and cancel; never access a closed pre-restore database.
4. Extend adapter observations with honest provenance and unsupported/no-observation outcomes. An adapter-generated UNKNOWN explanation is OFFICE_LOCAL, not provider testimony; do not overwrite known receipts or cancellation state with a stub result. Fetch output bytes into managed storage and verify hashes before recording deliverables as retrieved.
5. Preserve cancellation requested until provider acknowledgement; adapter errors and late output stay attributable. Distinguish local pre-submit cancellation labels from provider acknowledgement. Wire one allowed-actions projection through buttons and store guards, including repeated handoff attempts and terminal jobs.
6. Match the user preview and actual handoff objective/instructions, and remove launcher failure wording “Nothing was submitted” when external acceptance is unknown. Preserve command quoting and official subscription-only environment handling.

Acceptance: edit/rebind/cancel/archive after prepare; wrong-request snapshot; restore while an async action is pending; unsupported observation cannot create provider evidence; late completion/cancel failure; all-job queue counts; exact preview-to-submission payload; actual output bytes required for retrieved-output claims.

### R5. Complete and verify the hosted single-agent path (release gate)

The PTY implementation, native module inclusion and local terminal smoke are foundations, not this gate. main/pty.ts observe() always returns UNKNOWN and cancel() always returns acknowledged:false; there is no complete output/follow-up implementation. main/main.ts still selects TerminalHandoffAdapter for ordinary requests; no automatic dispatch handler is wired.

After R1–R4, establish supported official routes for observation, visible events, output retrieval, follow-up where required, cancellation request/acknowledgement, actual model/effort, managed environment and delegation controls. Verify against the installed provider tool and account; browse primary provider documentation when implementing external behavior. Never substitute APIs, local research, self-hosted routing or Colab. If controls remain unsupported, keep automatic dispatch blocked and retain the truthful partial handoff.

Acceptance: one permitted tiny hosted assignment with real ID, exact selected input bytes, verified settings/scope, visible output downloaded and hashed, restart reconciliation, no duplicate dispatch, provider-acknowledged cancellation on a suitable test. Test real native PTY startup/cleanup under packaged Electron (including missing/incompatible module), not only Node or require() success. Record exact evidence and unresolved job IDs. Do not create a new session just to refresh evidence while an older fixture is unresolved.

### R6. Finish cooperation, independent review and scientific workflow (implemented through C1–C6)

Status 2026-09-12: VERIFIED_LOCAL for the local scope. Scheduler delivery, isolated reviewer contexts, sealed first rounds, versioned subject/run bindings, gate-linked decisions and traceable export are implemented and exercised end to end with synthetic receipts (section 12.1). The independence and delivery-provenance acceptance below still requires real external reviewer runtimes; fake-adapter and LOCAL_FIXTURE evidence remains insufficient for a scientific completion claim. The packet below is kept as the record of what was required.

Preserve implemented teams/memberships, role-slot resolver, dependencies, scoped message storage and immutable decisions. Add the missing scheduler/provider delivery and reviewer-context creation; data records alone do not deliver messages or prove independence. Require eligible bound profiles, actual dependency outputs and explicit group/team scope; single-agent requests must never gain collaborators implicitly.

The local repair pass now requires a separate completed reviewer session with a stored report and prevents pooled approvals across subjects/bundles/artifact sets. These checks are foundations, not proof of isolated reviewer inputs. Still implement delivered context provenance, blind first-round sealing, versioned scientific subject/run bindings and gate-linked approval under C1–C6. Preserve self-review labels and imported-result quarantine. Connect decisions to scientific gates and release manifests only when those checks exist.

Acceptance: scoped provider delivery receipts, independent context provenance, no pooled approvals across subjects, revision/output invalidation, missing reviewer outcome, explicit participant policy, end-to-end amended-workflow review and traceable finalized export. Fake-adapter tests are necessary but insufficient for a scientific completion claim.

### R7. Finish UI, scale, exports and migration integration (implemented through C7)

Status 2026-09-12: VERIFIED_LOCAL. The paragraphs below are the original packet. The items they describe as outstanding are now done: desk-to-room travel and return with stable persistent placement, unified profile/effort saving with draft conflicts, request/assignment-scoped navigation, the C4 review UI, bounded cursor queries in place of full projection/event/message loads on every push, derived SQLite read indexes, snapshot objects in both archive formats and the scoped research export. Measured retrieval and scale results are in section 12.1; no provider token or quality claim is made.

Already present: officeActivity reducer and OfficeScene connection; project/agent/team queue filters; Profile/Assignments/Conversation/Logs tabs; SQLite history/log/job-event page APIs and paged views; streamed large-backup format; backed-up idempotent legacy request migration. Do not implement duplicate alternatives.

The local repair pass preserves IDLE/UNKNOWN, adds timed freshness and multi-job selection/history with reserved-output preview. Remaining C7 work: real desk-to-room/return movement and persistent room placement, unified profile/effort saving, complete request/assignment-scoped navigation, eligible team selection and review UI around C4. Sorted meeting IDs are not a persistent room-allocation mechanism.

snapshot() still reads full projection and all events, and legacy ActivityView still loads complete work logs. Migrate consumers to bounded query APIs and avoid full events/jobEvents/messages on every state push. Benchmark growing workspaces and main-process responsiveness; streamed archives alone do not prove bounded memory or nonblocking work. Include R2 snapshot objects in both archive formats. Project planning exports now include scoped request/assignment/message/review/output provenance and available byte objects, with an unrelated-project exclusion regression. C6/C7 still need finalized scientific package contracts and larger-scale export behavior; these planning archives confer no approval. Keep legacy ambiguous work unverified after migration and expose a clear migration summary/recovery path.

Acceptance: meaningful large-data fixtures with measured latency/memory, stable cursor paging during new events, desktop coverage of all new tabs/location/binding/handoff/probe-disabled/restore paths, workspace round-trip including input/output objects, exact project export scope. Release version/package only after source validation; do not overwrite historical reports.



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

Branch states: DRAFT → FROZEN → ACTIVE → AWAITING_ADJUDICATION → AWAITING_HOLDOUT → SHADOW → MONITORING → RETIRED, with BLOCKED, INCONCLUSIVE and INVALIDATED outcomes. Stage state: PENDING → READY → RUNNING → PASSED/FAILED/BLOCKED/UNKNOWN/CANCELED. Keep provider job state separate. A completed remote job can still yield a failed scientific gate.

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

Enforce grants in retrieval/export/indexing and remote tool configuration, not only prompt text. A fresh chat in a shared unrestricted filesystem is not blinded. Search snippets, embeddings, cached answers, filenames, metadata counts and summaries must not leak restricted performance/holdout information. Disable broad filesystem/network/tool access to restricted stores where the provider permits it. If isolation cannot be verified, label REVIEW_UNBLINDED or HOLDOUT_UNSEALED and block the corresponding independent/holdout promotion.

For correctness, use an isolated source/synthetic-data packet; candidate real performance is computed later or stored in a separate inaccessible namespace. If a reviewer needs extra material, main validates an explicit scope expansion and logs it; material performance exposure invalidates blinding and requires another clean reviewer context. Do not let a builder suppress full dependency inspection by providing only favorable diffs.

### 6.4 Evidence/query/cache interfaces

Proposed main service operations: storeOutput(manifest,bytes), describeArtifact(id), queryEvidence(ref,query,cursor), readEvidence(ref,range), prepareContext(stageAttemptId), lookupComputation(key), recordComputation(receipt), invalidateDependencies(changedHashes). Renderer-facing endpoints take IDs and allowlisted query schemas; they never execute arbitrary code. Authorized research query scripts run through the provider adapter, return immutable receipts and have resource/timeout limits.

Start with exact text/JSON/table-slice retrieval; optional symbol indexes later. Stable cursors bind artifact hash/query/order; changing the source invalidates the cursor. Return totals or UNKNOWN_TOTAL explicitly. Raw expansion remains scoped and paged, with no silent truncation. Whole-file requests may be chunked, never silently replaced by a model summary. External artifact text is untrusted data and cannot modify workflow grants.

Computation cache key = hash(input artifact hashes + normalized query + analysis code/lockfile/environment hash + semantic config + seed/randomness policy + output schema). Nondeterministic execution records variability/tolerance and cannot claim bitwise reproducibility from a seed alone. Interpretation key additionally includes exact prompt/model/effort/context/disclosure-policy hashes; origin/provenance is visible. Authority/readiness and current gate standing are re-evaluated on every reuse. Different reviewer contexts cannot reuse one another's interpretation. A reused result creates a reuse receipt, not a fabricated fresh run.

## 7. Full research workflow S0–S10

This is a TEAM/explicit research template, not a mandatory path for questions, ordinary code review or SINGLE requests. Non-empirical work uses request → prepare → execute → evidence → optional authorized review. Any claim promoted as independently validated research must satisfy its applicable gates even if the user originally requested one agent; offer the needed explicit scope change, never silently add reviewers.

Model assignment is data: stage function → eligible profile ID/revision → verified provider/model/effort. Default director uses an eligible Claude profile because that is the user's established preference. Builder and advocate must be different assignments; builder is not counted as an independent advocate/reviewer for its own work. Correctness and skeptic require separate fresh contexts. Cross-family reviewer diversity is desirable when available, not a substitute for isolation or a hardcoded model entitlement. No automatic cheaper-model substitution.

### S0 — Register and freeze before candidate evaluation

**Owner:** Director prepares; main validates schema and ledger; deterministic custodian records holdout scope. Existing known performance is disclosed, never relabeled a prediction.

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

Mechanical failures block absolutely. Reviewer can identify an untested issue: append a defect and a failing regression, mark REVIEW_BLOCKED, then repair and rerun. A finite CI suite does not prove absence of every bug. Output sealed CorrectnessReport bound to candidate/spec/check-code hashes plus actual context isolation receipt. S2 PASS requires mandatory checks PASS and no unresolved correctness defect; not a favorable Sharpe.

### S3 — Run the candidate and capture verified artifacts

**Owner:** controller and verified hosted execution; deterministic manifest validator. Inputs: S0 frozen version and S2-approved candidate.

Run only registered train/selection/outer-evaluation procedure. Preserve every fold/model/config/seed, failed trial, stdout/stderr, exit status, prediction row keys, model files, data availability contract, resource/provenance and final status. Store metrics separately from S2 access. Check one out-of-fold prediction per expected eligible row (or declared repeats), no training-row masquerading as evaluation, matching labels and manifest inventory.

G-ARTIFACT requires verified output bytes, complete split/prediction coverage or predeclared missingness policy, matching input/code/environment and actual run provenance. Partial/failed runs are evidence but do not pass as complete. A manually returned CatBoost result without pre-run registration is EXPLORATORY_IMPORTED: verify/archive it, perform diagnostics, and create a new prospective branch for confirmation; never manufacture a past S0 or unseen holdout.

### S4 — Evaluate the signal and look for unexpected findings

**Owner:** deterministic diagnostic scripts plus scoped analysis worker; no new training/selection on outer evaluation. Inputs: verified S3 prediction/label data, fold/slice definitions and primary/secondary metric plan.

Compute applicable forecast loss/calibration and naive/linear baselines; cross-sectional Spearman rank IC per decision date with sample counts, average IC and dependence-aware uncertainty; horizon decay; bucket/decile spread and monotonicity; hit rate with denominator/decision definition. For single-series/non-cross-sectional work use the preregistered alternative, not fake IC. Slice by frozen year/regime/sector/liquidity definitions where populated; regime labels used for trading must be available at decision time.

Use HAC or block bootstrap as preregistered for autocorrelated/overlapping outcomes, with declared lag/block rule and coverage; do not use naive independent-observation t-statistics. Record insufficient-sample slices as BLOCKED/diagnostic insufficient, not zero effects. Include all failed/pruned variants in selection accounting. DSR or another justified multiplicity method must record assumptions and trial dependence; no automatic significance from an unadjusted large statistic.

Two paths: decision-focused metrics answer the S0 question; discovery path inspects extreme tails, missing/failed runs, chronology, sector/liquidity concentration, variance, duplicates and negative controls, plus reproducibly selected varied samples. Feature stability uses declared importance method, correlated feature groups, fold prediction agreement and allowed ablations. Importance rank shuffling is a flag, not an automatic hard failure.

Outputs: full diagnostics, plot/table artifacts, GateReceipts for preregistered criteria and EvidenceBrief with counterevidence/coverage/unperformed checks. Unexpected finding triggers investigation/retirement, not hidden retuning. New research analyses that create selection opportunities append a trial/variant; exploratory slice results cannot be promoted as preregistered confirmatory findings.

### S5 — Translate predictions into positions using the frozen rule

**Owner:** deterministic portfolio engine; build lead diagnoses implementation failures without tuning. Inputs: S3 predictions and S0 portfolio contract. Code was built in S1; S5 applies it.

Compute lagged tradeable signals, normalization using permitted training/history, size/neutralize/cap positions, handle unavailable assets, enforce turnover/liquidity, and produce target position/order-intent artifacts (no broker orders). Record infeasible constraints, rounding and unallocated exposure. Every alternative neutralization/sizing/rebalance rule is a registered variant; choosing the best after seeing S4 remains development selection and requires new evaluation evidence.

Output portfolio manifest, positions by timestamp/entity, exposure/turnover diagnostics and G-PORTFOLIO receipt. Cannot advance with missing rules or hidden default tuning. Portfolio variant trial count stays in family ledger.

### S6 — Backtest net economics and robustness

**Owner:** deterministic backtest/cost engine over approved outer-evaluation results. Do not rerun model fitting on test data to improve S6.

Generate gross/net return series, fees/spread/slippage/impact/borrow/financing breakdown, turnover, holding periods, exposure, drawdown/recovery, net risk-adjusted metrics with uncertainty, capacity scenarios and reference baseline. Document annualization frequency/risk-free convention and irregular timestamps; undefined Sharpe is not a pass.

Run preregistered base/1.5×/2× variable-cost diagnostic sweep (fixed fees retain their defined treatment), turnover/capacity and data-delay stress; record what is estimated versus observed. Frozen economic thresholds determine G-ECON. Arithmetic G-COST/G-TRADETIME/G-PORTFOLIO failures invalidate output; economically weak but correctly computed output is VALID_NEGATIVE and retired unless the predeclared follow-up process applies. Never lower S0 thresholds after a weak result.

No assertion that “walk-forward” alone removes leakage. Training/selection design from S0 and G-SPLIT remains binding. Outputs: complete net/gross series, cost audit, stress matrix and brief with evidence refs. Hard integrity/correctness/economic gates must pass for holdout eligibility; a model discussion cannot waive them.

### S7 — Independent advocate/skeptic and bounded adjudication

**Owner:** two separate assignments receiving the same S3–S6 development evidence version; director adjudicates after immutable first reports. Correctness reviewer conclusions may be available now but are not replaced by the debate.

Advocate: strongest evidence-supported real-effect case, economic mechanism, baseline comparison, counterevidence and explicit falsification tests. Skeptic: up to three concrete artifact explanations ranked by evidence (e.g. availability error, selection/regime concentration, execution-cost sensitivity), each with locator, proposed discriminating test and predicted result. They may agree the effect is absent/uncertain; neither must defend a prescribed conclusion. Both have full permitted retrieval, not only an analyst summary.

Seal first reports; only then allow one bounded response each to named contradictions. Director records PROMOTE_TO_HOLDOUT, RETIRE, INCONCLUSIVE, or DECISIVE_TEST. Promotion requires all current mandatory gates and independence evidence. The one decisive test is preregistered on development data, with outcome-to-decision mapping and no holdout access; after it, adjudicate once without further scientific follow-up for this candidate lineage. If new work is warranted later, create a linked branch with shared family trial/exposure history. A correctness defect returns to repair/versioning, not debate.

### S8 — Final holdout evaluation by a deterministic custodian

**Owner:** policy service and isolated evaluator. No agent can fetch holdout through general search or request custom slices to tune a candidate.

Prerequisites: S7 promote, current gates, untouched holdout version, fixed candidate/training/refit recipe, unused reservation allowance and verified data isolation. Freeze any final train-on-development refit recipe at S0; bind the final model/recipe hash before unseal. If provider capability cannot isolate data from builders/director, block protected evaluation rather than relying on a “do not look” prompt.

Reserve exposure atomically before releasing sealed data or a one-time evaluation package. Log all views/queries/results as exposure. Default one candidate evaluation per holdout version and one workspace exposure per quarter; these are conservative product policies, not statistical corrections. Byte-identical retrieval of the same completed report consumes no new candidate trial; changed candidate/query/fitting against holdout is prohibited. Crash after release is EXPOSURE_UNKNOWN and consumes reservation pending reconciliation. Backups cannot roll the counter backward; reconcile an external exposure anchor/custodian journal or mark holdout spent/unknown after restore.

Return only preregistered final evaluation outputs and gate receipt. Compare with S0 prediction after evaluation. Failure retires or becomes inconclusive according to frozen policy. New tuning after viewing results makes that data development evidence forever; a new independent holdout requires new data and policy registration. No quarterly reset makes previously exposed data unseen.

Manual external execution: reserve before exporting the exact holdout evaluation package; an imported result stays user-attested until provenance/isolation can be verified. Do not connect to Colab or execute there. No sealed data/keys in ordinary workspace backups accessible to research agents. Local event/hash storage alone is not a secure holdout custodian.

### S9 — Shadow evaluation with no capital

**Owner:** prospective signal-generation process in an authorized environment, with manual artifact handoff when direct hosting is unsupported. The desktop does not place orders or start a market-data subscription.

Use the frozen signal/portfolio version; timestamp predictions before outcomes. Capture stale/missing inputs, latency, calendar issues, borrow assumptions, availability, simulated fills, missed signals, cost estimates, risk/exposure and realized subsequent market returns. Compare backtest distributions and operational assumptions, not only costs. Predeclare minimum elapsed time, independent observations and coverage; too little data is INCONCLUSIVE.

Output shadow manifest/diagnostics and G-SHADOW receipts. Clearly distinguish SIMULATED_FILL, OBSERVED_MARKET_QUOTE and ACTUAL_EXECUTION_IMPORT. Shadow/paper alone cannot validate own-order impact, queue priority or real slippage. Actual fills, if later supplied by the user, are separate evidence with provenance; this plan authorizes no capital experiment or broker integration. Passing S9 means shadow-qualified evidence, not permission to deploy money.

### S10 — Monitor, suspend and retire

**Owner:** deterministic policy evaluation plus scheduled-review records evaluated when supported/manual evidence arrives. This roadmap creates no desktop automation implicitly.

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
- Research detail shows stage timeline, current version, next allowed action and exact missing gates, separate job state and scientific outcome. Button labels reflect action: Prepare, Open official handoff, Submit verified job, Review evidence, Register decisive test, Request holdout evaluation, Import shadow results, Retire.
- Role/stage assignment editor selects actual existing profiles. Display provider/account/model/effort readiness and context-isolation support separately. No hardcoded product model tiers or automatic four-PM population. Old role labels remain historical; reusable functions are BUILD/CORRECTNESS/ADVOCATE/SKEPTIC/EXTRACTION/DIRECTOR.
- Run page shows manifest, logs, prediction/portfolio/cost artifacts, diagnostics, coverage, source hashes and reuse origin. Selected-file disclosure preview lists exact inputs/bytes and requested managed environment; no cryptic internal transport configuration in the ordinary user flow.
- Evidence reader shows source/coverage/omitted counts and one-click expansion within grants. A warning means missing evidence, not a request to accept reduced quality. Blinded screens/services cannot reveal restricted performance through names, sort order, badges or counts.
- Review page labels independent provider-reviewed, user-attested, self-review, unblinded and stale explicitly. No single “Approved” badge inferred from two profiles on the same request. Display exact subject/output/spec hashes and unresolved issues.
- Ledger displays all trials/variants, negative outcomes, branch ancestry, predictions versus observed results, holdout exposure/reservations and policy revisions. Restoring a backup cannot visually hide unresolved exposure.
- Holdout UI explains immutable candidate and exposure consumption before the authorized action; no sliders or repeated custom queries after unseal. Missing isolation is a blocker with a specific remedy, never a decorative lock icon.
- Shadow/monitor page separates simulated fills and real imported executions, signal reliability and performance. “Qualified” does not mean broker deployment. No money/order controls in this revision.
- Retain office visualization, queue filters, archived read-only profiles, revision-aware drafts, task-scoped logs and data export. Office movement derives from fresh provider evidence; no movement from imported transcripts or reports alone. Idle/Unknown distinction and timer refresh are implemented. Travel/return movement and stable seat and meeting-room placement are implemented and verified locally (section 12.1).

## 10. Ordered new implementation slices C1–C7

R0–R4 are prerequisites for integrating these records with external actions; schemas/reducers may be built with local fake adapters while R5 remains blocked. R5 is mandatory for live automated stages and verified hosted claims. Below, proposed files are additions under app/src; inspect existing code and reuse it before creating them. No new execution backend or optimizer dependency by default.

### C1 — Research spec, ledger and stage reducer — COMPLETE 2026-09-08

Status: done and VERIFIED_LOCAL for items 1–5, with the migration summary of item 5 recorded as not needed and why. All nine exit tests pass. The packet below is kept as the record of what was required; details are in section 11.

Prerequisites: R0/R4 lifecycle contract understood; fake adapter sufficient.

Files: shared/types.ts; new shared/research.ts and core/research.ts; existing core/store.ts; new tests/research.test.ts and ledger.test.ts.

Implementation:

1. Add strict schemas for ResearchBranch/FrozenResearchSpec/PredictionRecord/TrialLedgerEntry/StageAttempt/GateReceipt and function assignments. Use optional collections for legacy replay; keep old Role and Stage events unchanged.
2. Add narrow commands draftSpec, freezeSpec, registerVariant, createStageAttempt, recordGate and amendBranch with expected revisions/idempotency. recordGate evidence is internal main-only, not a generic renderer command.
3. Implement pure nextActions and transition reducer for S0–S10; table-driven prerequisites refer to exact subject/hash. Mandatory missing fields/gates block; legitimate NOT_APPLICABLE requires frozen rationale and applicability validation.
4. Add lineage-wide trial/followup counters; metadata-only retries do not create a new scientific variant, changed semantic outputs do. Preserve failures and canceled trials.
5. Add forecast/exposure bookkeeping and scientific outcome independent of provider completion. Add migration summary for legacy contracts; never auto-freeze or auto-approve old data.

Exit tests: immutable freeze; threshold mutation rejected; amendment creates linked branch; same idempotency key cannot duplicate; missing/old/wrong-subject gate blocked; negative result preserved; one followup allowance across renamed descendants; no automatic promotion on restore; historical event hashes unchanged.

### C2 — Artifact/query layer and evidence briefs — COMPLETE 2026-09-08

Status: done and VERIFIED_LOCAL for items 1–5. All eight exit tests pass. The section 8.4 token baseline was deliberately not run, so no efficiency claim is made here; it stays a C7 item. The packet below is kept as the record of what was required.

Prerequisites: R2 durable byte storage/reconstruction and R4 honest provenance.

Files: extend main/artifacts.ts and main/locations.ts; new main/evidence.ts, shared/evidence.ts; existing main/preload.ts and main.ts; new renderer/evidence.tsx; tests/evidence.test.ts and evidence-cache.test.ts.

Implementation:

1. Extend content-addressed object manifest with complete logs, inputs/outputs and permitted provenance. Reuse hash verification and both backup readers. Do not create a second unrelated object store.
2. Implement describe/read/query with line/row ranges, stable cursors and returned/omitted counts; enforce project/run/stage grants in main before index lookup or cache hits.
3. Validate EvidenceBrief/EvidenceRef/QueryReceipt schemas and references. Store raw output first; brief failure does not lose original results. Render exact source expansion and missing-coverage warnings.
4. Add dependency-keyed computation cache and interpretation isolation; current review/gate state checked on reuse. Store reuse receipts. No cache key based only on filenames or prompt text.
5. Integrate compact stage packet builder. Remote access uses the supported adapter route; a localhost path never passes as a hosted retrieval handle.

Exit tests: raw failure retained; empty search versus unknown index coverage; pagination through all matches; omitted critical finding recovered; grant leak attempts across projects/reviewers; changed dependency invalidation; backup reconstruction; partial upload retrieval failure remains explicit. Run section 8.4 baseline before claiming token savings.

### C3 — Deterministic research contracts and CatBoost result ingestion — VERIFIED_LOCAL 2026-09-08

Prerequisites: C1/C2; real research execution still R5 gated.

Files: new shared/research-contracts.ts and core/research-gates.ts; extend main/artifacts.ts result importer; versioned hosted job templates under app/research-templates/ (data, diagnostics, portfolio and cost scripts); tests/research-gates.test.ts and research-import.test.ts. Template scripts are authored/exported/hosted, not run locally on user research by the desktop.

Implementation:

1. Implement exact manifest/split/prediction schemas and G-SPEC/G-TIME/G-SPLIT/G-FIT/G-TARGET/G-SELECT/G-TRADETIME/G-COST/G-PORTFOLIO/G-INTEGRITY/G-ARTIFACT contracts. Test formulas on hand-computed synthetic examples independently of the model.
2. Provide versioned synthetic golden fixture packets for leakage, timestamp lag, purging, encoding, turnover/net returns, costs and position constraints. Unknown/missing values block rather than coerce to zero.
3. Implement import validation for prospective and exploratory CatBoost results: source/data/model/config/seed/split/prediction inventories, exact hash matching and full failed-run ledger. Post-hoc submissions cannot invent prospective registration.
4. Implement diagnostic template output schemas for signal/prediction/slices/uncertainty/feature-group stability and cost/portfolio/backtest stress. Separate forecasts from economic significance; all real parameters supplied through S0.
5. Fit/predict/diagnostic execution generates receipts for exact template/dependency versions. Local receipt parser enforces semantics and provenance; it does not execute arbitrary uploaded code.

Exit tests: planted look-ahead/target leakage; duplicate OOF rows; wrong fit scope; malformed CatBoost manifest; no early-stop on outer test; hand-calculated gross/net/cost fixtures; insufficient data/undefined metrics; exploratory import cannot pass S0/S8; no local research fallback. Actual dataset performance is not a test requirement for this slice.

### C4 — Stage orchestration and independent reviews — VERIFIED_LOCAL 2026-09-12

Status: VERIFIED_LOCAL for the complete independent-runtime contract and application service workflow. Ed25519 authority/version pins, exact report/run/spec/input/output binding, durable review/harness/rebuttal intents, immutable S2/S7 contexts, blinded and same-evidence delivery, sealed first reports, atomic collection, bounded post-disclosure rebuttal, persisted adjudication, gate-history rechecks and lineage follow-up consumption are implemented and exercised through real store/controller/object services with an explicitly LOCAL_FIXTURE authority. Production R5, official isolated-context support and independently provisioned trusted transports remain BLOCKED_EXTERNAL; no hosted claim is inferred from the fixtures.

Prerequisites: C1–C3 and R4; fake adapter first, verified R5+isolation for live release.

Files: extend main/controller.ts and shared/cooperation.ts; new main/research-controller.ts, main/context-policy.ts; core/store.ts review methods; renderer research/review views; tests/research-controller.test.ts and blinded-review.test.ts.

Implementation:

1. Implement stage functions resolved to active eligible profile revisions; migrate legacy four-PM use to explicit function assignments only through an append-only project/template operation. Never silently change agents' provider or instructions.
2. Scheduler creates only next eligible assignments, with frozen context/output schema; bounded worker dependencies within S1 allowed. SINGLE path never invokes TEAM template by inference.
3. Build isolated S2 packet and same-evidence S7 packets, provider context receipts and sealed first reports. Enforce grants across file access, query outputs and interpretation caches. Unsupported isolation blocks verified review labels.
4. Amend recordReviewDecision/reviewStatus to require actual completed reviewer outcome, exact subject/run/artifacts and independence. Do not pool reviewer counts across subjects. Preserve one bounded rebuttal each and exact invalidation.
5. Implement adjudication reducer with four outcomes, one scientific followup and automatic recheck of all hard gates. Defects suspend affected lineage; no model “override” command.

Exit tests: sealed first reports cannot be read early; performance metadata/cache leaks denied; two subject reviews cannot combine; same-context/self-review denied as independent; failed reviewer result blocked; one followup across restarts; unsupported model/route blocks; correct SINGLE remains solo; director cannot promote through a failed gate. Live acceptance requires actual context isolation evidence, not fixture flags.

### C5 — Holdout custody and exposure accounting — VERIFIED_LOCAL 2026-09-12

Status: VERIFIED_LOCAL for registration, S8 prerequisite/result integration, exact candidate/refit/query identity, locked exposure accounting, non-restorable registration/journal/checkpoints, lost-delivery result recovery, restore reconciliation, replay and manual export/import semantics. The synthetic isolated evaluator receives only its declared bytes and prediction query. Manual returns remain USER_IMPORTED and cannot satisfy independently verified G-INTEGRITY. Real custodian isolation and R5 remain BLOCKED_EXTERNAL. No real holdout was used.

Prerequisites: C1/C2/C4, independent storage/access control capability; real protected run requires verified R5 route and custodian isolation.

Files: new main/holdout.ts and shared/holdout.ts; store reservation/exposure schemas; safe export/import and restore integration; tests/holdout.test.ts and holdout-recovery.test.ts.

Implementation:

1. Separate sealed bytes/keys and evaluator access from normal agent-visible workspace, backup, search and context packets. A table flag is insufficient. Initially provide a capability-checked custodian interface plus fake isolated evaluator; do not claim live sealing until access tests pass.
2. Persist atomic reservations/lineage budgets before any export/evaluation; validate candidate/refit hashes/gates and freeze evaluation queries. Default policies are section 6.1. Admission concurrency cannot double-spend allowance.
3. Maintain non-rollback exposure journal outside restorable research state or an independently verified custodian service. If unavailable, restoring any older backup marks affected holdouts spent/UNKNOWN and blocks reuse; never reset exposure using stale DB state.
4. Handle crash/lost receipt/partial delivery as possible exposure; only verified non-exposure can release a reservation. Fetching same completed report is idempotent, changed candidate is not.
5. Manual export path records exposure before handing out package and classifies returned evidence honestly. Unsupported custody leaves S8 blocked; no local token/file workaround.

Exit tests: parallel reservation, quarter boundary/timezone, old-backup rollback, lineage rename, altered candidate, evaluator data leak, index/cache leakage, failure after export, report replay, same report versus new query; denied unseal with any failed S2/S6/S7 gate. No real holdout is consumed by tests.

### C6 — Shadow, monitoring and research export — VERIFIED_LOCAL 2026-09-12

Status: VERIFIED_LOCAL for durable prospective batch ingestion, quote/outcome/fill consistency, separately sourced actual execution imports, frozen elapsed-time/observation coverage, monitoring standing, signed G-SHADOW binding, negative-result lookup, ancestry, method counts, calibration and exact research evidence export. Renderer shadow/monitor controls are integrated. UNKNOWN, INCONCLUSIVE, SUSPENDED, RETIRED and alarm/kill distinctions are exercised with synthetic evidence. No order or brokerage interface was added; no capital deployment is authorized.

Prerequisites: C1–C5 records and artifact provenance; no brokerage execution integration.

Files: new shared/shadow.ts, core/monitoring.ts; main/artifacts.ts import/export; renderer shadow/monitor panels; tests/shadow.test.ts, monitoring.test.ts and release-manifest.test.ts.

Implementation:

1. Implement prospective prediction/time/quote/simulated-fill import schemas, schema/coverage checks and outcome metrics defined by frozen S0. Separate actual execution imports with independent provenance.
2. Evaluate G-SHADOW/retirement policies using versioned receipts. Missing feed/minimum samples produce UNKNOWN/INCONCLUSIVE or specified suspension, not convenient zero loss.
3. Export reproducible research packages containing exact code/environment/data refs, approved scope, gate/review hashes, costs/portfolio, limitations and approval meaning. Never label a planning archive or user-imported output as an approved trading deployment.
4. Complete ledger negative-result search/reuse, retirement/re-entry ancestry, method/version comparison and director prediction calibration reports with sample uncertainty.

Exit tests: future-dated prediction, missing quotes, simulated fill cannot verify real impact, drift alarm versus kill distinction, missing data suspension, threshold change invalidation, no order API/network launch, exact exported subject scope and restore/replay. Passing tests authorize software behavior, not capital deployment.

### C7 — Finish UI, performance, evidence reporting and release

Status: VERIFIED_LOCAL for integrated UI, draft revision conflicts, archived read-only controls, scoped cursor consumers, compact state delivery, derived SQLite research/message indexes, bounded evidence inventory handling, stable seats/meeting rooms with movement, export/backup/recovery and current-source release acceptance. Section 8.4 local known-answer retrieval measurement is complete; provider token counters and same-model stochastic comparison remain explicitly unknown/BLOCKED_EXTERNAL. The 2026-09-12 package passed all packaged desktop suites and actual packaged ConPTY I/O. No optimizer or hosted-readiness claim is made.

Prerequisites: retain R7 scope; integrate C1–C6 as available without implying blocked live features exist.

Files: renderer/main.tsx, office.tsx/css, profile.tsx, history.tsx, new research/evidence/review panels; store read indexes/query endpoints; main/artifacts.ts and recovery.ts; desktop/revision tests plus new pipeline.desktop.ts.

Implementation:

1. Implement section 9 UX and canonical multi-job action projections. Finish unified profile/effort editing, draft conflicts, archived read-only behavior, all-project filter counts and correct activity freshness/transitions.
2. Replace full-state history/log loads with cursor queries in every relevant view. Keep necessary small summaries in state; no full ledger/jobEvents/messages per push. Bound index rebuild/update work and run compression/hashing without blocking main event processing.
3. Extend small/streamed backup and project export to all owned input/output/report objects, without credentials/holdout secrets/unrelated projects. Test interrupted writes/recovery and large inventories, not merely artificially low thresholds.
4. Desktop regressions exercise binding, locations/collisions, disabled unsafe probe, handoff uncertainty, restore/controller replacement, stage gates, blinded views, query expansion, holdout denial and quarantine. No provider calls in these desktop fixtures.
5. Measure token/latency/quality experiment from section 8.4. Consider one optional optimizer/navigation trial only after evidence supports it; record choice and removal criterion in this file.
6. Run source checks then build/dev desktop/package/packaged desktop and actual packaged native terminal fixture. A missing/unsupported live route remains visibly blocked even when packaging succeeds.

Exit: full fixture baseline green, migrations/restore preserve history/objects and exposure policy, bounded performance results recorded, no known critical omissions or scope leaks in acceptance fixtures, correct hosted-readiness labels, documented live capabilities/gaps. Update version only as part of a validated release, not a roadmap edit.

## 11. Execution checklist and progress record

Status vocabulary: NOT_STARTED, IMPLEMENTED_FOUNDATION, IN_PROGRESS, PARTIALLY_VERIFIED_LOCAL, BLOCKED_EXTERNAL, VERIFIED_LOCAL, VERIFIED_HOSTED. PARTIALLY_VERIFIED_LOCAL means some tested code exists but parent acceptance is not met; list exact open subitems. PARTIALLY_IMPLEMENTED means the larger program still has unimplemented contracts/UI/tests. The latter requires actual provider evidence for the exact scope. A local test cannot advance a hosted gate. Keep this table in the same file.

| Item | Current status | Evidence / next action |
| --- | --- | --- |
| R0 | VERIFIED_LOCAL | Repaired 2026-09-08. Confinement now reads scoped DELEGATION_CONTROL evidence instead of the request's delegation flag; controller clock injected into readiness and into five test fixtures. 175/175 unit tests passed at that round; the current full-suite baseline is 382/382 (section 12.1). |
| R1-A | VERIFIED_LOCAL | Done 2026-09-08. Main handler refuses office:verify-transport before tool-path lookup, account observation, adapter construction or directory creation; the Settings live-create flow and its state are removed; bridge regression proves repeated direct calls reject with no connection, capability or event change. |
| R1-B | VERIFIED_LOCAL, action still contained | Done 2026-09-08. Real one-commit fixture through the ordinary R2 route, durable intent written before any provider contact, receipts persisted immediately, unresolved attempts refusing duplicates across restart with staging retained for reconciliation, framed receipt contract re-derived from section 13, honest model scope and classified failure metadata. R1 step 6 remains external. The Verify action stays contained pending R5. |
| D0 developer map | VERIFIED_LOCAL documentation | Section 1.3 map/fingerprints and selective-read protocol added after inspecting R0 source/log. |
| D2 parallel coding setup | VERIFIED_LOCAL tooling; desktop/provider sessions NOT_STARTED | 2026-09-13: the fixed local desktop state machine and detailed Session 1–7/Session 8 manual supplement the general worktree protocol. Four coordination tests pass, including seven simultaneous starts, atomic publication, role/path binding, immutable round hashes, stale review/head refusal, exact-SHA submission, scope enforcement, rejection, integration, close and next-round preservation. The eight prepared local worktrees under `quant-team-sessions/prepared-20260912` were fast-forwarded to setup commit `236ccda4817fcf5320e4ee95389af34bcb92dd46`; setup was run twice, all role/status checks returned the correct clean checkout and `NOT_READY`, and no product round was published. Installing ignored role files does not launch or authenticate a session. The prior fresh locked install, typecheck, 382/382 application units and build passed in the setup worktree. GitHub main protection requires a strict `verify` check, PR, resolved conversations and admin enforcement, with no force-push/deletion. CI results are on [setup PR #1](https://github.com/louiskim132/Quant_Office/pull/1). Claude Code 2.1.270 reported a signed-in subscription; Codex saved-project path remains the parent folder; Devin browser was signed out and its repository grant/model choice remain unverified. No SWE-2 or other worker sessions were launched. |
| D1 optional Serena trial | PARTIALLY_IMPLEMENTED, nonblocking | Project-local AGENTS.md and CLAUDE.md pointers plus the Git/worktree policy were added during repository setup on 2026-09-12. The optional Serena comparison and client configuration remain NOT_STARTED; no navigation plugin was installed. |
| OmniRoute routing extension | NOT_STARTED implementation; architecture reviewed 2026-09-11 | Section 3.1 proposes operation-specific model/session/research contracts and an optional bounded free-worker route. Current subscription-only runtime policy remains unchanged; no gateway installation, provider transfer or live compatibility test occurred. Integrate with C2/C4/C7 and retain R5/custody requirements. |
| R2 | VERIFIED_LOCAL within documented limits | Snapshot/output inventory is shared by backup and restore; both formats restore actual bytes into a new root. OutputService reserves real destinations on prepare/launch and stores versioned verified bytes. Required missing objects refuse backup. Snapshot identity rejects null/wrong request revisions. Remaining constraints: source swap races, recorded-platform Git reconstruction and R5 transport limits. |
| R3 | VERIFIED_LOCAL | Preserve exact per-operation scope, durable evidence order, independent confinement and frozen account context. No new live capability evidence in this pass. |
| R4 | VERIFIED_LOCAL | Local lifecycle/output repairs and all-handler restore admission verified by V1 on 2026-09-08; see section 5.2. The earlier approval-review interruption is historical. No live-provider or packaged-release claim. |
| R5 | BLOCKED_EXTERNAL / capability incomplete | 2026-09-12 CLI reconciliation: session_01Aj1hpgmeoZLdgYVR9eQ6PB is live and accepted a non-interactive follow-up (provider "Sent to cloud session" receipt), but interactive attach is refused account-wide ("not enabled for your account") and no CLI read route returns session output. Outcome reconciled at USER_REPORTED level: web transcript shows the fixture ran to completion (proof.json = {"fixture":"qro-cloud","status":"ok"} in /home/user/repo), env "Default" hibernates/resumes, Sonnet 5/Medium selectors visible, and web stop produced "stopping..." -> "stopped". Missing for R5: programmatic observe/retrieve/cancel routes - CLI can create and send but not read output or cancel; interactive attach is account-gated. Details: app/test-output/claude-cloud-spike-SP2mlL/reconcile-2026-09-12.json. Section 5.3 still governs remaining steps. |
| C1 | VERIFIED_LOCAL | Completed 2026-09-08. Research schemas, narrow commands, S0–S10 reducer, lineage counters and forecast/exposure bookkeeping in shared/research.ts and core/store.ts; nine exit tests in tests/research.test.ts. |
| C2 | VERIFIED_LOCAL; provider token comparison BLOCKED_EXTERNAL | Evidence retrieval, grants, cache invalidation and exact-source expansion remain verified. Section 8.4 measured local retrieval on 137 objects recovered all seven planted defects in both policies; actual byte/latency results are in section 12.1. Provider token/model counters remain unknown. |
| C3 | VERIFIED_LOCAL | Completed 2026-09-08. shared/research-contracts.ts, shared/research-diagnostics.ts, core/research-gates.ts, main/research-templates.ts, the inspectResearchPackage importer in main/artifacts.ts, versioned templates and a hand-computed golden fixture under app/research-templates/, tests/research-gates.test.ts (19) and tests/research-import.test.ts (7). 287/287 unit tests, typecheck, build, desktop and revision-desktop suites pass. No dataset performance claim. |
| C4 | VERIFIED_LOCAL; hosted verification BLOCKED_EXTERNAL | Completed signed independent-runtime admission and S2/S7 delivery/review/rebuttal/adjudication machinery. End-to-end synthetic workflow reaches S10 through real application services; no provider-authored gate approval or live isolation claim. See section 12.1. |
| C5 | VERIFIED_LOCAL; real custody BLOCKED_EXTERNAL | Application registration/reserve/evaluate/export/import paths, exact S8 result admission, nonrollback journal/checkpoints and durable result recovery verified with synthetic custody. Real evaluator/access isolation and R5 are not established. |
| C6 | VERIFIED_LOCAL | Durable shadow/quote/simulated-fill ingestion, separate actual execution provenance, lifecycle/coverage, G-SHADOW binding, renderer panels, negative-result reuse and research export integrated. Software evidence only; no trading permission. |
| R6 / C1–C6 | VERIFIED_LOCAL; VERIFIED_HOSTED blocked | Local staged research contracts and integrated independent-runtime fixtures complete. Actual external provider isolation, signed authority provisioning and real custody remain required before live acceptance. |
| C7 | VERIFIED_LOCAL; provider experiment BLOCKED_EXTERNAL | Current-source UI, paging, scale/retrieval measurement, migration/backup/recovery and fresh packaged/native acceptance complete. The final full suite passed 382/382 on the packaged revision's source, after a consolidated 370/382 run and targeted repairs. No measured provider token or model-quality claim. |
| R7 / C7 | VERIFIED_LOCAL | Canonical activity/readiness, scoped paged views, stable room/seat placement, integrated research/monitoring UI and current-source packaged/native acceptance verified. |
| Roadmap consolidation | VERIFIED_LOCAL documentation | Comment/report evaluated; one active roadmap; old entry points redirected. Local links/anchors, fences and complete R0–R7/C1–C7/S0–S10 inventory checked. No source implementation or new application test run in this consolidation. |

Current-source qualification, 2026-09-12: version 0.5.0. The application qualification occurred before Git initialization; the same qualified source was then committed and connected to the private GitHub repository on `main`. The complete local C4–C7 revision was reviewed, verified and freshly packaged. Section 12.1 and its dated raw logs supersede earlier slice-level counts and pre-audit package claims. Live provider/custodian requirements remain external and do not become verified through packaging.

For each completed slice append below using this format; do not write a separate continuation document:

~~~text
Date / item / status:
Problem and resulting behavior:
Changed source/test files:
Migration and compatibility impact:
Commands actually run, exit codes and dated log paths:
Local fixture evidence versus live provider evidence:
Known unresolved external IDs/operations:
Remaining defects and exact next item:
~~~

~~~text
Date / item / status: 2026-09-13 / D2 fixed desktop coordination / VERIFIED_LOCAL tooling; sessions NOT_STARTED
Problem and resulting behavior: Independent desktop chats could not communicate, and the original helper generated isolated
  checkouts and one-off prompts but had no atomic current-round mailbox, fixed role binding, immutable submission record or
  organizer integration state. tools/desktop.mjs now binds eight prepared worktrees to Sessions 1–8, publishes exactly seven
  disjoint CODE/IDLE slots from one frozen organizer HEAD, serializes concurrent starts, refuses stale/tampered/out-of-scope
  results and reviews, preserves blocked/rejected commits, and allows only Session 8 to merge and close. The detailed operating
  manual makes the human interaction request -> WORK READY -> start in Sessions 1–7 -> review in Session 8 explicit.
Changed source/test files: tools/desktop.mjs and tools/desktop.test.mjs added; tools/parallel.mjs protected-path/export support;
  .github/workflows/verify.yml runs both coordination suites; AGENTS.md, CLAUDE.md, README.md, .gitignore, this roadmap and
  docs/DESKTOP-SESSIONS.md document the roles and commands. Ignored .session.json/SESSION.md and shared batch records are local
  execution metadata, not product source or a second roadmap.
Migration and compatibility impact: no application schema, IPC, dependency, package, product data or runtime behavior changed.
  The general tools/parallel.mjs hosted/PR workflow remains available. Existing branches and worktrees are preserved.
Commands actually run, exit codes and dated log paths: node --test tools/parallel.test.mjs tools/desktop.test.mjs — exit 0,
  4 tests passed, 0 failed in the implementation worktree. The committed setup revision was fast-forwarded without resets into
  all eight prepared worktrees; setup ran twice; role/status checks in every checkout returned clean, correct Session 1–8
  identities and NOT_READY. No application suite was rerun because product source and dependencies did not change.
Local fixture evidence versus live provider evidence: disposable local Git repositories only. The regression launched seven
  local start processes concurrently and exercised publish/start/finish/block/review/accept/reject/close. It did not launch,
  authenticate or select any Devin, Codex or Claude model and did not verify hosted shared-filesystem access.
Known unresolved external IDs/operations: Devin repository grant, SWE-2 availability and desktop concurrency are unverified;
  Codex's saved Agent Team project still names the parent folder rather than these exact eight local checkouts.
Remaining defects and exact next item: the user must open each exact folder listed in the generated START-HERE.md in a
  local-filesystem-capable desktop session and paste the one-time bootstrap. The first product round remains NOT_READY until
  Session 8 receives, decomposes and successfully publishes a concrete feature request. Provider sign-in/grant/model checks
  remain external to this local tooling.
~~~

~~~text
Date / item / status: 2026-09-08 / R0 Restore the current regression baseline / VERIFIED_LOCAL
Problem and resulting behavior: AssignmentController.dispatch passed `constrainedTools: assignment.delegation === false`
to assertHostedExecution, conflating the request's collaboration policy with verified tool confinement. Every GROUP
fixture therefore failed the hosted-execution guard: 3 failures in tests/activity-queue.test.ts and 6 in
tests/cooperation.test.ts, all with "Only constrained provider-hosted execution is allowed; no local or Colab access".
Separately, readiness consulted Date.now() while fixtures used fixed 2026-09-08 timestamps, so the suite's result
depended on the calendar date and time of day it ran; controller.test.ts and handoff.test.ts failed on account
staleness during this session for exactly that reason.
Changed source/test files:
  src/main/controller.ts — added a private nowMs() derived from the injected clock; passed { now } to all three
    agentDispatchReadiness calls; derived constrainedTools from scoped DELEGATION_CONTROL evidence via
    effectiveEvidence(connection, model, environment) rather than from the delegation flag; added an explicit
    refusal for a delegating assignment on a SINGLE-mode request; replaced the no-op
    `route === 'FAKE_ADAPTER' ? false : false` with a plain `localExecution: false` and a comment stating why.
  tests/cooperation.test.ts — injected a fixed monotonic clock into the fixture's controllers; parameterized the
    observed environment; added two regressions (authorized group work dispatches to ACCEPTED with delegation
    recorded as true; a non-provider-hosted environment is refused even for a SINGLE request with delegation off).
  tests/activity-queue.test.ts, tests/controller.test.ts, tests/handoff.test.ts, tests/pty.test.ts — injected the
    same fixed monotonic clock so freshness checks no longer depend on the wall calendar.
Migration and compatibility impact: none. No schema, stored record or IPC surface changed. Provider hosting,
  no-local-execution and no-Colab guards remain intact; the guard is now stricter about hosting evidence and no
  longer weaker for single-agent work. No fixture was switched to SINGLE and no gate was weakened to obtain green.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit — exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts — exit 0; 175 tests, 175 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r0-unit-2026-09-08.log
Local fixture evidence versus live provider evidence: local fake-adapter fixtures only. No provider session was
  created, observed or cancelled. Nothing here advances any hosted gate.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN (see implementation-log.md).
Remaining defects and exact next item: the delegating-assignment-on-a-SINGLE-request refusal is a defensive
  invariant and is currently unreachable through the public API, because request mode is immutable after creation
  and delegation is derived from it; it is deliberately left in place and untested rather than removed. Next item
  is R1 containment in section 5.
~~~

~~~text
Date / item / status: 2026-09-08 / R1-A containment / VERIFIED_LOCAL. R1-B unchanged and still open.
Problem and resulting behavior: Settings offered "Verify cloud transport..." -> confirmation -> "Create one real
  session now" -> window.office.verifyCloudTransport -> office:verify-transport, which looked up the tool path,
  observed the account, constructed a PtyCloudAdapter and called probeCloudTransport. That probe submits with no
  durable intent, passes a fabricated stagingCommit and manifestHash, removes its staging in `finally`, and is not
  guarded against repetition, so a created session could not be tracked. A confirmation dialog is not containment,
  and a renderer-side check would not stop a stale window or a direct bridge call.
Changed source/test files:
  app/src/shared/transport.ts - new. TRANSPORT_PROBE_CONTAINMENT carries the flag, the main rejection text and the
    Settings status text, so main and renderer cannot drift. assertTransportProbeAllowed() is the gate.
  app/src/main/main.ts - office:verify-transport validates the existing input shape, then calls
    assertTransportProbeAllowed() before transportModuleStatus(), subscriptions.observe(), adapter construction and
    any staging directory. The OfficeAPI/preload method and its signature are unchanged for compatibility.
  app/src/renderer/agents.tsx - the confirmation flow, the `verifying` and `probe` state and the verify() handler are
    removed; the control remains visible but disabled, with the containment status shown beside it. Check account,
    provider usage links, readiness lists, capability evidence and blockers are untouched.
  app/src/main/probe.ts - docstring only: records that no production route reaches it while contained, and names the
    four defects R1-B must fix. No behavior change.
  app/tests/probe.test.ts - one added regression on the containment guard. The existing probe fixtures are unchanged
    and still exercise the untouched implementation for R1-B.
  app/tests/desktop.e2e.ts - added bridge regression through the real main process: the Settings control is disabled,
    no "Create one real session now" step exists, the status text is visible, Check account stays enabled, and two
    consecutive direct verifyCloudTransport calls both reject with the stable message while connections, capabilities
    and event count are byte-identical before and after.
Migration and compatibility impact: none. No schema, stored record, preload surface or OfficeAPI signature changed,
  so the desktop.e2e.ts bridge key list still holds. No capability snapshot was rewritten, no UNAVAILABLE evidence
  was fabricated, and no user was asked to sign in again. The historical session record is untouched.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 176 tests, 176 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r1a-unit-2026-09-08.log
  node scripts/build.mjs - exit 0. Log: app/test-output/r1a-build-2026-09-08.log
  node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts - exit 0, development mode.
    Log: app/test-output/r1a-desktop-2026-09-08.log; report app/test-output/desktop-report.json
  Packaged desktop checks were not run: no package change was in scope this round.
Local fixture evidence versus live provider evidence: local only. No probe was started, no terminal was spawned, no
  account was observed by this action and no provider session was created. Containment is proved by the bridge
  regression showing zero state change, not by any provider evidence.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN; the CLI attach to it is
  still blocked by the recorded approval rejection (see implementation-log.md). R1 step 6 is untouched by this slice.
Deviation recorded rather than hidden: this round first implemented R1 steps 4 and 5 as well - a framed receipt
  contract in pty.ts and allowlisted failure metadata plus honest model scope in probe.ts - before re-reading the
  rewritten packet, which scopes R1-A to containment only and says to keep probe/PTY internals for R1-B. Those edits
  were reverted; app/src/main/pty.ts hashes back to its recorded map prefix b4bcab7a8118, confirming the original
  bytes are restored. The design that was drafted is not carried forward here; R1-B should derive it again from the
  section 13 transcript rather than trusting this note.
Remaining defects and exact next item: R1-B is unchanged - real one-commit Git fixture, durable intent and duplicate
  refusal across restart, staging retained for reconciliation, framed receipt contract, honest model scope and
  allowlisted failure metadata. Keep the action contained until all of it lands. Next code item is R2 in section 5.
~~~

~~~text
Date / item / status: 2026-09-08 / R2 items 1, 2, 3, 5 and 7 / VERIFIED_LOCAL. Items 4 and 6 remain open.
Problem and resulting behavior:
  Item 1 - preparation wrote a generated README.md and office-manifest.json into the staging root, so a
    selected file with either name was silently overwritten by bookkeeping and the user's bytes never
    travelled. Generated content was not inventoried, so tampering with it was undetectable.
  Item 2 - verifyStagedSnapshot checked only the selected files' hashes, and had no caller on the
    dispatch or handoff path. An added file, a removed file, a rewritten manifest, a changed HEAD or an
    extra commit would all have been transferred without complaint.
  Item 3 - git() inherited the caller's environment except for three variables, so GIT_DIR,
    GIT_WORK_TREE, GIT_INDEX_FILE or GIT_ALTERNATE_OBJECT_DIRECTORIES could redirect staging, and global
    or template configuration could introduce hooks and filters that run code while staging. Only the
    leaf of a selected path was checked for links, so a junction on an intermediate directory redirected
    the whole subtree.
  Item 5 - requestId and requestRevision were copied into the snapshot record without being checked
    against the store at all, so a snapshot could be frozen against a stale revision, a request in
    another project, or a request that does not exist.
  Item 7 - a snapshot with no staging commit was recorded with a warning but was otherwise an ordinary
    snapshot; nothing on the transfer path refused it.
Changed source/test files:
  app/src/main/locations.ts - RESERVED_DIRECTORY `_office` holds the generated README and manifest;
    resolveSelection refuses any selection naming it before a byte is copied. Generated files are hashed
    into a `generated` inventory carried in the snapshot record and the manifest. assertNoLinkedComponent
    walks every path component with lstat; the root itself is rejected if reached through a link; the
    source is re-examined after the copy so a swap between validation and copy cannot be followed.
    gitEnvironment drops every inherited GIT_* variable rather than overriding a chosen few, and points
    system, global, attribute and template configuration at nothing; GIT_SAFETY forces empty hooksPath
    and templateDir on every invocation, and commits use --no-verify. verifyStagedSnapshot now walks the
    whole tree, reports missing, changed, extra and link entries, and re-hashes the manifest against the
    value frozen in the workspace database, which the staged directory cannot reach. New
    verifySnapshotForTransfer adds HEAD equality, a clean working tree and the single-commit history, and
    refuses a commitless snapshot as a local preview.
  app/src/shared/types.ts, app/src/core/store.ts - InputSnapshot gains an optional `generated` inventory.
    Optional, so snapshots recorded before this change still load and replay unchanged.
  app/src/main/controller.ts - dispatch runs verifySnapshotForTransfer before the intent transition, so a
    refusal leaves the job untouched rather than stranded in SUBMITTING. handoff runs the same check
    inside its launcher try block, so a refusal keeps the existing contract: nothing is opened and the
    job becomes Unknown. The verifier is injectable for tests but defaults to the real one.
  app/tests/locations.test.ts - six new regressions: a selected README.md and office-manifest.json
    survive byte for byte; selecting the reserved directory is refused with no snapshot recorded;
    changed, extra, missing and tampered-generated files are each detected; a consistently rewritten
    manifest is still caught by the frozen record; a real second commit is detected by the transfer
    check; a commitless snapshot is refused; and request/revision/project freezing is checked on the
    text-only route.
  app/tests/pty.test.ts - FakePty gained script(), which runs when the adapter attaches. Five tests
    previously started a 10 ms timer at dispatch time; the frozen-input check now runs real git before
    the terminal is spawned, so those timers raced work that legitimately precedes the spawn. This is a
    fixture-timing repair, not a relaxation: every assertion is unchanged.
Migration and compatibility impact: `generated` is optional and absent on older snapshots, which keep
  loading, replaying and verifying against their selected files. The staged layout changed, so a
  directory prepared before this build has its bookkeeping in the old place; verification of such a
  directory reports the old paths as unexpected extras, which is correct - it must be prepared again
  rather than transferred under a contract it was not built for. No schema version bump was needed.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 183 tests, 183 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r2-unit-2026-09-08.log
  Build and desktop suites were not rerun for this slice: no renderer, IPC or packaging surface changed.
Local fixture evidence versus live provider evidence: local only. Git fixtures run the real installed git
  (2.46.2.windows.1); tamper cases make genuine extra commits rather than mocking the result. No provider
  session was created and no probe was started; R1-A containment is untouched.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN. Unchanged here.
Remaining defects and exact next item:
  R2 item 4 - copied bytes are still only in the disposable staging directory. They are not stored as
    content-addressed objects, not included in either backup format, and cannot be reconstructed after a
    restore; legacy snapshots are not yet marked unreconstructable.
  R2 item 6 - writable destination checks, managed versioned output allocation by
    project/request/assignment/attempt, and collision policy are not implemented.
  R2 item 7 is only half done: the 64 MiB app limit and the preview/transferable split are enforced, but
    the actual transport bundle limit is not verified, because no transport is available to measure it.
  Next item is R2 items 4 and 6, then R3.
~~~

~~~text
Date / item / status: 2026-09-08 / R2 items 4 and 6 / VERIFIED_LOCAL. R2 is now complete except the
  transport-dependent half of item 7, which is blocked by R5.
Problem and resulting behavior:
  Item 4 - copied bytes existed only inside a disposable staging directory. Backups carried the snapshot
    records but not the bytes they describe, so a restored workspace held snapshots it could not produce,
    and there was no way to rebuild staging except by re-reading a source folder that may have changed.
  Item 6 - nothing checked that a chosen output folder could actually be written to, and there was no
    allocation scheme, so two attempts at the same work had no defined place to land.
Changed source/test files:
  app/src/main/locations.ts - snapshotObjectPath/storeObject write every staged byte, selected and
    generated, into the workspace's existing content-addressed object store. The manifest is now
    inventoried in the snapshot record (not inside itself, which would be circular) so it can be rebuilt
    too. Both Git commit dates are pinned to the manifest's createdAt, which makes the commit a pure
    function of the tree; that is what lets reconstructSnapshot check the rebuilt commit against the
    identifier frozen at preparation instead of merely producing a similar directory. reconstructSnapshot
    refuses a snapshot with no `generated` inventory, and one whose objects have gone, rather than
    falling back to the source folder. assertWritableDestination establishes writability by writing and
    removing a probe file, because a permission bit is not a promise. allocateOutputDestination addresses
    results by project, request, assignment and attempt, and its collision policy allocates the next
    attempt rather than overwriting or merging: an occupied directory is another attempt's evidence.
  app/src/main/artifacts.ts - backedUpObjects() is the single list of objects a backup must carry,
    imported artifacts plus frozen request inputs, used by both the in-memory and streamed formats and by
    the size thresholds that choose between them. Content addressing means the two sources share storage
    when their bytes coincide.
  app/src/main/main.ts - the prepare handler passes the workspace directory as objectRoot, so bytes
    prepared in the real app are durable rather than only staged.
  app/tests/locations.test.ts - four new regressions: durable objects exist for every inventoried file;
    backup-shaped loss (staging directory AND source folder both deleted) still reconstructs byte-exactly
    and to the same commit, and the rebuilt directory passes the same transfer check; a legacy snapshot
    and a snapshot with lost objects are both refused while the source folder sits untouched beside them;
    destination writability and attempt allocation including the occupied-directory case.
Migration and compatibility impact: no schema version bump. Snapshots recorded before this change have no
  `generated` inventory and no stored objects; they load, replay and verify as before, and are reported
  unreconstructable if a rebuild is attempted. Backups written before this change restore unchanged.
  Backups written now are larger, because they carry frozen input bytes that were previously absent.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 187 tests, 187 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r2-unit-2026-09-08.log
  Build and desktop suites were not rerun: no renderer or IPC surface changed, only a main-process
  argument and internal services.
Local fixture evidence versus live provider evidence: local only, against the real installed git
  2.46.2.windows.1. No provider session was created; R1-A containment is untouched.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN.
Remaining defects and exact next item:
  R2 item 7's second half is unfinished and cannot be finished here: the actual transport bundle limit is
  unverifiable while no transport is available. The 64 MiB selected-byte limit and the rule that a
  commitless snapshot is a local preview are both enforced and tested.
  allocateOutputDestination is implemented and tested but is not yet called from a transfer path, because
  no output transfer path exists until R4 lifecycle work; it is a unit, not yet a wired feature.
  Next item is R3 in section 5.
~~~

~~~text
Date / item / status: 2026-09-08 / R3 / VERIFIED_LOCAL.
Problem and resulting behavior:
  Item 1 - evidence was selected by connection and tool version only. Absent model or environment
    fields matched any requested scope, dispatch callers passed no environment at all, and effort and
    delegation had no representation in evidence whatsoever, so an observation taken at the default
    effort silently authorized a non-default one. The adapter route was never compared to the recorded
    transport.
  Item 3 - freshness was a five-minute cached window. Nothing rechecked the account at the moment of
    launch, so a sign-out or an account switch after the interface last looked went unnoticed.
  Item 4 - the single native controller is a Claude terminal adapter, and nothing stopped an OpenAI
    profile being dispatched through it.
  Item 5 - bindAgentConnection overwrote agent.account on CHANGE, destroying the identity the profile
    was created for, while the interface still described that field as the setup identity.
Changed source/test files:
  app/src/shared/types.ts, app/src/core/store.ts - CapabilityEvidence gains optional `effort` and
    `delegation`, so evidence can state the exact controls it was observed under. Agent gains optional
    `setupAccount`. Both optional, so existing records load and replay unchanged.
  app/src/shared/readiness.ts - new RequestedScope and scopeMismatches(). Model matching is now strict:
    evidence that does not name the model cannot answer a model-scoped question. Environment falls back
    to the snapshot's own environment, which is a fact about where the observation happened rather than
    an assumption. Effort and delegation have no fallback and must be declared. PROVIDER_WIDE keeps
    ACCOUNT_STATUS, MODEL_CATALOG and ALLOWANCE_READ provider-wide, because signing in is not done per
    model; catalog metadata informs display and the signed-in state and nothing else. ROUTE_TRANSPORT
    maps each adapter route to the transports that can carry it. Blockers now describe evidence that
    exists but does not match scope ("for these exact conditions") instead of reporting nothing found.
    agentBinding reports setupIdentity, setupIdentityKnown and rebound.
  app/src/main/controller.ts - ProviderAdapter may declare `providers`; dispatch refuses a pairing the
    route cannot serve, before any contact, leaving the job at INTENT. The R0 DELEGATION_CONTROL check
    is replaced by the full scope check, which subsumes it: confinement is established by that check
    rather than assumed. The R0 SINGLE-mode delegation invariant is retained unchanged.
  app/src/main/main.ts - recheckAccountBeforeExternalAction() observes the official account, commits the
    observation before acting (a check that could not be persisted has not happened), then confirms the
    active identity still matches the frozen one, that the tool still reports signed in, and that the
    profile revision did not move across that async boundary.
  app/tests - cooperation: an unsupported route is refused and the job stays at INTENT; effort, model,
    tool version, environment, identity, credential context and expiry each independently block the exact
    scope. binding: a rebinding moves the account, retains the original setup identity across two
    rebindings, records it in the event reason, and a pre-change profile reports its origin as unknown
    rather than assuming. readiness: a clock set before the observations and a far-future clock both fail
    to resurrect superseded transport verification. Five fixture files now declare effort and delegation
    scope on the two operations that have one.
Migration and compatibility impact: no schema version bump. Evidence and profiles recorded before this
  change load unchanged; evidence lacking effort or delegation simply cannot authorize those exact
  controls, which is the intended contract, and profiles lacking setupAccount report their origin as
  unknown rather than claiming the current account is where they started. The blocker wording for
  out-of-scope evidence changed, and one readiness assertion was updated to match.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 191 tests, 191 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r3-unit-2026-09-08.log
  node scripts/build.mjs - exit 0. Log: app/test-output/r3-build-2026-09-08.log
  node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts - exit 0, development mode.
    Log: app/test-output/r3-desktop-2026-09-08.log
  Packaged desktop checks were not run: no package change was in scope.
Local fixture evidence versus live provider evidence: local only. No provider session was created and no
  account was actually observed; recheckAccountBeforeExternalAction is exercised through the app's own
  subscription service, not against a live account. R1-A containment is untouched.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN.
Remaining defects and exact next item:
  The pre-launch recheck is wired into the handoff path only, because automatic start remains blocked
  until R5 and has no production IPC route yet; when that route is added it must call the same function.
  scopeMismatches is enforced in dispatch but is not yet reflected in the renderer's readiness display,
  which still shows per-operation blockers rather than per-scope ones.
  Automatic Start remains unavailable pending R5, as this item requires.
  Next item is R4 in section 5.
~~~

~~~text
Date / item / status: 2026-09-08 / R4 / VERIFIED_LOCAL for items 1, 2 (partly), 3, 4 and 6; item 5 partly.
Problem and resulting behavior:
  Item 1 - dispatch and handoff read request.objective and request.name at launch, while the input
    snapshot, account binding and capability evidence were all frozen earlier. An edit between
    preparation and launch therefore travelled as a current prompt attached to old inputs and an old
    binding, and only a hash of the original text existed, which can detect that but cannot restore it.
  Item 2 - status was checked when an assignment was created and never again, so a request canceled or a
    project archived afterwards could still be launched from a window opened before the change.
  Item 3 - restore replaced the store and artifact service but left the controller holding the closed
    pre-restore database, and nothing stopped a restore starting while a request action was in flight.
  Item 4 - observe() recorded every adapter result as PROVIDER_REPORTED, including the UNKNOWN stub the
    PTY adapter returns to say it cannot observe anything. That turned an adapter's own limitation into
    provider testimony and could overwrite a real receipt.
  Item 6 - the handoff preview and the launch each read the request separately, so they could disagree.
Changed source/test files:
  app/src/shared/types.ts, app/src/core/store.ts - new FrozenAssignmentPayload (request name, objective,
    acceptance criteria, agent instructions, model, effort, delegation) carried on Assignment. Optional,
    so assignments recorded by earlier builds still load and replay.
  app/src/main/controller.ts - prepare() captures the payload; frozenPayload() is the only way to read
    it and refuses an assignment that has none, directing the user to prepare again rather than
    silently re-reading the request. dispatch, handoff and handoffPlan all take objective and request
    name from it, so preview and launch cannot disagree. assertLifecycle() is called from prepare,
    dispatch and handoff and rejects an archived project, a canceled request and an archived profile.
    observe() records an adapter-generated UNKNOWN as OFFICE_LOCAL, and returns without recording at all
    when the job already holds an external identifier or a pending cancellation.
  app/src/main/main.ts - buildController() is the single wiring point; the restore path rebuilds the
    controller against the new store and refuses to start while dispatchBusy is set.
  app/tests/cooperation.test.ts - four regressions: an edited objective does not reach the adapter,
    which still receives the frozen text; an assignment with no frozen payload refuses to launch; a
    canceled request blocks both dispatch and a fresh prepare from a stale view; a blind adapter's
    UNKNOWN leaves an accepted job, its receipt and its PROVIDER_REPORTED evidence untouched.
Migration and compatibility impact: no schema version bump. `frozen` is optional; assignments without it
  load and are visible, and are refused only at launch, with an explicit instruction to prepare again.
  One narrowing was made deliberately during implementation and is worth recording: an initial version
  of assertLifecycle required every agent to be the lead or a listed participant. That is wrong for this
  domain - a review must be done by someone who is not the author, and four cooperation tests failed on
  it. The rule now applies only to SINGLE-mode requests, where the roster really is closed; group and
  team eligibility stays with the review and role-slot rules.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 195 tests, 195 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r4-unit-2026-09-08.log
  node scripts/build.mjs - exit 0. Log: app/test-output/r4-build-2026-09-08.log
  node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts - exit 0. Log: app/test-output/r4-desktop-2026-09-08.log
  Packaged desktop checks were not run: no package change was in scope.
Local fixture evidence versus live provider evidence: local only. No provider session was created.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN.
Remaining defects and exact next item:
  R4 item 2's multi-job aggregation is not implemented: the queue still reports the latest assignment
    rather than aggregating every applicable job for a request.
  R4 item 5's single allowed-actions projection is not wired through the renderer buttons and store
    guards; cancellation preservation and the local-versus-provider labelling are done.
  R4 item 3 is implemented but has no automated regression for "restore while an async action is
    pending", because the restore path needs the Electron main process and the desktop suite does not
    currently drive a concurrent dispatch. The guard is code-reviewed, not test-proven.
  R4 item 4's "fetch output bytes into managed storage and verify hashes" is not implemented; no adapter
    currently returns retrievable outputs.
  Next item in section 5 is R5, which is BLOCKED_EXTERNAL. The next implementable work is C1 in section 10.
~~~

~~~text
Date / item / status: 2026-09-08 / R4-A / VERIFIED_LOCAL.
Problem and resulting behavior:
  Item 1 - main's dispatch wrapper checked only dispatchBusy, and restore checked it once, then closed
    the store and awaited commitRestore. A request action could be admitted during that await and run
    against a database being replaced. A declined restore left its prepared candidate on disk. No epoch
    existed, so a result computed before a replacement could still be written back afterwards.
  Item 2 - controller.handoff had no provider/route check at all, so a profile bound to OpenAI could
    reach the default Claude terminal adapter; only automatic dispatch was protected. The fresh account
    check lived in a free function wired to one call site, which any future caller could bypass.
  Item 3 - handoff recorded SUBMITTING and then verified staging, so a purely local preflight failure
    produced an ambiguous remote UNKNOWN implying the provider might have seen something. Both paths
    awaited verification and then submitted without re-reading anything.
Changed source/test files:
  app/src/main/controller.ts - launchGuard() gathers every precondition for both paths: dependencies,
    the readiness gate appropriate to the action, lifecycle, frozen payload, the single-agent delegation
    invariant, provider/route support, and the frozen account context. It is re-run after the transfer
    verification await, with no further await before the adapter call. handoff now runs preflight
    before marking SUBMITTING and throws on failure, leaving the job at INTENT. refreshFrozenAccount()
    is a constructor-injected hook called inside dispatch and handoff, so the fresh observation cannot
    be skipped by a new caller.
  app/src/main/main.ts - storeEpoch, openRequestActions and workspaceLocked replace the two independent
    busy flags. A request action is refused while a restore is in progress, captures the epoch, and
    discards its result if the workspace was replaced meanwhile. Restore refuses while any request
    action is open, holds the lock across candidate preparation and commit, and discards the candidate
    on decline and on commit failure. The bypassable recheck helper is gone; main now passes the
    observation hook to buildController.
  app/src/shared/types.ts, app/src/core/store.ts - FrozenAssignmentPayload carries accountIdentity and
    credentialContext by value.
  app/tests/cooperation.test.ts - a deferred-promise verifier, released by hand, drives the race for
    both dispatch and handoff across three invalidations; a changed credential context at the same
    address; and a handoff refused for an unreachable provider. Adapter submissions are counted, so
    "nothing was launched" is measured rather than assumed.
  app/tests/handoff.test.ts, app/tests/desktop.e2e.ts, app/tests/activity-queue.test.ts - updated as
    described below.
Two source gaps the regressions exposed, and how they were closed:
  1. Freezing only connectionId could not detect an account-context change. A later observation updates
     the same connection row in place, so the assignment's reference and the live record moved together
     and compared equal. The frozen payload now carries accountIdentity and credentialContext by value,
     and the guard compares against those. Without this the "same identity, different context" case the
     packet requires would have passed silently.
  2. Archiving a profile bumps its revision, so the frozen-revision guard fires before the archive
     message. Both refusals are correct; the test accepts either and asserts zero submissions.
One required scenario is not reachable and was not forced: archiving a project while a request is
  outstanding is already refused by the store, so that race cannot be constructed from the public API.
  Profile rebinding, which the packet names alongside archival, is used instead and is exercised.
A latent test defect was found and fixed while running this slice: two activity assertions passed
  now:Date.now() while every event carried the injected fixture clock. They only passed while the suite
  ran within five minutes of the fixture's 15:00 base time; by this round the real clock had reached
  15:25 and they failed. This was pre-existing, not caused by R4-A, and is the same wall-clock
  dependence R0 removed elsewhere. Both now measure against the fixture clock.
Migration and compatibility impact: no schema version bump. accountIdentity and credentialContext are
  required inside `frozen`, which is itself optional and only written by current code; assignments
  without a frozen payload were already refused at launch and still are. Two contracts changed
  deliberately: a handoff preflight failure now throws and leaves the job at INTENT instead of
  recording UNKNOWN, and an edited request now blocks launch on the revision guard rather than
  silently launching with the frozen text. Both tests were updated to the new contract.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 198 tests, 198 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r4a-unit-2026-09-08.log. The 195-test log is preserved.
  node scripts/build.mjs - exit 0. Log: app/test-output/r4a-build-2026-09-08.log
  node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts - exit 0. Log: app/test-output/r4a-desktop-2026-09-08.log
  Packaged checks were not run: packaging was not included in this slice.
Local fixture evidence versus live provider evidence: local only. No provider session was created and no
  probe was started; R1-A containment and R0 clock injection are both intact.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN.
Remaining defects and exact next item:
  The desktop regression covers concurrent request admission and main-process liveness afterwards. It
  does not drive a real restore against a paused request action, because the restore path opens native
  file and confirmation dialogs the suite cannot script; that admission logic is unit-reasoned and
  code-reviewed, not end-to-end proven. Recorded as such rather than claimed.
  R4-B remains: multi-job aggregation, the allowed-actions projection, and output byte retrieval.
  Next item is R3-A in section 5.1.
~~~

~~~text
Date / item / status: 2026-09-08 / R3-A / VERIFIED_LOCAL, all five items.
Problem and resulting behavior:
  Item 1 - effectiveEvidence filtered on connection, tool, model, environment, effort and delegation,
    but not on the route an observation was taken through, and scopeMismatches read the transport from
    the newest snapshot rather than from each operation's own evidence. A terminal handoff and an
    automated PTY session both record OFFICIAL_CLI_TERMINAL, so exercising one appeared to verify the
    other.
  Item 2 - the newest snapshot supplied the execution-scope identity. A metadata-only refresh records
    transport NONE and an empty environment, so a bare sign-in check could redefine the environment work
    was judged against, and assignments bound only to latestCapability.id.
  Item 3 - supersession was resolved by verifiedAt. A result stamped in the future outranked the later
    invalidation that superseded it, and never expired, because its age was negative.
  Item 4 - toolsConfined was "every scope operation matched", with delegation control standing in for
    tool confinement. Delegation control describes delegation; it says nothing about whether tools, the
    filesystem, the network or the environment were actually restricted.
  Item 5 - the renderer called agentDispatchReadiness with no route, effort or delegation, so the
    interface could show an action as allowed that the main process would refuse.
Changed source/test files:
  app/src/shared/types.ts, app/src/core/store.ts - CapabilityEvidence gains `route` and a structured
    `confinement` policy (tools, filesystem, network, environment); a new TOOL_CONFINEMENT operation;
    EffectiveEvidence additionally carries its snapshot's transport and an `impossible` flag. Assignment
    gains optional capabilitySnapshotIds. All additive and optional, so existing records replay.
  app/src/shared/readiness.ts - candidates are ordered by the position they were durably recorded in,
    not by the timestamp they carry, so a future-dated result cannot outrank a later invalidation.
    `impossible` marks evidence dated after the moment it is judged at, and verified() refuses it.
    Route provenance filters candidates. scopeMismatches now reads transport from each operation's own
    evidence, checks TOOL_CONFINEMENT's content rather than its presence, and no longer trusts the
    newest snapshot for scope identity. New supplyingSnapshotIds() names the exact evidence set.
    providerReadiness asks each operation only about the scope it actually has.
  app/src/main/controller.ts - prepare records the supplying snapshot set; dispatch refuses if that set
    changed since freezing. Confinement is read as its own fact from its own observation rather than
    inferred from the other checks passing.
  app/src/renderer/dispatch.tsx, app/src/renderer/profile.tsx - readiness is asked with the route the
    office would really use and the request's delegation policy.
  app/tests/readiness.test.ts - five acceptance regressions: one route's evidence does not verify
    another sharing its transport; a metadata refresh neither erases nor renews real transport evidence
    nor redefines the environment; a future-dated observation cannot defeat a later invalidation; hollow
    and absent confinement records both stay blocked; the supplying snapshot set is identifiable and
    unaffected by an unrelated later observation. Six fixture files now declare route and confinement.
One deliberate simplification: an initial version also compared each operation's environment inside
  scopeMismatches. That branch is unreachable, because effectiveEvidence already filters candidates by
  environment, so a mismatch yields no evidence rather than mismatched evidence. It was removed rather
  than left as dead code that looks like a check, and the test asserts the reachable wording instead.
Two fixture observations were dated minutes ahead of the injected clock and began failing once
  impossible timestamps were refused. That is the new rule working, not a regression: they now use the
  clock's own starting instant.
Migration and compatibility impact: no schema version bump. Evidence without `route` still answers for
  any route, so existing records are not invalidated; evidence without a confinement policy cannot
  certify confinement, which is the intended contract and keeps automatic start blocked until real
  evidence exists. Production records are unchanged; the fixture confinement values are test-internal,
  as this packet requires.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 203 tests, 203 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r3a-unit-2026-09-08.log
  node scripts/build.mjs - exit 0. Log: app/test-output/r3a-build-2026-09-08.log
  node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts - exit 0. Log: app/test-output/r3a-desktop-2026-09-08.log
Local fixture evidence versus live provider evidence: local only. No provider session was created and no
  probe was started; R1-A containment and R0 clock injection are intact. No real account has
  TOOL_CONFINEMENT evidence, so automatic start remains blocked in production, which is correct.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN.
Remaining defects and exact next item:
  The renderer passes OFFICIAL_TERMINAL_HANDOFF because that is the only route the app wires; when an
  automatic-start route is added after R5 it must pass its own route rather than inheriting this one.
  Next item is R2-B in section 5.1.
~~~

~~~text
Date / item / status: 2026-09-08 / R2-B / VERIFIED_LOCAL for items 1-4; one limitation documented.
Problem and resulting behavior:
  Item 1 - ensureLocalRoot called realpathSync first and then compared only the leaf, so a junction
    several directories above the project folder was resolved away silently and never reported.
    verifyStagedSnapshot did not check the staging root for links at all, and reconstructSnapshot
    deleted its destination recursively without validating the path it was about to remove.
  Item 2 - GIT_SAFETY disabled some settings but left attributes, external diff, credential and filter
    helpers unset, and nothing inspected the repository's own metadata. Git will execute a helper or a
    hook it finds inside the repository it is asked about. The inherited-variable filter was
    case-sensitive, so a lower-cased git_dir would survive it on Windows, where names are not.
  Item 3 - rev-list failure was ignored, and "not unequal" was treated as agreement. Nothing compared
    the committed tree itself, so an extra commit, a wrong file mode, an unrelated ref or a staged
    modification hidden behind a cached status could all pass.
Changed source/test files:
  app/src/main/locations.ts - assertNoLinkedAncestor walks every component from the filesystem root
    down, with lstat, and is applied to the project folder, the staging directory and the
    reconstruction destination; a component that does not exist yet is not treated as a link.
    ensureOwnedStaging additionally confirms a staging path sits under the root the office owns.
    assertPlainStagingRepository refuses a `.git` link or file indirection, info/attributes, grafts,
    alternates, commondir, modules, an installed (non-sample) hook, a configuration naming a program
    or external object store, and any branch other than the frozen one - and it runs before Git does,
    so a tree carrying such metadata is never handed to Git at all. GIT_SAFETY additionally neutralises
    attributes, excludes, external diff, ssh, credential and LFS filter settings; the inherited
    environment filter is now case-insensitive. Commit identity moved from repository config to
    per-invocation flags, so the staging config stays exactly as `git init` wrote it.
    verifySnapshotForTransfer now fails on any Git command error rather than only on unequal output,
    adds a HEAD-versus-working-tree diff that a cached status would miss, checks the commit is
    parentless, lists refs, and enumerates the committed tree path by path with modes and blob
    identities against the frozen manifest, reporting missing, extra, non-blob and wrong-mode entries.
  app/tests/locations.test.ts - four regressions: a sentinel program is referenced from repository
    config, a hook, alternates and attributes, and is asserted never to have executed after every
    check; a `.git` indirection and an extra branch are refused; an extra commit and a staged-but-
    hidden modification are both caught; an ancestor junction on the project folder is refused rather
    than resolved away.
Two bugs in my own hardening, found by the suite and fixed before it passed: a path component that does
  not exist yet was reported as a link, and refusing on the presence of `.git/config` was wrong because
  `git init` writes one. The config check now inspects content for keys that can execute, and the hook
  check ignores the disabled `.sample` files.
Limitation documented rather than claimed solved: the post-copy source re-examination narrows, but does
  not eliminate, a directory swap-and-restore race. Node's synchronous filesystem API offers no
  handle-based read that would close it on Windows, and no demonstrated design was available here. The
  behaviour is unchanged from R2 and is recorded as an open unsupported case, not as solved.
Migration and compatibility impact: no schema change. Snapshots prepared before this round have their
  commit identity in `.git/config`; that config has no executable keys, so they still verify. Staging
  directories carrying any of the refused metadata now fail verification, which is the intended effect.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 207 tests, 207 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r2b-unit-2026-09-08.log
  node scripts/build.mjs - exit 0. Log: app/test-output/r2b-build-2026-09-08.log
  node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts - exit 0. Log: app/test-output/r2b-desktop-2026-09-08.log
Local fixture evidence versus live provider evidence: local only, against the real installed git
  2.46.2.windows.1. The junction fixture skips itself where link creation requires privileges, and says
  so, rather than silently passing.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN.
Remaining defects and exact next item:
  The swap-and-restore race above is unresolved and unsupported.
  Same-commit reconstruction remains asserted only for the recorded fixture under the recorded Git and
  platform metadata; it is not a cross-platform guarantee, as the 5.1 review correctly noted.
  verifySnapshotForTransfer accepts a managedRoot argument but the controller does not yet pass one;
  wiring it belongs with R2-A's production reconstruction work.
  Next item is R2-A in section 5.1.
~~~

~~~text
Date / item / status: 2026-09-08 / R2-A / VERIFIED_LOCAL for items 1-4; item 5 partly, as described.
Problem and resulting behavior:
  Item 1 - reconstructSnapshot had no caller. A restore does not carry disposable staging, so the
    first launch afterwards failed against inputs whose bytes the workspace still held.
  Item 2 - prepareInputSnapshot checked the request revision before the asynchronous Git work, but
    recordInputSnapshot only checked project membership and createAssignment accepted any snapshot
    from the same project. A request edited while Git ran, or a snapshot frozen for entirely different
    work in the same project, was accepted.
  Item 3 - allocateOutputDestination was a candidate-path lookup. Two callers could be handed the same
    attempt, and an empty directory another attempt had already claimed looked free.
  Item 4 - none of the writable-output validation was on a production path.
Changed source/test files:
  app/src/core/store.ts - recordInputSnapshot re-checks the exact request, its revision and the
    location revision inside the transaction, which is the only place that can see a change made while
    Git was running. createAssignment additionally requires the snapshot to name this request and this
    revision; a project-only or legacy snapshot is refused and must be prepared specifically.
  app/src/main/locations.ts - reserveOutputDestination replaces the lookup with an actual reservation:
    exclusive mkdir settles races, a marker file records the holder, a matching idempotency key
    re-enters its own reservation after a retry, and any other occupied directory is skipped rather
    than appropriated. releaseUnusedReservation removes only a directory holding our own key and
    nothing else, so a directory with results in it is never deleted. Generated path components are
    validated before any write, and the destination's ancestors are checked for links.
  app/src/main/controller.ts - a recoverStaging hook is called before verification on both the dispatch
    and handoff paths. It returns a copy of the snapshot carrying the runtime location; the recorded
    snapshot keeps its original identity and is never rewritten to describe where its bytes now sit.
  app/src/main/main.ts - buildController wires the real reconstruction against the workspace object
    store and the app-owned staging root, and scopes transfer verification to that same root.
  app/tests/locations.test.ts - reservation regressions: exclusive creation, retry re-entry, an empty
    reserved directory that is not free, a directory holding results, per-assignment separation, and
    release semantics. Snapshot-identity regressions for another request and for an edit or selection
    change made while staging ran.
  app/tests/cooperation.test.ts - two regressions on the real preflight path: with the staging
    directory and the source folder both deleted, dispatch rebuilds from stored bytes, reaches the
    provider once, and leaves the historical record untouched; with no stored bytes, it refuses and
    launches nothing.
Migration and compatibility impact: no schema change, but two guards are deliberately stricter and can
  reject data earlier builds accepted. A snapshot with no requestId, or one frozen for another request
  or revision, can no longer be used to create an assignment; such work must be prepared specifically.
  This is the intended contract and is why the "legacy/project-only snapshots require explicit
  request-specific preparation" line of the packet is satisfied rather than silently tolerated.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 212 tests, 212 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r2a-unit-2026-09-08.log
  node scripts/build.mjs - exit 0. Log: app/test-output/r2a-build-2026-09-08.log
  node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts - exit 0. Log: app/test-output/r2a-desktop-2026-09-08.log
Local fixture evidence versus live provider evidence: local only. No provider session was created.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN.
Remaining defects and exact next item:
  Item 5 is only partly satisfied. The reconstruction workflow is exercised from a different staging
  root after deleting both the staging directory and the source folder, which is the behaviour that
  matters, but not by performing an actual backup and restore through the Electron restore path; that
  path opens native dialogs the suite cannot script. Recorded as unit-level evidence, not end-to-end.
  reserveOutputDestination is implemented, tested and safe, but is still not called from a transfer
  path, because no output transfer exists until R4-B implements retrieval. It remains a unit.
  Next item is R4-B in section 5.1, then R1-B.
~~~

~~~text
Date / item / status: 2026-09-08 / R4-B / VERIFIED_LOCAL for items 1, 2, 4 and 5. Item 3 partly open.
Problem and resulting behavior:
  Item 1 - the adapters consumed only part of the frozen contract. PTY wrote the objective and ignored
    acceptance criteria, instructions, model and effort; the handoff launched the request name alone.
    Work therefore ran without the criteria that say when it is done or the instructions that say how,
    and a non-default effort was silently dropped rather than refused. The launcher failure also
    asserted "Nothing was submitted", which the office cannot know.
  Item 2 - R4 removed the GROUP/TEAM participant check because a reviewer must not be the author. That
    left every bound agent able to act on every group request; independence explains who may be added,
    it does not authorize everyone.
  Item 4 - ObserveResult output metadata was recorded directly as job outputs. A hash string the office
    never checked against any bytes was enough to certify a deliverable.
  Item 5 - every adapter UNKNOWN was treated as local, so a genuine provider-reported indeterminate
    state could not be distinguished from an adapter saying it cannot observe.
Changed source/test files:
  app/src/main/controller.ts - ProviderPayload and buildProviderPayload assemble the whole contract
    once (request name, objective, acceptance criteria, instructions, delegation policy) and both the
    preview and the launch read it. ObserveResult gains `provenance`, defaulting to OFFICE_LOCAL for
    UNKNOWN, so only an adapter that really heard from the provider claims PROVIDER_REPORTED. observe()
    now fetches and hashes the bytes of every reported output through an injected OutputFetcher,
    verifies length and identity, stores verified bytes content-addressed, drops anything that does not
    match and reports the mismatch. The launch guard requires an unlisted agent on a group or team
    request to hold an explicit, unrevoked grant.
  app/src/main/pty.ts - writes the full payload text rather than the objective, retains exactly what was
    transmitted for comparison with the preview, and refuses a non-default effort outright because this
    route cannot select one, instead of dropping it silently.
  app/src/main/handoff.ts - the launcher failure no longer claims nothing was submitted; it says whether
    anything reached the provider is unknown, which is what is actually known.
  app/src/shared/types.ts, app/src/core/store.ts - new RequestGrant record, `grants` collection, and a
    request.grant command with its schema. Granting on a SINGLE request is refused: a closed roster is
    widened by changing the request, not by handing out permissions.
  app/tests/cooperation.test.ts - five regressions: the adapter receives the frozen criteria and
    instructions, not just the objective; an ungranted agent is refused while a granted independent
    reviewer works, and revoking closes it again; a SINGLE request cannot be widened by a grant; output
    with a wrong hash, a wrong length, or no retrieval route at all is refused while matching bytes are
    stored; a provider-reported UNKNOWN is recorded as provider testimony.
  app/tests/controller.test.ts, app/tests/cooperation.test.ts fixtures - the fake adapters now declare
    outputs from real bytes and serve them through a retriever, as the packet requires, so completion is
    certified by what arrived rather than by a placeholder hash. The review fixture cites the hashes the
    provider actually returned instead of a literal.
Migration and compatibility impact: no schema version bump; `grants` is a new optional collection and
  older workspaces simply have none. Two contracts are deliberately stricter and will reject what
  earlier builds accepted: an unlisted agent on a group request now needs a grant, and a completion
  whose bytes cannot be retrieved and verified is refused rather than recorded. Both are the intended
  effect of this packet.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 217 tests, 217 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r4b-unit-2026-09-08.log
  node scripts/build.mjs - exit 0. Log: app/test-output/r4b-build-2026-09-08.log
  node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts - exit 0. Log: app/test-output/r4b-desktop-2026-09-08.log
  Packaged checks were not run: packaging was not in scope.
Local fixture evidence versus live provider evidence: local only. Output retrieval is exercised entirely
  against fake adapter byte streams, as this packet directs; live output retrieval stays disabled until
  R5 evidence exists, and no provider session was created. R1-A containment is intact.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN.
Remaining defects and exact next item:
  R4-B item 3 is not done: request aggregation over all jobs, queued dependencies and the single
  per-action projection through buttons and store guards are unimplemented. An INTENT blocked by
  preflight is recoverable today only by preparing again; there is no explicit retry path, and an
  active or UNKNOWN job can still be hidden behind a later completed one in the queue view.
  reserveOutputDestination is still not wired to a transfer path; verified output bytes are stored
  content-addressed but not yet placed into a reserved versioned output directory.
  Next item is R1-B in section 5.1.
~~~

~~~text
Date / item / status: 2026-09-08 / R1-B and R4-B item 3 / VERIFIED_LOCAL. R1 step 6 remains external.
Problem and resulting behavior:
  R1 step 2 - the probe built a plain directory by hand and passed a stagingCommit of forty f
    characters and a manifestHash of sixty-four zeros. Those are fabricated values satisfying a
    production contract, and no Git repository existed behind them at all.
  R1 step 3 - adapter.submit was called with no durable record that an attempt had begun, and staging
    was removed in a `finally` whatever the outcome. A crash or a timeout therefore left nothing to
    reconcile, and nothing stopped the interface starting a second attempt on the user's subscription.
  R1 step 4 - readReceipt accepted any session-looking substring. A chunk boundary after ten
    identifier characters matched at end-of-buffer, so a truncated identifier could be stored as a
    creation receipt, as could a bare identifier echoed anywhere or one inside an unrelated URL.
  R1 step 5 - evidence was scoped to the caller's requested model although the command selects none,
    and the raw CLI exception was persisted into long-lived capability evidence.
  R4-B item 3 - the queue reported the latest assignment, so an unresolved job could be hidden behind
    a later completed one, and each view decided independently what to offer.
Changed source/test files:
  app/src/shared/types.ts, app/src/core/store.ts - new ProbeAttempt record and `probes` collection.
    recordProbeIntent refuses while any attempt for that provider is INTENT or UNKNOWN;
    recordProbeOutcome settles one; recordProbeReconciliation closes an unresolved attempt after a
    person checked with the provider. That last one is user testimony about an external system: it
    records no capability evidence and promotes nothing, its only effect is to stop blocking.
  app/src/main/probe.ts - the fixture is now a real generated-only snapshot prepared through
    prepareInputSnapshot, so its commit and manifest hash are genuine and it is refused outright if it
    cannot be committed. Intent is written and committed before the provider is contacted; the receipt
    is persisted immediately on success; a failure after the call becomes UNKNOWN, never "not
    submitted", and its staging is retained deliberately so the attempt can be reconciled. Model scope
    is read from the command the adapter would really run, which selects none, and says so.
    classifyProbeFailure maps a failure to one of six codes with fixed wording, or UNCLASSIFIED.
  app/src/main/pty.ts - readReceipt re-derived from the transcript in section 13: the
    `Created cloud session:` line, then a `View:` line with the official host and path, a 16-64
    character identifier bounded on both sides, and a newline already in the buffer. The stored URL is
    rebuilt from the identifier so CLI query parameters are never persisted.
  app/src/shared/queue.ts - requestJobs aggregates every job on a request with its own settled and
    unresolved standing; requestActions derives one allowed-actions projection mirroring the main
    process guards, including a retryPreparation offer that exists only for work that never reached a
    provider. An entry stays active while any job is unresolved.
  app/tests/probe.test.ts - intent is observed to exist durably while the provider call is in flight;
    an unresolved attempt blocks another and still blocks after a restart, with nothing submitted; the
    fixture has a real commit and manifest hash; a fabricated exception carrying a path and an
    oauth_secret is neither persisted nor returned.
  app/tests/pty.test.ts - every identifier prefix from 16 characters up is refused, as are a short
    identifier, an unrelated host, an unrelated path and a bare echoed identifier; ANSI noise is
    stripped and query parameters are dropped.
  app/tests/cooperation.test.ts - two jobs on one request, one unresolved and one completed later, are
    both reported and the request still shows as awaiting reconciliation; the actions projection is
    checked against the guard the store actually enforces.
One test contract changed as a direct consequence: "a later successful probe supersedes an earlier
  failed one" now has to reconcile the first attempt before starting a second, because the duplicate
  refusal is exactly what this packet asked for. The test reconciles it explicitly and asserts that
  reconciliation verifies nothing, which is the honest reading.
Migration and compatibility impact: no schema version bump; `probes` is a new optional collection and
  older workspaces simply have none. Nothing about R1-A containment changed: the Verify action is still
  refused in main and not offered in the interface, because a repaired implementation is not live
  evidence that the route works. Lifting it needs R5.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 224 tests, 224 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/r1b-unit-2026-09-08.log
  node scripts/build.mjs - exit 0. Log: app/test-output/r1b-build-2026-09-08.log
  node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts - exit 0. Log: app/test-output/r1b-desktop-2026-09-08.log
  Packaged checks were not run: packaging was not in scope.
Local fixture evidence versus live provider evidence: local only. No probe was executed against a
  provider, no session was created, and the receipt contract is validated against the transcript
  recorded in section 13 rather than a new live run.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN. R1 step 6 -
  reconciling it with the provider before authorizing another fixture - is unchanged and still requires
  access that is not available; the earlier approval rejection stands as history and was not bypassed.
Remaining defects and exact next item:
  reserveOutputDestination is implemented and tested but still not called from a transfer path, because
  no output transfer exists yet; verified output bytes are stored content-addressed but not placed into
  a reserved versioned directory.
  R5 remains BLOCKED_EXTERNAL for live evidence, and the Verify action stays contained until it lands.
  The R series is otherwise complete. Next item is C1 in section 10.
~~~

~~~text
Date / item / status: 2026-09-08 / V1 desktop validation / PASS. R4 is now VERIFIED_LOCAL.
What was blocked and why it is no longer blocked: the corrected rerun had been rejected by automatic
  approval review because of a usage limit, which the previous pass correctly recorded as a validation
  blocker rather than a test failure. That limit has since reset. The run was then executed through the
  ordinary mechanism. No indirect workaround was attempted, and no tool, account or execution
  mechanism was switched, as the packet required.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node scripts/build.mjs - exit 0. Log: app/test-output/v1-build-2026-09-08.log
    (run first because the source postdated the previous desktop pass, as the packet directed).
  node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts - exit 0.
    Log: app/test-output/v1-desktop-2026-09-08.log
    Report: app/test-output/desktop-report.json, status PASS, timestamp 2026-09-08T20:43:09.606Z,
    18 checks, pageErrors [].
  The full unit suite was not rerun. The packet explicitly says not to rerun it merely to inflate
  evidence, and no source under test changed for V1 beyond the report's own checks list.
What V1 actually verified: the test pauses the real restore confirmation dialog by holding
  dialog.showMessageBox open, asserts that both window.office.getState() and
  window.office.connectionStatus('claude') reject with "workspace is being restored" while the lock is
  held, releases the dialog with a decline, and then confirms the workspace is still usable and still
  holds the seeded inert profile. That is the controlled-promise restore-lock test the packet asked
  for, not the earlier concurrent-missing-ID smoke.
One correction made, and why it was not cosmetic: those assertions ran and passed, but the report
  written at the end of the suite listed sixteen checks and named none of the restore-lock or
  discard-preparation work. The saved evidence therefore understated what had been verified, and a
  later reader comparing the report against this packet would have concluded V1 had not run. The
  checks array now names "discard preparation guard" and "restore admission lock (V1)", and the suite
  was rerun once so the saved report is accurate. Both runs passed; the first is superseded by the
  second only in its checks list.
Changed files: app/tests/desktop.e2e.ts - report checks list only. No application source changed, so
  the typecheck and build above cover it and no other suite needed rerunning.
Local fixture evidence versus live provider evidence: local only. No provider session was created, no
  probe was started, and R1-A containment is untouched. V1 supports no packaging or live readiness
  claim, exactly as the packet states.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN and still
  requires the section 5.3 reconciliation before any further fixture.
Remaining defects and exact next item: R5 remains BLOCKED_EXTERNAL for live evidence. R6/R7 are not
  complete and are delivered through C1-C7. Next item is C1 in section 10.
~~~

~~~text
Date / item / status: 2026-09-08 / C1 research spec, ledger and stage reducer / VERIFIED_LOCAL.
What was built:
  app/src/shared/research.ts - new. STAGES S0-S10 and the fourteen stable gate identifiers; strict
    shapes for ResearchBranch, FrozenResearchSpec, PredictionRecord, TrialLedgerEntry, StageAttempt and
    GateReceipt; the STAGE_GATES prerequisite table and the MANDATORY_GATES list; the pure nextActions
    reducer; lineageCounters and exposure. The reducer is pure and side-effect free so the interface,
    the tests and the store all read one answer instead of three implementations that drift.
  app/src/shared/types.ts, app/src/core/store.ts - six new optional collections, so a workspace
    recorded before C1 loads and replays unchanged. The legacy Experiment `Stage` union is untouched;
    the research one is imported under an alias precisely so old Role and Stage events keep working.
    Specs, predictions, trials, attempts and receipts are immutable once written; branches version.
  Commands: research.draftSpec, freezeSpec, registerVariant, createStageAttempt, amendBranch and
    settleBranch, each with expected revisions and idempotency through the existing key mechanism.
    recordGate is deliberately NOT a renderer command; gate receipts are main-only evidence, and the
    reducer reads them rather than accepting them from the interface.
Decisions worth recording, because they are the point of the slice rather than incidental:
  - A frozen specification cannot be edited at all. draftSpec on a branch whose spec is frozen is
    refused, so lowering a threshold after seeing a weak result is impossible without a new branch.
  - Freezing requires all seven mandatory sections to be non-empty. A specification with a blank
    section is not a preregistration, and freezing one would make G-SPEC meaningless.
  - A gate receipt carries subjectHash and specId, and the reducer only counts one matching both. A
    receipt earned by one candidate, or under a superseded specification, authorizes nothing.
  - NOT_APPLICABLE requires the gate to have been declared inapplicable in the frozen spec AND the
    receipt to carry a rationale. Without that, "this check does not apply here" is just a way to skip
    a check that became inconvenient.
  - A failed mandatory gate cannot be waived by any means the reducer offers.
  - An amendment creates a linked child sharing the lineage; it never rewrites the parent. Follow-up
    allowance and trial counters are lineage-wide, so renaming resets nothing.
  - A metadata-only retry is recorded in the ledger but does not increase distinctVariants, so a
    transport retry cannot inflate a multiplicity count while still being preserved.
  - Scientific outcome is a branch property independent of any provider job state, so VALID_NEGATIVE
    is a finding that is preserved rather than a retirement.
Item 5's migration summary: none was written, and that is deliberate rather than an omission. The
  legacy ResearchContract on Experiment is a different shape serving the old flow, and nothing in it
  constitutes a frozen preregistration. Auto-converting it would manufacture exactly the frozen S0 the
  packet forbids. Legacy contracts stay readable where they are; a branch must be drafted and frozen
  explicitly. If a conversion is ever wanted it belongs in its own reviewed slice.
  app/tests/research.test.ts - new, twelve tests covering all nine exit conditions: immutable freeze;
    threshold mutation rejected; amendment creates a linked branch; a repeated idempotency key does not
    duplicate; missing, stale-spec and wrong-subject gates all blocked; negative result preserved; one
    follow-up allowance surviving a rename through an amended child; no automatic promotion or freeze
    on restart with historical event hashes byte-identical after replay. Two further tests cover stage
    ordering and the mandatory-section count.
Migration and compatibility impact: no schema version bump. Every new collection is optional and absent
  from older workspaces. Replay was verified to leave historical event hashes unchanged.
Commands actually run, exit codes and dated log paths:
  node node_modules/typescript/bin/tsc --noEmit - exit 0, no diagnostics.
  node --import tsx --test tests/*.test.ts - exit 0; 247 tests, 247 pass, 0 fail, 0 skipped, 0 cancelled.
    Log: app/test-output/c1-unit-2026-09-08.log
  node scripts/build.mjs - exit 0. Log: app/test-output/c1-build-2026-09-08.log
  node node_modules/tsx/dist/cli.mjs tests/desktop.e2e.ts - exit 0. Log: app/test-output/c1-desktop-2026-09-08.log
Local fixture evidence versus live provider evidence: local only. C1 is schemas, a reducer and a
  ledger; it runs no research, contacts no provider and creates no session. Nothing here is evidence
  that any candidate is correct, and passing the reducer is not passing a gate.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN.
Remaining defects and exact next item:
  The reducer is not yet wired to any interface or to the assignment lifecycle; createStageAttempt
  accepts an assignmentId but nothing yet creates one from a stage. That integration is C4's
  stage orchestration, not C1's.
  No evidence layer exists yet, so evidenceRef on a receipt is an opaque string this slice does not
  resolve. That is C2.
  Next item is C2 in section 10.
~~~

Completion rules: mark only criteria actually met. Update stale current-state claims when code changes. Historical reports remain intact with dates. If checks fail, record the exact failure and whether it is a product assertion or tool startup problem. Do not claim low token use, scientific correctness, real slippage or independent review from unmeasured assumptions.

### Next-round planning update — 2026-09-08

Read the R0 implementation/report and saved unit log; inspected controller's evidence check and all three injected-clock readiness calls. R0 remains VERIFIED_LOCAL: 175/175 in the existing log; typecheck PASS is recorded by the R0 execution report. No application tests were rerun in this documentation update. The defensive SINGLE/delegation invariant remains intentionally untested because it is unreachable through current public state creation; do not fabricate state to claim public-path coverage.

Read the Token Optimization conversation including its latest visible messages. Incorporated a compact code map/current-state/decision structure inside this file, selective revision-aware reading, one-writer coordination and optional developer Serena trial. No new plan/state documents, client instruction files, MCP configuration or plugin installations were created. Product training/research boundary and staged scientific gates are unchanged.

Next exact item: R1-A containment, with sequence, files, retained IPC shape, side-effect boundary, regressions and verification scope in section 5. R1-B remains pending after R2–R4. Removed stale “first reproduce R0” instructions from the current command path. R3 explicitly tracks the remaining difference between delegation control and verified tool confinement.

Validation for this update: inspect Markdown links/anchors, fences, task inventory and freshness prefixes after edits. This verifies documentation consistency only. Last application baseline remains the R0 run, not a fresh run attributed to this update.

### Source review of R2–R4 completion report — 2026-09-08

Documentation-only review; no application edits/tests/provider calls. Read the pasted report, current controller/readiness/locations/main/store/adapters and saved evidence. Confirmed the r4 unit log ends with 195 tests passed, zero failures; saved build log reports success. Current desktop-report.json says PASS at 2026-09-08T12:16:18.637Z (development). Typecheck success is from the implementation report, not rerun here.

Corrected current parent statuses to PARTIALLY_VERIFIED_LOCAL and next task to R4-A. Preserved previous slice entries verbatim as historical implementation reports; their “complete” or “next C1” assertions are superseded by section 5.1 and the current table. Identified additional source gaps in handoff provider routing, post-await guards, restore admission, operation evidence transport/order/confinement, production reconstruction/output reservations, exact snapshot request linkage and real payload consumption. R1-B remains local work; unverified R5 access is not a reason to skip it. No new assertion about actual provider availability was made.

Next exact round: implement only R4-A's shared launch/restore guards and controlled-promise regressions, run its verification set, update this file and relevant code-map fingerprints. Then R3-A → R2-B → R2-A → R4-B → R1-B. C1 remains eligible for later independent fixture work, but it is no longer the default repair pointer.

### Slice entry — local integration completion pass, 2026-09-08

Historical status before V1 (superseded by V1 PASS above): implemented and unit-tested; V1 final desktop rerun blocked by automatic approval review. This entry superseded earlier statements that the entire R series was complete or that output reservation had no production path.

Changed code: main/outputs.ts (new), core/object-inventory.ts (new), main/controller.ts, main/locations.ts, main/artifacts.ts, main/recovery.ts, main/main.ts, main/preload.ts, shared/types.ts, shared/transport.ts, shared/cooperation.ts, core/store.ts, core/jobs.ts, renderer/dispatch.tsx and renderer/office.tsx. Tests updated/extended: controller, cooperation, locations, probe and desktop.e2e. No dependency/version change, Git commit, package, live session or provider capability promotion.

Behavior and regression coverage are section 5.2. Persistence additions are optional objectsStored on InputSnapshot, outputFolder on FrozenAssignmentPayload and stored on JobOutput, with matching strict runtime schemas. Original events are not rewritten. New required objects must round-trip; old metadata is never promoted by migration. New bridge method discardPreparation is validated in main and limited to INTENT with no dispatch timestamp/receipt. General workspace handler admission protects async metadata writes during restore.

Actual validation: first targeted suite 51/51; expanded recovery suite 83/83; full suite 235/235; final containment suite 10/10; typecheck and build exit 0. Development desktop passed before the final all-handler restore change. The final restore regression encountered an invalid backup destination; that fixture path was corrected, but automatic review then rejected the rerun due to its usage limit. Do not label final desktop validation green. Full logs and the older successful report's exact scope are section 12.

Next: V1, then C1–C7. R5 needs section 5.3's official evidence; this local verification rejection is distinct from the historical provider-operation rejection in section 13. R6/R7 retain their unimplemented program. No need for the user to re-add a Claude profile or provide credentials.

### Slice entry — C2 artifact/query layer and evidence briefs, 2026-09-08

Date / item / status: 2026-09-08 / C2 / VERIFIED_LOCAL for items 1–5; the section 8.4 token baseline was not run and no efficiency claim is made.

Problem and resulting behavior: stored objects had an inventory for backup but no permissioned way to read, search or quote them, so a summary of a run could be produced without anything binding it to bytes or reporting what it failed to read. Now one content-addressed manifest carries each object's origin and permitted provenance without upgrading it; describe/read/query enforce request and project grants in main before any index lookup or cache hit and return returned/omitted counts with COMPLETE/PARTIAL/UNKNOWN coverage; an unreadable object is named rather than skipped, so an empty search cannot read as an absence of findings; cursors are bound to the object that issued them; the computation cache is keyed on object bytes plus current gate and review state, never on filenames or prompt text, and every reuse writes its own receipt naming the receipt it reused; raw answers are stored before a brief is validated, and a brief is refused unless every quotation still hashes to the stored bytes and its missing coverage is declared when its queries were incomplete. Objects missing locally are recovered through both backup readers with the hash re-checked, and a local or loopback path cannot be labelled a hosted retrieval handle.

Changed source/test files: new app/src/shared/evidence.ts, app/src/main/evidence.ts, app/src/renderer/evidence.tsx, app/tests/evidence.test.ts, app/tests/evidence-cache.test.ts; edited app/src/shared/types.ts (OfficeAPI evidence methods), app/src/main/main.ts and app/src/main/preload.ts (four IPC channels), app/src/renderer/styles.css, app/tests/desktop.e2e.ts (bridge surface list).

Migration and compatibility impact: additive. No store schema or event change, so historical event hashes are untouched and old workspaces read normally. Legacy snapshots without stored bytes are reported as unavailable rather than empty. The evidence receipt/brief ledger is a new append-only JSONL directory under the workspace; it holds no object bytes and does not create a second object store.

Commands actually run, exit codes and dated log paths: `npx tsc --noEmit` (0); `npx tsx --test tests/*.test.ts` 261/261 pass (0); `node scripts/build.mjs` (0); `npx tsx tests/desktop.e2e.ts` (0, screenshots in app/test-output); `npx tsx tests/revision.desktop.ts` (0). Baseline before the slice was 247/247. No provider call, packaging run or section 8.4 measurement was performed.

### Slice entry — C3 deterministic research contracts and CatBoost ingestion, 2026-09-08

Date / item / status: 2026-09-08 / C3 / VERIFIED_LOCAL for items 1–5. No dataset performance is claimed and none was measured; that was explicitly outside this slice.

Problem and resulting behavior: the office could store a research result but had no way to say whether it was methodologically admissible, so a leaked feature, an outer-test early stop or a strategy whose costs exceed its edge would all have imported cleanly. Now strict manifest, split, fit-scope, prediction, cost, portfolio, receipt and diagnostic schemas exist, and eleven deterministic gates judge them: a feature knowable only after its own row fails G-TIME on the manifest rather than being inferred from performance; a target present among the features, or with a zero horizon, or with a horizon the split plan does not purge for, fails G-TARGET; purge plus embargo that does not cover the label horizon fails G-SPLIT even when folds do not overlap; outer-test early stopping and fits running past their training window fail G-FIT, and a fold with no recorded scope blocks rather than passing; selection on the test or full dataset fails G-SELECT; duplicated out-of-fold rows fail G-INTEGRITY and unresolved outcomes block instead of counting as zero; positions traded before their decision time fail G-TRADETIME. Period economics are computed by one documented formula, matched against a hand-worked golden fixture, and a held asset with no realised return makes the period unpriceable rather than free. G-SPEC blocks an exploratory submission from ever satisfying a preregistration and fails a prospective claim whose earliest run predates the freeze. Diagnostics are judged against thresholds that come only from the frozen specification, distinguishing insufficient data from an undefined metric, and a report carrying economic fields is refused so a forecast cannot be summarised as a profit. The importer reads delivered prediction rows rather than the package's description of them, carries the failed-run ledger through whole, refuses undeclared files, and executes nothing. A local research fallback throws by name.

Changed source/test files: new app/src/shared/research-contracts.ts, app/src/shared/research-diagnostics.ts, app/src/core/research-gates.ts, app/src/main/research-templates.ts, app/tests/research-gates.test.ts, app/tests/research-import.test.ts; new app/research-templates/ (README.md, data.v1.py, diagnostics.v1.py, portfolio.v1.py, cost.v1.py, golden/economics.v1.json); edited app/src/main/artifacts.ts (inspectResearchPackage).

Migration and compatibility impact: additive and pure. No store schema, event or IPC change; the existing inspectResultArchive path is untouched, so older result imports behave exactly as before. The template scripts are authored and exported for the hosted route and are never executed by the desktop; core/research-gates.ts refuses a local fallback explicitly. Packaging these template files with the application remains a C7 item.

Commands actually run, exit codes and dated log paths: `npx tsc --noEmit` (0); `npx tsx --test tests/*.test.ts` 287/287 pass (0); `node scripts/build.mjs` (0); `npx tsx tests/desktop.e2e.ts` (0, screenshots in app/test-output); `npx tsx tests/revision.desktop.ts` (0). Baseline before the slice was 261/261. No provider call, packaging run or research execution occurred.

### Slice entry — C4 stage orchestration and independent reviews, 2026-09-08

Date / item / status: 2026-09-08 / C4 / PARTIALLY_VERIFIED_LOCAL. Items 1, 3 and 5 implemented and tested; item 4 was already met by R4 and is unchanged; item 2 exists as a read-only scheduler and is not yet the path dispatch takes. Open subitems are listed in the section 11 row.

Problem and resulting behavior: stage work was routed by four interchangeable PM roles, and independence was a label rather than a property. Now a profile holds a named scientific function through an append-only assignment recorded against its exact revision: re-assigning appends and supersedes, an edited or removed profile blocks its function instead of running under changed instructions, and legacy roles are migrated by appending rows marked MIGRATED_FROM_ROLE without touching any profile's provider, model or instructions. The scheduler produces only the current stage's assignments, freezing a context hash over branch, specification, subject, stage, function, profile revision and output schema, and a SINGLE request that would need an independent reviewer reports that its roster is closed rather than recruiting one. A correctness packet carrying any performance field is refused rather than redacted, a packet naming two subjects is refused, and the advocate and skeptic receive byte-identical evidence under one hash. First reports are sealed by content hash and cannot be opened until every expected reviewer has filed. Independence is labelled from observed confinement evidence for the exact route: a separate session with no such evidence gets the weaker honest label, and a shared session or a self-review gets none. Adjudication has four outcomes and no override: a defect found by either side suspends the lineage, every mandatory gate is rechecked against the exact subject first, and one scientific follow-up per lineage survives renames and restarts.

Changed source/test files: new app/src/main/context-policy.ts, app/src/main/research-controller.ts, app/src/renderer/review.tsx, app/tests/research-controller.test.ts, app/tests/blinded-review.test.ts; edited app/src/shared/research.ts (StageFunction, FunctionAssignment), app/src/core/store.ts (functions collection, schema, projection and appendFunctionAssignment), app/src/shared/types.ts, app/src/main/main.ts and app/src/main/preload.ts (three IPC channels), app/src/renderer/styles.css, app/tests/desktop.e2e.ts.

Migration and compatibility impact: the `functions` collection is additive and optional, so existing workspaces read normally and historical event hashes are unchanged. Assignments are appended and superseded rather than edited. No existing command, review rule or dispatch path changed behaviour; recordReviewDecision and reviewStatus are untouched.

Commands actually run, exit codes and dated log paths: `npx tsc --noEmit` (0); `npx tsx --test tests/*.test.ts` 304/304 pass (0); `node scripts/build.mjs` (0); `npx tsx tests/desktop.e2e.ts` (0, screenshots in app/test-output); `npx tsx tests/revision.desktop.ts` (0). Baseline before the slice was 287/287. No provider call occurred and no isolation claim is made from these fixtures.

### Slice entry — C5 holdout custody and exposure accounting, 2026-09-08

Date / item / status: 2026-09-08 / C5 / PARTIALLY_VERIFIED_LOCAL for items 1–5 against a fake isolated evaluator. No live sealing is claimed and no real holdout was consumed.

Problem and resulting behavior: a final holdout is meant to be looked at once, and nothing in the office made that true. Now sealed bytes live outside the agent-visible workspace, checked as a path relationship rather than trusted from configuration, so a sealed store inside the workspace is refused by name; the same check keeps the exposure journal outside anything a restore replaces. Custody is capability-checked: without sealed storage and an isolated evaluator, S8 stays blocked and there is no local file or token that substitutes. A reservation is journalled before any bytes move and already costs the allowance, the journal is re-read immediately after writing so two admissions racing for the last slot cannot both take it, and the allowance renews on the calendar quarter boundary in the holdout's own declared zone rather than the machine's. A renamed lineage gets no fresh allowance. The evaluator is handed only the sealed bytes, the candidate hash and the predictions, and exposure is journalled before it runs so a crash inside it still counts as a look. A manual export records exposure before the handover and classifies what comes back as user-attested rather than as an isolated evaluation. Re-fetching the same report on the same candidate is free; a changed candidate or a different query needs its own reservation. Only verified non-exposure releases an allowance — a failed run, a lost receipt or a partial delivery do not. The journal is hash-chained, so an edited entry is detected; and because the journal is the authority rather than the database, restoring a workspace that has never heard of a reservation marks it spent and of unknown exposure and blocks reuse until a person settles it.

Changed source/test files: new app/src/shared/holdout.ts, app/src/main/holdout.ts, app/tests/holdout.test.ts, app/tests/holdout-recovery.test.ts. No existing file changed.

Migration and compatibility impact: entirely additive and outside the store. No schema, event, IPC or backup change; the backup test in tests/holdout-recovery.test.ts asserts that a sealed hash appears nowhere in a workspace backup and resolves to nothing through the evidence layer.

Commands actually run, exit codes and dated log paths: `npx tsc --noEmit` (0); `npx tsx --test tests/*.test.ts` 323/323 pass (0); `node scripts/build.mjs` (0); `npx tsx tests/desktop.e2e.ts` (0); `npx tsx tests/revision.desktop.ts` (0). Baseline before the slice was 306/306.

### Slice entry — C6 shadow, monitoring and research export, 2026-09-08

Date / item / status: 2026-09-08 / C6 / PARTIALLY_VERIFIED_LOCAL for items 1–4. Renderer panels are open and belong with C7. Passing these tests authorises software behaviour, not capital deployment.

Problem and resulting behavior: a shadow period is only worth running if it is genuinely prospective, and nothing enforced that. Now a prediction recorded at or after the moment it forecasts refuses the whole period rather than being scored, predictions that have not reached their horizon are reported as open rather than as a result, and missing outcomes above the frozen share suspend the period instead of scoring the part that happens to have arrived. Too few resolved outcomes is UNKNOWN with the reason stated, never a quiet zero. Missing quotes are reported alongside the verdict rather than instead of it. A drift alarm and a kill threshold are separate outcomes because they ask for different things. A simulated fill is refused as evidence of market impact by name, since it was priced against a book that did not move in response to it. Changing a frozen threshold invalidates a verdict rather than rescoring it. On the ledger side, a search returns failures first because the reason to search before starting is usually to discover the idea already failed; a retirement stays visible from every descendant that might repeat it; calibration excludes retrospective records, counts them, and carries a binomial standard error so a run of four is not read as a calibration; and a method comparison on fewer than ten trials is reported as a count rather than a winner. The research package carries exact code, data, gate and review references with its limitations inside the package, and its approval statement is validated: language claiming approval to trade or deploy is refused, and a statement that only says what was approved is refused too.

Changed source/test files: new app/src/shared/shadow.ts, app/src/core/monitoring.ts, app/tests/shadow.test.ts, app/tests/monitoring.test.ts, app/tests/release-manifest.test.ts; edited app/src/main/artifacts.ts (buildResearchPackage).

Migration and compatibility impact: additive. No store schema, event or IPC change, and the existing export and backup paths are untouched. A test asserts that shared/shadow.ts references no network, socket or order-submission interface.

Commands actually run, exit codes and dated log paths: `npx tsc --noEmit` (0); `npx tsx --test tests/*.test.ts` 340/340 pass (0); `node scripts/build.mjs` (0); `npx tsx tests/desktop.e2e.ts` (0); `npx tsx tests/revision.desktop.ts` (0). Baseline before the slice was 323/323.

### 2026-09-09 — cleanup and initial C7 integration

Removed only four obsolete release ZIPs, versions 0.1.0–0.4.0: 651,801,674 bytes (621.6 MiB). Exact paths and sizes: [cleanup manifest](cleanup-2026-09-09.json). Source, dependencies, historical test evidence, provider-session records and current extracted release retained. No Git repository exists; earlier map hashes are stale navigation hints.

ResearchPipeline now mounts on Research, scopes branches and trials to the selected project, uses only recorded receipt subject hashes, renders existing BranchStanding, and exposes EvidencePanel only for granted profiles. Planning mode is explicitly a preview, not a request mutation. Missing receipt subjects and unavailable holdout/hosted dispatch remain visible. Added pipeline.desktop.ts covering this bounded surface. Packaging includes authored research templates; version remains 0.5.0.

Consolidated verification after edits: typecheck passed; full units 340/340 ([raw log](../app/test-output/verification-2026-09-09-unit.log)); build passed; development desktop and revision suites passed; pipeline fixture passed after fixing project selection and an accessible label. Sandbox initially prevented test/build execution; approved unsandboxed reruns succeeded. Packaging and packaged pipeline/desktop checks also passed; see app/test-output/packaged-desktop-report.json and pipeline-desktop-report.json. The packaged native PTY fixture remains unverified. No live provider call or token-efficiency measurement occurred. This is not completion of C4–C7. Preserve their outstanding persistence, scheduling, isolation, bounded-query and acceptance requirements.
### Slice entry — independent confirmation and containment repairs, 2026-09-12

Historical; superseded by the final C4–C7 entry at the end of this section and by section 12.1.

Status: VERIFIED_LOCAL for the corrections and containment described in section 12, not completion of C4–C7. Reproduced the 354/354 baseline, demonstrated eleven missing negative cases, added thirteen regressions overall, and passed 367/367 units plus source/build/desktop verification. The application never dispatches a live provider job in these fixtures. Changed source/test files, compatibility impact, raw logs and exact open work are recorded below. This entry supersedes the earlier statement that the C4(a) batch's collection/adjudication/custody plumbing was fully verified.

### Slice entry — durable stage completion admission, 2026-09-12

This implementation closes the gate-free S1 advancement defect, not the C4 parent or the requested C4–C7 program. No new hosted evidence, release, version change or provider session was created. C4–C6 remain PARTIALLY_VERIFIED_LOCAL and C7 remains IN_PROGRESS for the exact unresolved contracts in the current table. (Historical status as of this entry; the later entry at the end of this section records C4–C7 as VERIFIED_LOCAL.)

Implemented:

- Stage preparation appends its durable OPEN StageAttempt in the same transaction as assignment/job intent. FAILED and CANCEL_ACKNOWLEDGED transitions abandon that attempt atomically; provider COMPLETED alone does not complete a stage.
- Collection verifies stored report bytes against both SHA-256 and declared size, rechecks current branch/request/context inside the store transaction, and appends an exact STAGE_COMPLETION together with provider gate claims and the completed attempt. Gate-free reports are durable. Invalid gates roll back the whole collection; duplicate/concurrent collection is idempotent.
- S1 advancement now requires a collected report for the exact branch revision, specification, subject and linked request revision. The status projection reports the same missing-completion blocker. S0 retains its separate office-verified prospective specification gate. Provider PASS/NOT_APPLICABLE remains BLOCKED; S2–S10 remain contained.
- Generic record writes cannot manufacture STAGE_COMPLETION. Assignment-linked attempts are owned by preparation, rather than renderer commands. Long report details remain in the stored report; the attempt summary respects its existing 4,000-character bound.
- The desktop pipeline fixture now completes S1 using a fake adapter, real output bytes and real collection before testing S2 containment through IPC. It carries the owned object files into its desktop workspace.

Changed files: app/src/shared/pipeline.ts, app/src/shared/research.ts, app/src/core/store.ts, app/src/main/pipeline.ts, app/src/main/research-controller.ts, app/tests/pipeline.test.ts, app/tests/pipeline.desktop.ts and app/tests/fixtures/pipeline.ts (shared synthetic fixture extracted from the unit test; no provider calls).

Compatibility: additive STAGE_COMPLETION event schema; existing StageAttempt schema and historical event bytes are unchanged. Historical provider completions are not retroactively admitted. Old uncollected assignments without an owned attempt are not silently promoted; current preparation and collection are required. Existing job-output inventory owns the report bytes for backup/export; no new secret or object namespace was introduced. This entry does not establish the remaining C7 migration/backup acceptance criteria.

Actual verification, using C:\Program Files\nodejs\node.exe from app/:

| Command arguments | Exit | Result / raw log |
| --- | --- | --- |
| --import tsx --test tests/*.test.ts (first pass) | 1 | 371/372 passed; new test incorrectly dereferenced an omitted empty receipt collection. [Log](../app/test-output/implementation-2026-09-12-unit.log). Corrected the assertion to recognize absent/empty receipts; did not change the admission expectation. |
| --import tsx --test tests/pipeline.test.ts (affected repair) | 0 | 31/31 passed. [Log](../app/test-output/implementation-2026-09-12-pipeline-repair.log). |
| --import tsx --test tests/*.test.ts (final) | 0 | 372/372 passed, zero failed/skipped/canceled. [Log](../app/test-output/implementation-2026-09-12-final-unit.log). |
| node_modules/typescript/bin/tsc --noEmit (final) | 0 | No diagnostics. [Log](../app/test-output/implementation-2026-09-12-final-typecheck.log). |
| scripts/build.mjs (final) | 0 | Built source version 0.5.0. [Log](../app/test-output/implementation-2026-09-12-final-build.log). |
| --import tsx tests/desktop.e2e.ts (final) | 0 | Desktop checks passed. [Log](../app/test-output/implementation-2026-09-12-final-desktop.log). |
| --import tsx tests/revision.desktop.ts (final) | 0 | Revision desktop checks passed. [Log](../app/test-output/implementation-2026-09-12-final-revision-desktop.log). |
| --import tsx tests/pipeline.desktop.ts (final) | 0 | Pipeline desktop checks passed, including real S1 fixture collection and S2 refusal. [Log](../app/test-output/implementation-2026-09-12-final-pipeline-desktop.log). |

Exact remaining local work: independent harness receipt execution/admission; S2 blinded dispatch and collection; S7 isolated same-evidence delivery, sealed reports, atomic review collection and persisted adjudication effects; then the C5 S8 integration, C6 ingestion/monitoring/panels, and remaining C7 integration/scale/measurement/migration/package checks. The stage-completion changes above are locally verified only for the currently admitted S0/S1 paths, not end-to-end acceptance for S2–S10. No external user action is needed to continue this implementation. R5 remains a separate external gate with the reconciliation instructions in section 5.3. No fresh package or packaged/native checks were run; the existing package is still pre-audit source.

### Slice entry — complete locally actionable C4–C7 revision, 2026-09-12

~~~text
Date / item / status: 2026-09-12 / C4, C5, C6, C7 local completion (R6/R7 local scope) / VERIFIED_LOCAL;
  hosted provider, harness, reviewer isolation and custody remain BLOCKED_EXTERNAL.
Problem and resulting behavior: after the section 12.2 audit the pipeline was contained at S1. Provider-authored
  gate claims could not be distinguished from independently executed harness results; S2/S7 isolation, sealing,
  rebuttal and adjudication helpers existed but were never wired into dispatch or collection; S8 custody had no
  exact reservation/result admission and could be un-spent by restoring an older workspace; shadow ingestion
  accepted non-prospective and uncovered observations; and several renderer views still loaded full message,
  event and research histories on every refresh.
Changed source/test files:
  core: store.ts, research-admission.ts, adjudication.ts, monitoring.ts, shadow-ledger.ts, object-inventory.ts
  main: pipeline.ts, research-controller.ts, context-policy.ts, holdout.ts, evidence.ts, artifacts.ts,
    controller.ts, main.ts, preload.ts, recovery.ts, outputs.ts, locations.ts, probe.ts
  shared: research.ts, research-admission.ts, pipeline.ts, holdout.ts, shadow.ts, evidence.ts, types.ts
  renderer: pipeline.tsx, office.tsx, profile.tsx, dispatch.tsx
  tests: research-workflow.test.ts and fixtures/research-workflow.ts (new integrated S2–S10 fixture),
    holdout.test.ts, holdout-recovery.test.ts, shadow.test.ts, shadow-ledger.test.ts, paging.test.ts,
    research-pages.test.ts, evidence-experiment.test.ts, research.test.ts, desktop.e2e.ts,
    pipeline.desktop.ts, fixtures/pipeline.ts
  Exact reviewed hash prefixes for every file above are in the final freshness table in section 1.3.
Migration and compatibility impact: additive schemas only; no persisted version bump, no historical event
  rewrite and no new secret namespace. Existing StageAttempt, receipt and job-output records remain readable.
  Provider PASS/NOT_APPLICABLE claims are still admitted only as BLOCKED receipts; historical ones are not
  retroactively promoted. Contexts without exact input/revision binding must be re-prepared before launch or
  collection. The durable exposure journal and its checkpoint live outside restorable research state, so an
  older backup is detected rather than believed and cannot release a spent holdout.
Commands actually run, exit codes and dated log paths: see the table in section 12.1. In order: typecheck 0;
  build 0; consolidated units exit 1 with 370/382 (c4-c7-unit.log); affected-file repairs exit 1 with 70/74
  (c4-c7-repairs.log); research-workflow repair exit 0 with 4/4 (c4-c7-workflow-repair.log); targeted reducer,
  migration, backup, paging and pipeline regressions exit 0 with 92/92 (c4-c7-reducer-regression.log); final
  full suite on unchanged source exit 0 with 382/382 (c4-c7-final-unit.log); development desktop, revision and
  pipeline suites exit 0; package exit 0; packaged desktop, revision and pipeline suites exit 0; packaged
  native ConPTY fixture PASS.
Local fixture evidence versus live provider evidence: every research, review, custody and shadow receipt in
  these runs is synthetic and signed by an explicit LOCAL_FIXTURE authority. The desktop and packaged pipeline
  fixtures still refuse S2 through IPC because the shipping application configures no trusted independent
  runtime. No provider job was dispatched, no real holdout was consumed, no order interface exists and the
  section 8.4 experiment measured bytes and local latency only — provider token and quality counters are
  unknown, so no efficiency saving is claimed.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains UNKNOWN; R5 reconciliation
  and evidence requirements are unchanged in section 5.3.
Remaining defects and exact next item: no known critical local omission in the acceptance scope above. The
  next item is external provisioning and verification — an independently operated signed harness and reviewer
  runtime with observable context isolation, and a real custodian service — followed by re-running S2/S7/S8
  acceptance against those routes. Do not repeat the completed local baseline or substitute a local fixture,
  provider-authored gate JSON or a manual custody return for that evidence.
~~~

### Slice entry — R5 historical-session reconciliation attempt, 2026-09-12

~~~text
Date / item / status: 2026-09-12 / R5 reconcile session_01Aj1hpgmeoZLdgYVR9eQ6PB / still
  BLOCKED_EXTERNAL; session confirmed live, observation route not available on this account.
Problem and resulting behavior: section 5.3 requires reconciling the historical cloud session
  before any new probe. The official CLI (2.1.269, C:\Users\louis\.local\bin\claude.exe) is
  signed in with the same claude.ai pro account (louisnn80@gmail.com); `claude auth status`
  confirmed it without any repeat sign-in. An interactive attach was attempted through a real
  ConPTY supplied by the project's own node-pty (the CLI refuses --cloud on a plain pipe). The
  provider rejected it before any session contact: "Attaching to an existing cloud session is
  not enabled for your account." A non-interactive send (stdin prompt to `claude --cloud
  <session-id>`) was accepted: "Sent to cloud session." plus the official view URL, exit 0 -
  proving the session ID is live and receives follow-up input. Two read-only prompts were sent
  to that same session (status only; then proof.json contents, both with "do not modify any
  files"). No CLI route returns the session's reply or transcript: `-p` is still send-only,
  `claude agents --json` lists only local background sessions, and no cloud transcript syncs
  under ~/.claude/projects.
Changed source/test files: none - no application source, schema, fixture or test was changed.
  Evidence artifacts only: app/test-output/r5-cloud-attach-pty.cjs (ConPTY driver),
  app/test-output/r5-cloud-attach-2026-09-12.raw.log and .txt (refusal transcript),
  app/test-output/claude-cloud-spike-SP2mlL/reconcile-2026-09-12.json (machine-readable record).
Migration and compatibility impact: none.
Commands actually run, exit codes and dated log paths:
  claude --version -> 2.1.269; claude auth status -> loggedIn true, pro.
  node test-output/r5-cloud-attach-pty.cjs -> attach attempt exit 1 with the account-gate error.
  echo "<status prompt>" | claude --cloud session_01Aj1hpgmeoZLdgYVR9eQ6PB -> exit 0, "Sent to
    cloud session."
  claude -p --cloud <session-id> "<proof.json prompt>" -> exit 0, same send-only receipt.
  claude agents --json -> exit 0, one local session only.
Local fixture evidence versus live provider evidence: real provider contact occurred - a
  live session existence/send receipt and an explicit account capability refusal. This is
  genuine external evidence about supported routes, not fixture output. It does not establish
  session outcome, output bytes, applied model/effort, isolation or cancellation.
Known unresolved external IDs/operations: session_01Aj1hpgmeoZLdgYVR9eQ6PB remains
  OUTCOME_UNKNOWN - live and addressable, but its status, events and proof.json are observable
  only through the signed-in web transcript (https://claude.ai/code/session_01Aj1hpgmeoZLdgYVR9eQ6PB)
  or an officially supported read route this account does not currently expose via CLI. The two
  prompts sent are now part of that session's history; their replies are in the web transcript.
Remaining defects and exact next item: user opens the session URL in a signed-in browser and
  reports terminal status and proof.json bytes (recorded as USER_REPORTED per 5.3), or a
  supported official observation route is identified. No new probe/fixture until the session has
  a recorded disposition. R5 remains BLOCKED_EXTERNAL; nothing here enables automatic dispatch.

Addendum, same day: the user opened the signed-in web transcript and reported (screenshots)
  that the session executed the fixture and self-reported "task complete" - it read README.md
  and wrote proof.json ({"fixture": "qro-cloud", "status": "ok"}) in /home/user/repo, and a
  follow-up prompt returned a Read of that file with exact contents. The UI shows environment
  "Default" (Anthropic-managed, not self-hosted), model/effort selectors "Sonnet 5"/"Medium",
  and "Resumed session" banners recording hosted-environment restart after idle. The user also
  sent "test" and pressed stop: the UI showed "stopping..." then "stopped" - provider-
  acknowledged interruption via the official web interface. `claude stop <id>` does not manage
  cloud sessions ("No job matching"). Reconciliation of the historical session is therefore
  satisfied at USER_REPORTED level; what remains missing for R5 is a programmatic
  observe/retrieve/cancel loop - on this account the CLI can create and send but cannot read
  session output or cancel, and interactive attach is account-gated off. Web UI observation is
  manual evidence, not an automatable route for the office.
~~~

## 12. Validation evidence

### 12.1 Final C4–C7 revision verification — 2026-09-12, current

**Result: the locally actionable C4–C7 revision is implemented, statically reviewed, verified on current source and freshly packaged.** Scope is the application's own behavior under synthetic fixtures and desktop acceptance with an explicitly `LOCAL_FIXTURE` signing authority. No live provider session, independently provisioned harness, real custodian, real holdout, dataset training, brokerage interface, paid API or optional optimizer was used. Nothing here advances R5 or any hosted gate.

Static review before verification: [c4-c7-static-review.txt](../app/test-output/c4-c7-static-review.txt). It was written against the implementation and produced seven repairs before any test ran — draft revision guard, renderer response shape, export destination confinement, duplicate reviewer-assignment admission, fill conflict/deduplication handling, artifact event export completeness and bounded manifest reuse. No earlier baseline result is represented as verification of these changes.

Commands actually executed from `app`, `C:\Program Files\nodejs\node.exe` as `node` (Node v24.19.0):

| Check | Actual outcome | Dated raw evidence |
| --- | --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | Exit 0, no diagnostics, after correcting two literal-type errors in new desktop assertions | [Typecheck](../app/test-output/c4-c7-typecheck.log) (empty output file) |
| `node scripts/build.mjs` | Exit 0, version 0.5.0 | [Build](../app/test-output/c4-c7-build.log) |
| `node --import tsx --test tests/*.test.ts` (consolidated) | Exit 1; **370/382 pass, 12 fail** | [Consolidated units](../app/test-output/c4-c7-unit.log) |
| `node --import tsx --test` on the affected evidence/holdout/pipeline/research files | Exit 1; 70/74 pass, the four integrated-workflow cases still failing | [Repairs](../app/test-output/c4-c7-repairs.log) |
| `node --import tsx --test tests/research-workflow.test.ts` | Exit 0; 4/4 pass | [Workflow repair](../app/test-output/c4-c7-workflow-repair.log) |
| `node --import tsx --test` on the reducer/migration/backup/paging/pipeline regressions | Exit 0; 92/92 pass | [Targeted regressions](../app/test-output/c4-c7-reducer-regression.log) |
| `node --import tsx --test tests/*.test.ts` (final, unchanged source) | Exit 0; **382/382 pass**, 0 failed/cancelled/skipped | [Final units](../app/test-output/c4-c7-final-unit.log) |
| `node --import tsx tests/desktop.e2e.ts` | Exit 0; 18 checks, no page errors | [Desktop](../app/test-output/c4-c7-desktop.log), [report](../app/test-output/desktop-report.json) |
| `node --import tsx tests/revision.desktop.ts` | Exit 0; 6 checks including 100/125/150/200% zoom | [Revision desktop](../app/test-output/c4-c7-revision-desktop.log) |
| `node --import tsx tests/pipeline.desktop.ts` | Exit 0; 7 checks | [Pipeline desktop](../app/test-output/c4-c7-pipeline-desktop.log) |
| `node scripts/package.mjs` | Exit 0; Electron 44.2.0 win32 x64 package including the native transport module | [Package](../app/test-output/c4-c7-package.log) |
| Packaged desktop, revision and pipeline suites | Exit 0; 18 / 6 / 7 checks, no page errors | [Packaged desktop](../app/test-output/c4-c7-packaged-desktop.log), [revision](../app/test-output/c4-c7-packaged-revision.log), [pipeline](../app/test-output/c4-c7-packaged-pipeline.log), [report](../app/test-output/packaged-desktop-report.json) |
| Packaged native terminal fixture | Exit 0; PASS at 2026-09-12T16:09:45Z | [Packaged native](../app/test-output/c4-c7-packaged-native.log), [report](../app/test-output/packaged-native-report.json) |

The twelve consolidated failures and their causes, none resolved by weakening a gate: stale fixture account timestamps; assertions expecting superseded refusal wording; an archive fixture that must cancel its outstanding request first; a journal-rollback test that expected the old readable-after-restore behaviour, which the new durable checkpoint correctly refuses; and a reducer defect that rejected the intended lifecycle transitions for harness intents and sealed review reports. The reducer defect was a real implementation bug and was fixed with narrowly checked transitions that preserve immutable content; the remaining cases were fixture and expectation repairs. The final full-suite run above was executed against this same unchanged source, so it — not the consolidated run — is the current unit result.

Packaged native acceptance detail: node-pty loaded from `resources\app.asar\node_modules\node-pty` inside the packaged executable, exchanged a transformed nonce through Windows ConPTY and exited 0 (Electron 44.2.0, Node 24.20.0, modules 149, 3.79 s). This is packaged main-process terminal I/O, not hosted transport acceptance.

Section 8.4 measured retrieval experiment, current result: [evidence-experiment.json](../app/test-output/evidence-experiment.json). Over a 137-object synthetic inventory with seven planted defects, both policies recovered all seven — `FULL_CONTEXT` returned 680,492 bytes in 7 retrievals and 1,281 ms; `ON_DEMAND` returned 11,326 bytes in 9 retrievals with 1 forced expansion and 1,443 ms. On-demand retrieval therefore moved far fewer bytes and measured slightly higher local latency. Provider input/output/cache token counters, model quality and hosted latency are `null`/unknown, so **no token or cost saving is claimed**, and no optional optimizer or navigation tool was installed on this evidence.

Honest limits of the passing desktop fixtures: the shipping application still configures no trusted independent ResearchRuntime, so the desktop and packaged pipeline fixtures continue to show S2 preparation and advancement refused through IPC with the blocker visible. The end-to-end S2–S10 workflow passes only where the fixture supplies an explicit `LOCAL_FIXTURE` signing authority. A fixture flag is not isolation evidence, and a manual custody return remains `USER_IMPORTED` and cannot satisfy an independently verified G-INTEGRITY.

Compatibility: additive schemas only; historical event bytes and existing StageAttempt/receipt records are unchanged, and no persisted version bump occurred. Legacy contracts are never auto-frozen, auto-approved or retroactively admitted. Restoring an older workspace copy is detected by the durable exposure checkpoint and cannot un-spend a holdout. The extracted release was replaced by the freshly packaged build of this exact source, as authorized; version remains 0.5.0.

**Not verified in this pass:** R5 live provider access; an independently provisioned and pinned harness runtime; observed reviewer context isolation; a real isolated custodian or holdout; provider token/latency/quality comparison; any capital or brokerage operation. The historical session `session_01Aj1hpgmeoZLdgYVR9eQ6PB` was reconciled later the same day at USER_REPORTED level (see the R5 row in section 11 and the reconciliation slice entry): it is live and accepts non-interactive follow-up, and its web transcript shows the fixture completed, but interactive attach is account-gated and no CLI route returns output or cancels it. A second fixture session `session_01EGR5rEpYHYTqoYtswR8uBv` was created during that cancel-route test and is recorded there. Section 5.3 still governs the remaining steps.

**Exact next item:** external provisioning and verification — reconcile the historical session, obtain an independently operated signed harness and reviewer runtime with observable context isolation, and obtain a real custodian service — then re-run the S2/S7/S8 acceptance against those routes and record VERIFIED_HOSTED only for the exact scope evidenced. Do not repeat the completed local baseline, create a new profile or provider account, run a real holdout, or purchase API capacity on the strength of these local results.

### 12.2 Independent confirmation audit — 2026-09-12, superseded by 12.1

This audit is retained for its reproduction evidence and its corrections. Its containment findings and its "exact next local item" were implemented and verified in the later revision recorded in section 12.1; the counts, package statements and open items below are historical.

**Result: the existing tests were green, but the revision was incomplete.** This was a source and regression audit focused on the newest C4(a)/C7 integration, supported by the full existing R/C test suite, not a claim of exhaustive code correctness or hosted execution.

Reproduction evidence:

- Pre-change baseline: **354 tests passed, zero failed**, plus typecheck exit 0 with no diagnostics. [Unit log](../app/test-output/audit-2026-09-12-baseline-unit.log). The silent baseline typecheck is recorded by the command result; its empty pipeline did not create a log file.
- Ten new pipeline regressions failed against the existing implementation (14 previous pipeline tests still passed). [Pre-fix regression log](../app/test-output/audit-2026-09-12-regressions-before.log).
- A separate adjudication regression reproduced acceptance of an undeclared NOT_APPLICABLE mandatory gate. [Pre-fix applicability log](../app/test-output/audit-2026-09-12-applicability-before.log).

Corrections and their limits:

1. **Exact task identity and delivery:** final assignment context hashes now include branch/request revisions and the complete sorted object-hash inventory. A scheduler preview hash is not the final frozen assignment identity. Submitted payload text carries the exact StageContext, frozen specification and report contract. The terminal adapter still sends only a title, so research handoff is explicitly refused instead of claiming this contract was delivered. Ordinary non-research handoff behavior is unchanged.
2. **No provider self-approval:** a provider-reported completion establishes delivery, not independent harness execution. Reported PASS/NOT_APPLICABLE outcomes become BLOCKED receipts with the original report bytes retained. The store independently rejects such approving claims from an assignment, rejects gates belonging to another stage and requires evidence to name stored output bytes. The narrow office S0 specification check requires the frozen spec hash and a prospective registration. Historical provider-written S0 PASS receipts cannot authorize advancement through the corrected store.
3. **Admission and evidence lifecycle:** launch rechecks the current stage-function appointment; collection rechecks the linked request, exact branch/spec/context and completion after asynchronous reads; repeat collection does not append duplicate receipts. Invalid review report schemas reject missing verdict/defect fields before gate writes. A real store reopen preserves context, blocked evidence and original event hashes.
4. **Containment, not invented integration:** the new pipeline did not call the existing blinded-packet/sealed-round helpers, and its adjudication record did not implement lineage suspension or follow-up consumption. S2–S10 execution, collection and advancement are now blocked in service/store/controller admission; S7 adjudication and S8 reservation remain unavailable. S0/S1 linkage/preparation and planning previews remain local foundations, not an end-to-end research pipeline. Reservation before S8 is also refused. The real desktop IPC fixture confirms S2 prepare/advance refusals with unchanged events and assignments, and displays the blocker.
5. **Applicability and accessibility:** mandatory-gate adjudication now requires a frozen NOT_APPLICABLE declaration and nonempty rationale. The recorded-subject selector has an explicit accessible label, exercised by the desktop fixture.

Changed files (workspace-relative): `app/src/core/store.ts`; `app/src/main/controller.ts`, `pipeline.ts`, `research-controller.ts`; `app/src/shared/pipeline.ts`, `research.ts`; `app/src/renderer/pipeline.tsx`; `app/tests/pipeline.test.ts`, `research-controller.test.ts`, `pipeline.desktop.ts`; this roadmap. Current hash prefixes are in section 1.3. No dependency, package version, authentication configuration, provider evidence, user workspace or Git history was changed. Generated development bundles and test evidence were refreshed; the extracted release was not replaced.

Compatibility: no persisted schema/version bump and no historical event rewrite. Older research assignments remain readable, but contexts without exact input/revision binding must be explicitly re-prepared before launch/collection. No provider dispatch is triggered by reopen/restore. Existing JSONL evidence files, if present, were not deleted or silently promoted; legacy-ledger migration and full new-evidence backup/export acceptance remain C7 work.

Commands actually executed from `app`, using PowerShell `& "C:\Program Files\nodejs\node.exe"` as `node` (Node v24.19.0):

| Check | Actual outcome | Dated raw evidence |
| --- | --- | --- |
| `node --import tsx --test tests/*.test.ts` | Exit 0; **367/367 pass**, 0 failed/cancelled/skipped | [Final units](../app/test-output/audit-2026-09-12-final-unit.log) |
| `node node_modules/typescript/bin/tsc --noEmit` | Exit 0, no diagnostics; repeated after the final accessibility change | [Final typecheck](../app/test-output/audit-2026-09-12-final-ui-typecheck.log) |
| `node scripts/build.mjs` | Exit 0, version 0.5.0; rebuilt after the accessibility change | [Final build](../app/test-output/audit-2026-09-12-final-build.log) |
| `node --import tsx tests/desktop.e2e.ts` | Exit 0; 18 checks, no page errors | [Desktop](../app/test-output/audit-2026-09-12-desktop.log) |
| `node --import tsx tests/revision.desktop.ts` | Exit 0; 6 checks, 100/125/150/200% zoom and lifecycle coverage, no page errors | [Revision desktop](../app/test-output/audit-2026-09-12-revision-desktop.log) |
| `node --import tsx tests/pipeline.desktop.ts` | Exit 0; 7 checks, including S2 IPC/UI containment | [Final pipeline desktop](../app/test-output/audit-2026-09-12-final-pipeline-desktop.log) |

The only change after the full unit/main/revision runs was the recorded-subject selector's explicit `aria-label`; typecheck, build and the affected pipeline desktop suite were rerun. Earlier iteration failures are retained: [targeted run](../app/test-output/audit-2026-09-12-targeted.log) had one property-order-sensitive payload assertion, corrected to compare parsed JSON; [first extended pipeline desktop run](../app/test-output/audit-2026-09-12-pipeline-desktop.log) exposed the missing exact accessible selector label, then the final rerun passed. No test was skipped and no approval gate was weakened to pass.

**Not verified or completed in this audit:** R5 live provider access; an independently pinned hosted gate harness; observed reviewer isolation; a real holdout evaluator; complete C4–C6 stage/monitoring integration; section 8.4 token/latency/quality measurement; current-source packaging and packaged/native validation. The previous packaged PTY report applies only to the pre-audit executable. Do not distribute that executable as containing these fixes. No real holdout, training, backtest, provider session or capital operation was performed. The historical session `session_01Aj1hpgmeoZLdgYVR9eQ6PB` remains unresolved; section 5.3 still governs reconciliation.

**Exact next local item:** define and implement independent harness-receipt admission and durable stage completion (including S1/no-gate stages), then wire the existing S2/S7 isolation/sealing helpers into dispatch and atomic collection, with persisted adjudication effects. Keep the containment in place until end-to-end positive and negative fixtures pass; a real route additionally requires R5. Continue C5 custody completion, C6 ingestion/panels, evidence migration/scale and fresh release validation afterward. Do not substitute provider-authored gate JSON or local research execution for this work.

### 12.3 Historical evidence inspected at earlier slice boundaries

These dated observations are retained as history, not the current-source verification result. Section 12.1 takes precedence, and section 12.2 records the intermediate audit.

- **C6 recorded slice/handoff baseline:** 340/340 unit tests after C6, up from C1's 247/247. C2: 261; C3: 287; C4: 306; C5: 323; C6: 340. C2–C6 entries record typecheck, build, desktop and revision-desktop passing at each boundary. Separate dated C2–C6 unit/typecheck/build logs were not found in app/test-output during this check; these are recorded slice/handoff outcomes, not newly reproduced results. C4's handoff says 20 new tests, while its suite count rises by 19 (287 → 306); that discrepancy remains unresolved.
- **Saved baseline inspected:** [c1-unit-2026-09-08.log](../app/test-output/c1-unit-2026-09-08.log) ends with 247 tests, 247 pass, zero failures/skips/cancellations.
- **Development desktop report inspected:** [desktop-report.json](../app/test-output/desktop-report.json), PASS at 2026-09-09T03:22:12.032Z (September 8 Pacific), packaged false, 18 checks including restore admission lock (V1), no page errors.
- **Revision desktop report inspected:** [revision-desktop-report.json](../app/test-output/revision-desktop-report.json), PASS at 2026-09-09T03:22:17.169Z, packaged false, fixtureOnly true, six checks, no page errors. These are mutable latest-run reports, not immutable per-slice logs.
- **V1 complete:** [v1-desktop-2026-09-08.log](../app/test-output/v1-desktop-2026-09-08.log) records successful desktop checks; [v1-build-2026-09-08.log](../app/test-output/v1-build-2026-09-08.log) and section 5.2 retain build and timestamp evidence. The invalid-backup-path failure and approval-review interruption are historical, not current V1 blockers.
- **Earlier evidence retained:** [r-local-unit-2026-09-08.log](../app/test-output/r-local-unit-2026-09-08.log) is the historical 235/235 run; [r-local-desktop-final-2026-09-08.log](../app/test-output/r-local-desktop-final-2026-09-08.log) preserves the pre-V1 failure. This does not change the separate provider-operation restriction in section 13.
- **Still unverified:** section 8.4 token/latency/quality baseline, current packaged release/native validation, and R5 live-provider acceptance. Local fixtures confer no live sealing, scientific approval or capital-deployment approval.

Documentation check at the C6 boundary: reconciled current R4/V1 and next-item pointers, retained C4–C6 partial status, and marked C7 NOT_STARTED. Inspected saved reports, C1/V1 logs and relevant source/file presence. No application source, schema, provider state or release was changed, and no application tests were rerun. Do not regenerate passing application checks for a documentation-only update.

## 13. Existing cloud fixture — historical evidence, not a new authorization

### Important transport discovery

Running cloud creation with piped stdout failed before submission with:

> Error: --cloud requires an interactive terminal.

The CLI additionally warned that noninteractive invocations could otherwise ignore cloud routing and run locally. Therefore **do not implement cloud creation as ordinary `execFile(..., stdio: pipe)` and assume it is remote. Do not remove `--cloud` to make a test pass.**

The successful attempt used a real terminal/PTY, `--safe-mode`, empty setting sources, `--no-chrome`, and `--cloud` with the fixture prompt. It did not use `--environment`, API keys, local print-mode inference, Remote Control, or teleport.

The installed `--environment <id>` help describes a **self-hosted `ccpool_...` environment**. Do not use it to satisfy the Anthropic-managed requirement.

### Fixture and one created session

Fixture directory:

`C:\Users\louis\Desktop\Codex\quant-team\app\test-output\claude-cloud-spike-SP2mlL\fixture`

Its Git history contains one initial commit and only a small `README.md`. It contains no user research data. The prompt requested reading the README, writing a tiny `proof.json`, replying with its contents, and stopping, without delegation/network/packages/other repositories.

**Created session ID:** `session_01Aj1hpgmeoZLdgYVR9eQ6PB`

**Created session URL:** https://claude.ai/code/session_01Aj1hpgmeoZLdgYVR9eQ6PB

Observed official CLI receipt:

~~~text
Created cloud session: Transport capability fixture
View: https://claude.ai/code/session_01Aj1hpgmeoZLdgYVR9eQ6PB?from=cli&m=0
~~~

**Known:** provider accepted creation and returned a real session ID.

**Unknown:** whether the job ran/completed/failed, whether proof.json exists, its returned bytes, exact applied model/effort, live logs, current environment identity, and cancellation acknowledgement. Never report this as a completed end-to-end assignment.

The in-app browser was signed out of Claude. CLI authentication and browser authentication are separate. Do not copy cookies/tokens out of another application to bypass that.

The next attempted operation was official CLI attachment to this existing session (`--cloud <session-id>`, not `--teleport`). It **did not execute**: automatic approval review rejected the escalation because the review service reported a usage limit. The rejection explicitly prohibited a workaround or indirect bypass. Resume that operation only when the approval mechanism is available and the action is allowed; do not switch execution mechanisms simply to evade the rejection.

Machine-readable investigation notes:

`app/test-output/claude-cloud-spike-SP2mlL/cloud-spike-status.json`

The adjacent `intent.json` and `result.json` describe only the **first failed piped attempt**. They do not describe the successful later terminal submission. Read `cloud-spike-status.json` for the whole sequence.

### Windows sandbox detail, not a product requirement

The fixture was created under a sandbox account. Running Git outside the sandbox initially failed with “dubious ownership” and then “Need a repository to create a bundle.” The successful diagnostic attempt used a **process-scoped** `safe.directory` entry for this exact disposable directory only. No global wildcard trust setting was added. Do not bake this developer-environment workaround into the product.


## 14. Commands, tooling and release protocol

Run from C:/Users/louis/Desktop/Codex/quant-team/app. Use the existing pnpm-managed dependency tree for dependency changes; npm previously failed on that layout and is not on the audited shell PATH. No optimizer/dependency installation is required for this roadmap. Check installed runtime/tool capabilities rather than assuming versions from these notes.

Historical R0 targeted regression command (R0 is complete; rerun only if affected by a new change):

~~~powershell
node --import tsx --test tests/activity-queue.test.ts tests/cooperation.test.ts
node node_modules/typescript/bin/tsc --noEmit
~~~

Current next action is external R5 reconciliation and independently verified provider/harness/custodian provisioning, as specified in section 5.3 and section 12.1. C4–C7 local acceptance is complete. Preserve the fresh validated release and the local/hosted distinction; do not repeat completed local work merely because live evidence is absent. Package replacement for this revision was explicitly authorized by the user and completed.

Audit shell note: `node` and `pnpm` were not on PATH, but standalone Node **v24.19.0** exists at `C:\Program Files\nodejs\node.exe`. The audit used PowerShell `& "C:\Program Files\nodejs\node.exe"` in place of `node` below, with the existing installed dependencies. No installation, PATH/configuration change or Electron-as-Node workaround was needed. The previous claim that no standalone Node exists is historical, not current tooling guidance.

~~~powershell
node --import tsx --test tests/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
node scripts/build.mjs
node --import tsx tests/desktop.e2e.ts
node --import tsx tests/revision.desktop.ts
node --import tsx tests/pipeline.desktop.ts
node scripts/package.mjs
~~~

Then in a fresh shell for packaged checks:

~~~powershell
$env:QRO_EXECUTABLE = Join-Path (Get-Location) 'release\Quant Research Office-win32-x64\Quant Research Office.exe'
node --import tsx tests/desktop.e2e.ts
node --import tsx tests/revision.desktop.ts
node --import tsx tests/pipeline.desktop.ts
node --import tsx tests/packaged-native.desktop.ts
~~~

The pipeline and packaged-native fixtures now exist and are included above. Do not run a proposed filename before implementing it and claim success. Read agents.e2e.ts/live-metadata scripts before use; they are not pure fixtures. Never run Verify transport as an account read. If sandboxed tsx fails at uv_os_get_passwd ENOMEM or native tooling cannot start, distinguish that environment failure from assertion failures and use the normal approved execution route; no workaround for an explicit denial.

Changes to OfficeAPI require shared types, preload, main handler validation and desktop bridge-key assertions together. Persisted schema changes require replay/tamper/recovery tests. Real raw observations enter through trusted adapters only; fake adapter injection is test-internal. Package/native smoke must not invoke research or real providers.

For documentation-only edits, validate Markdown links/anchors, code fences, single source of truth and consistency. Do not rebuild or pretend application tests were rerun. When showing the user the result, link this file and state the next executable item and last actual validation result.

## 15. Source and rationale register

- Prior source audit: 2026-09-08; raw unit log linked in section 12. Findings are source-inspection defects unless explicitly reproduced by that log. Revalidate after implementation changes.
- Token Optimization conversation: task 01a07fcc-7bd4-7b92-87be-d7be92ddbaf0, including later September 8 messages at 10:46–10:53 UTC about repeated source reading, shared developer context and Serena. The task reader returned empty items for those last two turns; their visible user/assistant messages were recovered from the matching local session record. Sections 1.3–1.4 incorporate them. Earlier blanket deferral of navigation plugins is scoped to the product pipeline; a developer trial is now explicit and nonblocking. No hidden reasoning was used.
- Token-optimization report: C:/Users/louis/Desktop/Codex/token-optimization-revision-report.md, dated 2026-09-08. Numeric rankings are conceptual opinions. Section 3 incorporates the accepted decisions; optional named tool maturity/compatibility was not benchmarked.
- User-supplied staged-team comment: evaluated in section 2; its fixed model hierarchy, forced conclusions, universal trading thresholds and shadow-slippage claims are not adopted as facts.
- Technical primary sources are linked next to their supporting rationale in sections 2–3. Financial/statistical methods and provider behavior must be checked against primary documentation when implemented; no source establishes profitability or a guarantee of zero missed findings.

This roadmap is sufficient to continue in another conversation: start at section 1, execute the next open item, update section 11, and preserve evidence. The intended end state is a reliable research controller with traceable evidence and selective context. Capital execution requires a separate, explicitly authorized system.

## 16. Original 0.4 audit — historical appendix

The findings below describe the original September 7 review, not current implementation status. Keep them for traceability. Current status and remaining work are sections 4–5 and 11. Historical line numbers may no longer match source.


Evidence links point to the 0.4 source. Priorities: P0 = required before live dispatch; P1 = next usability/correctness release; P2 = hardening and scale.

| ID | Priority | Finding | Evidence and consequence |
| --- | --- | --- | --- |
| F01 | P1 | Agent name and idle status overlap. | `app/src/renderer/office.css` places the name below an absolutely positioned person and the status in the same vertical region. Existing `agents-office.png` visibly confirms overlap. |
| F02 | P1 | Active and removed agents appear in the same unfiltered list. | `app/src/renderer/office.tsx:24` renders every agent. There is no lifecycle dropdown, search, team filter or pagination. |
| F03 | P1 | Archiving an agent has inconsistent edit rules. | Profile editing rejects removed agents in `app/src/core/store.ts:230`; `setAgentEffort` does not. Reproduced an effort change on a removed agent. |
| F04 | P0 | A child review task determines the parent request's visible status and cancellation target. | `app/src/renderer/office.tsx:20` selects `tasks.at(-1)`. Create → submit review → save revised details leaves the root BLOCKED and the last review CANCELED. The card says canceled and its Cancel button throws “Task is already canceled.” |
| F05 | P1 | Project archive and request cancellation disagree. | `app/src/core/store.ts:219` cancels tasks but does not close research details. Archive → restore → submit succeeds for a canceled investigation. Reproduced. |
| F06 | P0 | Requests have roles but no actual ownership or work mode. | `ResearchTask` in `app/src/shared/types.ts:7` has a role recipient, no agent assignment or run identity. New requests and reviews are hard-coded to DIRECTOR in `store.ts:236` and `store.ts:251`. |
| F07 | P0 | Authenticated profiles are not runnable agents. | `app/src/main/subscriptions.ts:11` allows metadata methods only; confirmation records `HOSTED_SETUP_REQUIRED`. All new tasks are blocked. |
| F08 | P0 | Effort capability checks are partly accurate but not transport-specific. | `app/src/shared/effort.ts` offers a broad OpenAI fallback and guesses Claude capabilities from aliases/regular expressions. `subscriptions.ts:88` reads Codex-supported efforts but drops provider descriptions/default. Neither proves a cloud job will use those settings. |
| F09 | P1 | Projects have no local folder or cloud environment selection. | `Project` in `types.ts:4` contains a name and mandate, not a location. `app/src/main/main.ts` stores everything in application data. Creating a project currently creates a database record only. |
| F10 | P1 | Global project controls do not match queue scope. | Office/Tasks show all projects, while navigation/footer counts use selected project/experiment tasks. Multiple review subtasks can count as multiple requests even when the queue groups them into one card. |
| F11 | P1 | Every request becomes an experiment and a research contract. | `store.ts:233` and the New request form require research-shaped details even for a simple explanation or code review. The old independent `experiment.create` and `task.create` commands still coexist. |
| F12 | P0 | Review/approval architecture is not connected to runtime. | `store.snapshot()` returns `reviews: []`. Strict event schemas permit only a small subset of the stages declared in TypeScript. Review helpers exist in `guards.ts`, but no dispatcher calls them. |
| F13 | P0 | Office cooperation is only a presentation stub. | `OfficeScene` accepts optional activity, but its caller supplies none. “Arrival” is a short translation at the meeting location, not travel from a desk. Historical transcript imports must not trigger live movement. |
| F14 | P1 | Account labels can be mistaken for current connections. | Agents retain the email verified at setup; one installed active credential context per provider is reused. Usage renders a provider-wide card and counts removed profiles too. Switching the native account does not reconnect every stored agent. |
| F15 | P1 | Logs have no project/request/run scope. | `WorkLog` contains conversation and participant IDs but no project or assignment linkage. Current logs are imported evidence or office events, not live work. |
| F16 | P1 | Profile editing lacks revision conflict handling. | `ProfileEditor` uses default-value fields and `agent.update` has no expected revision. Effort has its own separate save path. Closing can discard unsaved profile changes without a clear saved state. |
| F17 | P0 | Displayed “canceled” would be insufficient for a remote job. | Current local cancellation is immediate. Future dispatched work needs cancel-requested and provider-acknowledged states; local process termination cannot establish remote cancellation. |
| F18 | P2 | Unlimited membership does not imply scalable storage/UI. | `store.snapshot()` reads full projections and event history; `workLogs()` reconstructs office events from all events. Log pagination currently limits rendering after loading/filtering everything. Synchronous cloning/compression can stall the main process. |
| F19 | P1 | Export and restore size constraints are not a symmetric contract. | `artifacts.ts:117` suggests a backup when project export exceeds 256 MiB; backup has the same artifact ceiling. Backup preflight counts artifacts, but restore also limits expanded database/manifest bytes and entry counts. A growing log database or many objects can exceed restore acceptance. This is a code-path risk, not a reproduced lost backup. |
| F20 | P1 | Project export omits team and conversation context. | `artifacts.ts:118` exports `agents: []` and no work logs. Project-specific log ownership is needed before exporting conversations without leaking other projects. |
| F21 | P1 | Documentation overstates or describes older behavior. | Root/app READMEs still say 0.3, desk clicking, and in places fixed desk/team assumptions. Architecture 0.3 still contains monetary budgets and a two-worker policy superseded by later revisions. |
| F22 | P1 | Existing tests do not establish scientific or hosted correctness. | All 56 unit tests passed again during this review, while F03–F05 reproduced. Existing packaged checks cover local flows; they do not prove live Claude execution, cross-provider handoffs, activity transitions, cancellation acknowledgement, or exact model/effort application. |

Reproduction evidence: [isolated audit results](../app/test-output/structure-review-reproductions.json). The audit used an in-memory fixture and no user research data or provider prompts. Production source and the packaged application were not changed during this review.

~~~text
Date / item / status: 2026-09-13 / D2 round list-views-001 — Drive-style agent rows, project rows with per-row
  location settings, terminal task removal, merged History+Logs stream / VERIFIED_LOCAL
Problem and resulting behavior: Agents and Projects rendered boxed card grids, the Tasks queue retained terminal
  rows forever, and activity was split between a paged History event view and a separate Logs view. The organizer
  prerequisite (29778ec) added a task.delete command with removedAt tombstones and a QueueEntry.deletable
  projection (terminal status plus no unresolved provider job; records and lineage events retained), and split
  renderer ownership into components.tsx/queue.tsx/projects.tsx plus a HistoryView contract with the Logs nav
  item removed. Worker 1 (359aa44) converted AgentRoster to a header row plus one row per agent with
  right-aligned Profile & logs / Archive-or-Restore controls, retaining the project-card class for the recorded
  revision.desktop.ts DOM contract. Worker 2 (8dd3f65) converted Projects to rows carrying the resolved location,
  experiment count and status badge, with a labelled settings toggle opening one inline panel that shows the
  current folder, a Location input, Choose folder via chooseProjectFolder, and Save dispatching location.save
  with expected revision and passthrough inputPaths/outputFolder; archived rows are read-only. Worker 3
  (801036f) appended a Remove button rendered only when row.deletable is true, dispatching task.delete with
  expectedRevision for request rows. Worker 4 (f2128d6) merged the work-log index into the paged History
  timeline: Subject/Other participant/Record view/Search filters (Subject covers You/Office/Tool/each agent),
  OFFICE_EVENT log projections deduplicated against their underlying events unless a subject is selected,
  deterministic descending-time ordering, and agents.e2e.ts repointed to the renamed controls.
Changed source/test files: app/src/shared/types.ts, app/src/shared/queue.ts, app/src/core/store.ts,
  app/src/renderer/components.tsx (new), app/src/renderer/queue.tsx (new), app/src/renderer/projects.tsx (new),
  app/src/renderer/office.tsx, app/src/renderer/office.css, app/src/renderer/main.tsx,
  app/src/renderer/history.tsx, app/src/renderer/history.css (new), app/src/renderer/styles.css,
  app/tests/task-delete.test.ts (new), app/tests/agents.e2e.ts.
Migration and compatibility impact: request and task records gained an optional removedAt tombstone; deletion
  hides terminal queue rows but retains records, history and lineage events. No schema version bump; IPC surface
  unchanged except the new task.delete command; no dependencies added; archived-project read-only rules
  preserved.
Commands actually run, exit codes and dated log paths: node tools/desktop.mjs review + check + accept per exact
  SHA (359aa44, 8dd3f65, 801036f, f2128d6) onto frozen base 29778ec — all ancestry/scope PASS with clean diffs;
  merges 0d76cec, 83c9bc4, 11d27e6, 485e110. node_modules/.bin/tsc --noEmit — exit 0 after each merge and on the
  combined HEAD. node_modules/.bin/tsx --test --test-concurrency=4 tests/*.test.ts — exit 0, 384/384 on the
  merged tree. node app/scripts/build.mjs — exit 0 (0.5.0). node_modules/.bin/tsx tests/agents.e2e.ts — exit 1,
  attempted and blocked: the pre-existing provider-catalog step "Options read from the provider model catalog."
  timed out at line 29, before any repointed selector; this fixture reuses an installed Codex subscription login
  and this environment does not currently return a model catalog (last PASS was 2026-09-07, packaged mode,
  app/test-output/agents-report.json).
Local fixture evidence versus live provider evidence: all local. No provider session was created, observed or
  cancelled; the desktop fixture failure is a missing local Codex catalog, not a regression in the merged code.
Known unresolved external IDs/operations: the repointed agents.e2e.ts History assertions (line 40) remain
  unexercised until run in a Codex-signed-in environment; provider model-catalog and effort reads stay external.
Remaining defects and exact next item: the History count line totals events plus all logs including OFFICE_EVENT
  rows hidden under the 'all' view; the per-card 'Open folder' shortcut was dropped (the location is visible in
  the row and editable in the settings panel); ProjectsView still accepts unused project/onError props. Next
  item: human review and merge of parallel/prepared-20260912/organizer; workers 5-7 were IDLE this round.
~~~
