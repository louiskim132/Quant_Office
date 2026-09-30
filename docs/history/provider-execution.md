> Historical architecture specification. Current runtime status and superseding constraints: [roadmap status, section 11](../ROADMAP.md#11-execution-checklist-and-progress-record). Fixed-team and API-budget provisions below are not active product defaults.

# Provider execution and control plane — architecture 0.3

All agent cognition and executable work is provider-hosted. The desktop sends requests, validates envelopes and routes files. An API capable of returning code is not sufficient: executable tasks require a verified hosted execution capability.

## Adapter contract

| Operation | Required behavior |
| --- | --- |
| inspectCapabilities | Resolve requested model/account access and separate inference, hosted execution, packages, file transfer, network restrictions, cancellation and usage capabilities |
| prepareInputs | Transfer only permitted immutable files; return provider file IDs mapped to original hashes |
| submit | Send scoped task, model, tool policy, budget/deadline and idempotency identity; record provider request/session ID |
| streamOrPoll | Normalize provider events without treating text as execution evidence |
| retrieveStatus | Reconcile a known job after reconnect or ambiguous submission |
| cancel | Request cancellation; distinguish requested from acknowledged/stopped |
| exportArtifacts | Retrieve declared outputs before expiry; verify byte hashes and expected inventory |
| retrieveUsage | Return actual usage with source and unresolved fields; never invent prices |
| closeContext | Retire scoped context and credentials according to retention policy after artifacts are durable |

These are internal interfaces, not claims that both provider APIs expose identical endpoints. Each adapter documents which operations are supported and how they map to provider responses. A capability missing from one service remains visible rather than being simulated as success.

## OpenAI path

Use the official Responses API for role requests, with an OpenAI-hosted shell/container option for executable tasks. Explicitly require hosted execution; a client/local shell tool is not an admissible substitute. OpenAI documentation distinguishes hosted container execution from local execution arrangements. [OpenAI shell guide](https://developers.openai.com/api/docs/guides/tools-shell)

Preserve the requested GPT-6 Astra and GPT-5.6 Sol role targets. Resolve the exact supported model identifiers and tool compatibility at setup. The adapter persists actual model, request, tool call, environment and artifact IDs. Provider event receipts establish that a hosted tool call ran; acceptance still requires its correct inputs, check definition and outputs.

## Anthropic path

For general coding work, prefer a verified Anthropic-managed cloud sandbox through Managed Agents. Its environment can be cloud-managed or self-hosted; only the Anthropic-managed option fits this architecture. Persist its agent/environment/session and event identities. [Anthropic Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)

The Messages API with server-side code execution is another capability profile for compatible bounded analysis. Current documentation describes server-side execution with restricted networking and preinstalled packages; do not assume it can install an arbitrary ML library. Capability profiles must remain distinct. [Anthropic code execution](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)

Preserve Claude Opus 5 as PM-B/PM-C's requested target. Hosted execution access, actual package availability and selected tool versions must be probed for this account. A successful inference response cannot satisfy the execution probe.

## Capability and environment verification

Each configured profile records requested/resolved model, API/harness/tool versions, provider-owned execution location, filesystem scope, dependencies, CPU/GPU/memory/time limits, network policy, file export limits/expiry, cancellation semantics, metering, maximum enforceable charge and probe job evidence. Check actual installed dependencies by a bounded hosted probe; cached documentation is not execution evidence.

Executable work can dispatch only when its required capability subset is satisfied and sufficiently current. A changed environment/package/tool identity invalidates affected cached verification. If a provider environment exports transformed files, hash the downloaded artifact and record its transformation provenance separately from the original in-container hash.

If a runtime lacks a dependency:
1. Select a compatible, already approved profile on the same provider when available.
2. Otherwise propose a bounded execution worker on the other approved provider under the same PM. This does not change the PM model or compromise its separate review context.
3. If neither provider can execute the required check, record BLOCKED_CAPABILITY. Deliver a limited package only with that limitation explicit; do not certify the unexecuted check.

There is no local, Colab, self-hosted VM or arbitrary third-party runtime fallback. Preparing a source package for the user does not clear a blocked agent verification gate.

## Tool and network boundaries

Provider models receive only approved hosted tools and small controller tools for bounded task proposals, scoped artifact retrieval, report submission and escalation. Controller tools accept structured data and check dispatched identity and permissions. They cannot accept a shell command or arbitrary URL and run/fetch it locally.

A research retrieval task may use approved provider-hosted search with bounded source scope. Code execution uses a task-specific network allowlist for authorized source/dependency resources. No browser/desktop automation tool, Colab credential, Colab control endpoint, live notebook link or remote Jupyter connection is exposed. Provider network enforcement must be verified; a prompt prohibition alone is not sufficient. Do not enable an unrestricted tool configuration that cannot enforce the user's Colab boundary.

Artifacts are transferred through controller-issued object IDs; an agent cannot choose a path on the user's machine. Git/Drive credentials belong to the controller's scoped storage adapter, not the model. The artifact archive has no live Colab file links. Input data permission is per project, including explicit cross-provider transfer scope.

Before prepareInputs, every artifact grant must bind its content hash, allowed purpose/role, region/partition classification and exposure lineage. A filename or an overall project permission is insufficient. A file mixing permitted and protected observations, an unclassified file, or a derived report/model whose lineage includes protected observations is unavailable to ordinary research contexts. Require user-prepared physically separated allowed partitions or partitioning in a separately authorized provider-hosted data-preparation job before grant. The desktop performs no scientific filtering.

Access to a protected partition, including a data-preparation job that must read it, requires a recorded user decision bound to contract, exact region/artifacts, recipient and purpose, plus a durable exposure event before transfer. No model or ordinary UI shortcut can grant this access. If permission changes the scientific use of the holdout, freeze a new contract and invalidate affected approvals. Mixed/unknown provenance remains blocked until resolved; checks rely on recorded provenance and specified validation, not a claim to detect every deliberately mislabeled input.

## Submission and retry lifecycle

Task states are QUEUED → RESERVED → SUBMITTING → RUNNING → OUTPUT_RECEIVED → ACCEPTANCE_REVIEW → ACCEPTED. Branches include SUBMISSION_UNKNOWN, TIMED_OUT, CANCEL_REQUESTED, CANCELED, EXECUTION_FAILED, BLOCKED_CAPABILITY and REPAIR_REQUIRED. Provider success and task acceptance are different states.

Persist the submission intent, budget reservation, input hash and idempotency key before the outbound request. Bind the returned provider ID immediately. If a response is lost, reconcile using supported provider identifiers/idempotency. If the API cannot prove whether the job exists, hold SUBMISSION_UNKNOWN for resolution; do not blindly resubmit or release the spending reservation.

Bound transport retries separately from repairs. Honor provider rate limits and use backoff with a configured maximum attempt count and deadline. Schema-invalid model output consumes its original usage; any correction is another recorded bounded invocation. Interrupted useful outputs are retained as partial artifacts, never silently discarded or accepted.

## Budgets and capacity

Before a call, atomically reserve its maximum enforceable financial liability and a worker slot where required. For every task, experiment, project and global ceiling, require reconciled spend plus all outstanding liability reservations plus the new reservation to be at most that ceiling. Include input/output tokens, hosted tools/runtime, permitted nested work and applicable export/other charges. An estimate is shown for planning but never substitutes for this reservation.

Bind each reservation to the provider-enforced limits and pricing/cap evidence used to establish its upper bound. Unknown unit prices are tolerable only when a verified all-in provider currency cap still bounds total liability; otherwise hard-ceiling dispatch is blocked. The initial product uses hard spending ceilings. No user budget is silently downgraded to a best-effort estimate. Consumer subscriptions are not assumed to cover API usage.

Reconcile actual charges against a reservation atomically and release only proven unused liability. A streaming usage observation moves value between actual-spend and outstanding-reservation fields without double counting; unknown or delayed charges remain reserved. Concurrent jobs cannot overcommit a shared ceiling even when their planning estimates are small.

Two worker tasks can run concurrently across all projects. Each executable subtask and nested worker must be registered. Context compaction, review/rebuttal calls and artifact-export charges are included when applicable. A provider harness must have bounded delegation, turns, elapsed time and spend before dispatch; otherwise the controller cannot promise a hard ceiling while disconnected.

No inference, reminder prompts or polling agents are scheduled for an experiment waiting on the user's external run. UI animation is local and free of model calls. Other independently authorized projects can continue while the application is open.

## Expiry and recovery

Export completed and useful partial files before sandbox expiry. Record immutable source/evidence in authoritative storage; provider containers are temporary workspaces. Never reuse a verifier's environment for implementation or another project's hidden review context.

On reconnect, reconcile jobs by persisted provider IDs, finalize exports, compare receipts and actual spend, release reservations only when safe, and then consider new work. A provider timeout, app crash, sandbox expiry and a scientific failure are different events. Preserve enough metadata to explain which occurred.

## Release prerequisites

Real adapter probes, remote package/test execution, file export, cancellation and usage reconciliation must pass before the team is described as operational. The Windows desktop build also needs a verified hosted build profile capable of producing the intended installer; the existence of inference or Linux research execution is not proof of that capability. Normal user-operated desktop acceptance is UI execution, not permission for agent-authored local commands.

No account access, compatible build environment or real provider task has been verified in this design session. The architecture fixes the allowed choices; setup must establish which requested profiles are usable.
