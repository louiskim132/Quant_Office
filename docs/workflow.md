> Historical architecture specification. Current runtime status and superseding constraints: [readiness matrix](../app/docs/readiness.md). Fixed-team and API-budget provisions below are not active product defaults.

# Research workflow and external handoff — architecture 0.3

The team develops and verifies research packages using OpenAI/Anthropic-hosted environments. Colab is outside the system. All references to an external run below mean an activity performed independently by the user, with no agent/controller access.

## Research stages

The original staged protocol is retained, with waiting stages named for the user rather than a Colab connection.

| From → to | Gate and event |
| --- | --- |
| DRAFT → CONTRACT_REVIEW | Draft project hypothesis, claim scope, selected evidence and required policy questions recorded |
| CONTRACT_REVIEW → CONTRACT_FROZEN | Director decision on exact resolved contract within user goals/budget; required facts resolved for that scope |
| CONTRACT_FROZEN → IMPLEMENTING | Approved task contracts, provider capability, tools, budget and input identities |
| IMPLEMENTING → REMOTE_VERIFIED | Hosted execution evidence and independent A/B round accepted; required defects resolved |
| REMOTE_VERIFIED → PREFLIGHT_READY | Reviewed metadata-only package with exact source/config/data/test/environment/launcher identities and expected outputs |
| PREFLIGHT_READY → WAITING_FOR_USER_PREFLIGHT | User exports package; controller records a handoff, not an executor job |
| WAITING_FOR_USER_PREFLIGHT → PREFLIGHT_REVIEW | User explicitly imports returned files and initial metadata/identity checks accept the handoff; enter CONTENT_VALIDATION_PENDING before any hosted validation dispatch |
| PREFLIGHT_REVIEW → RUN_APPROVED | Required hosted content validation and preflight gates passed; applicable scientific/economic policies resolved; smoke prerequisite satisfied; Director approval binds full-run package and declared schedule |
| RUN_APPROVED → WAITING_FOR_USER_RUN | User exports approved finalized package; no command is sent to any external runtime |
| WAITING_FOR_USER_RUN → RESULT_VALIDATION | User supplies output files with the expected package/run identity and terminal manifest |
| RESULT_VALIDATION → INDEPENDENT_ANALYSIS | Content identities, completeness, remote schema/scientific validation and required checks accepted for the claim |
| INDEPENDENT_ANALYSIS → DIRECTOR_DECISION | Independent C/D first reports and allowed rebuttals finalized; decision packet complete |

The initial package can target preflight only while an economic decision remains open. Its scope prohibits cost-dependent feasibility/full-run approval. The frozen metadata contract is distinct from an unresolved full research contract.

A hosted smoke test belongs to REMOTE_VERIFIED when the provider can support the declared bounded workload. A user-run smoke may be a separate external handoff under its own engineering approval. Reduced data/folds/seeds are explicit and never silently substituted for the full research schedule.

The full-run smoke prerequisite must be satisfied by one of two declared paths: (1) accepted smoke evidence binding the same scientific source, checks, configuration and required environment, with only explicitly declared reduced-workload differences; or (2) a reviewed full-run launcher that mechanically enforces smoke acceptance before any expensive stage and writes the smoke evidence into its result bundle. The second path approves a conditionally gated package, not an already successful smoke. Contract-level inapplicability is permitted only when the specified task has no expensive research stage and the reason was frozen before evaluation. Any other relevant dependency change requires renewed smoke evidence/review.

PREFLIGHT_REVIEW cannot advance while content validation is pending, failed or inconclusive for a required gate. Explicit import ends the waiting state first, allowing its bounded hosted validation without violating the zero-model-call rule while waiting for the user. Rejected/incomplete initial imports append a reason and leave the experiment waiting; they do not launch analysis.

All stages can enter a named BLOCKED or FAILED branch with original stage, cause, actor, evidence, time and reopening condition. Retrying creates a linked attempt. Contract changes create a new version and invalidate dependent approval. A new research direction creates a child experiment; it does not rewrite the previous outcome.

## Separate status dimensions

| Dimension | Values and meaning |
| --- | --- |
| Workflow | Current stage and next authorized action |
| Execution | Not started, running, incomplete, completed, execution failed, canceled, unknown |
| Validity | Not evaluated, valid, invalid, inconclusive |
| Scientific finding | Criteria met, criteria not met, or no finding; trading projects may label a valid negative VALID_NO_EDGE |
| Engineering acceptance | Not complete or PILOT_COMPLETE |
| Advancement | Not considered, blocked, candidate, revised or retired under frozen rules |

BLOCKED_DATA and BLOCKED_POLICY identify missing inputs. INVALID identifies a failed validity gate. INCONCLUSIVE identifies insufficient evidence/sample size/detector power. EXECUTION_FAILED is not a null result. PILOT_COMPLETE alone cannot authorize promotion or protected-data access. CANDIDATE_FOR_NEXT_STAGE requires valid evidence satisfying the separate advancement contract.

## Exact export contents

An export contains a finalized payload archive and a detached release envelope. The payload contains source, dependency lock, fixed launcher/notebook as a static file, configuration, frozen contract, data manifest, approved schedule/mode, seeds where relevant, check definitions, expected artifact schemas, inventory and user instructions. The detached envelope contains the payload byte hash and approval/verification references. Export no API credentials, remote session IDs that grant access, live links or callback configuration.

The manifest binds project, experiment, handoff and intended external-run IDs plus every material hash. Finalize payload bytes before creating their approval and detached envelope; an inventory does not hash itself or its enclosing archive. A convenience outer ZIP can carry both files, with its hash recorded only in the transfer receipt. Package construction is reproducible; if the approved payload hash changes, revalidate its contents and affected approvals. Source identity is an exact commit/archive, never a mutable branch name.

The desktop copies/archives files and hashes bytes without executing them. The user independently obtains data, opens Colab, uploads/selects the package and runs it. The team does not perform or observe those actions. A user-run launcher may perform its own cheap package/data checks and produce structured logs; it contains no agent API calls, team callback, monitoring endpoint or remote-control listener. All paths are explicit user configuration.

The app offers static instructions and Export/Import buttons only. There is no Colab browser opener, login, API client, runtime provisioner, poller, remote notebook editor or access to files attached to a live Colab instance. Agents cannot use generic browser/network tools to bypass this rule.

## Returned results and trust

1. The user selects a file/archive using a native file picker. Import creates a USER_IMPORT receipt with package identity and the user's reported run metadata. A URL pointing into Colab is not accepted as a live result source.
2. Stream the upload into quarantine. Verify size limits, safe names, exact hashes, record schemas, expected inventory, terminal marker and project/experiment/handoff match. Duplicate identical imports return the original receipt; mismatches stay quarantined with a named reason.
3. Send only authorized copied artifacts to a provider-hosted verifier for parsing and scientific checks. The local app does not deserialize models, compute statistics or execute the returned code. Verify keys/counts, actual schedule, coverage and hard-check results against the approved schema/contract there.
4. Keep provenance explicit: external execution is USER_ATTESTED, byte identity may be CONTENT_VERIFIED, and calculations independently rebuilt on provider infrastructure may be PROVIDER_RECONSTRUCTED. These statuses do not erase the original user-import provenance.
5. Where the claim requires reproduction that cannot be performed on allowed provider resources, record missing evidence and narrow/block the claim. Do not fabricate a provider receipt for the external run. A genuine negative finding requires valid, complete evidence under the frozen contract.
6. Freeze the accepted evidence bundle and dispatch independent C/D analysis. Both roles see the same data and limitations. A later amended input triggers a new bundle/review round.

The result archive should contain terminal manifest, raw logs, data-integrity report, actual environment/versions/hardware, schedule, keys/counts, metrics, predictions or other contract-defined outputs, relevant cost decomposition, checkpoints and model files where required. Save expected files first and terminal manifest last. Interrupted output is incomplete even if some files look final.

## Protection of research validity

Required structural checks are explicit runtime exceptions before expensive work. A detector's insufficient power is not a clean pass. Expensive research includes more than ML fits: simulation, optimization and full evaluation can also require gates.

Resume uses content-addressed stage keys and verifies output inventory and hashes. Mutating source, fee/data policy, data bytes, target, features, dates, folds, tests, environment or launcher invalidates affected stages. Never reuse a partial/mismatched output because a filename or arm name matches.

Chronological derivations, forward label horizons, gaps, units, measured-versus-assumed inputs, multiplicity and economic uncertainty are governed by each experiment. Diagnostic exposure is recorded before use; observations influencing a later choice create a new research version. Protected holdout regions are project-specific and cannot be unlocked by a model or UI shortcut.

Artifact grants enforce those regions before provider transfer, including derived reports and models. Unclassified or mixed protected/allowed files are not ordinary agent inputs. Any necessary protected-data preparation/access needs a specific user decision and durable pre-transfer exposure record; changed scientific use requires a new contract. Only authorized provider computation or user preparation can partition data, never the local controller.

## Local CLI agents

The office can also assign bounded office labor — notes, file passes, draft text and scoped edits — to an agent that runs in the user's own installed CLI on this machine. Local agents are an additional surface for office work only. Model training, evaluation, backtests and every other research computation stay in the manual Colab flow above; a local session never runs them and is never a substitute for the user's run.

### Adding a local agent

Add Agent can create a Devin, Claude Code or Codex agent whose execution environment is LOCAL. Setup uses only the official installed tool signed in to the user's own subscription: Devin is probed through `devin auth status` and `devin models list --format json`, Codex through its app-server account and model endpoints, and Claude Code through `claude auth status` with the curated alias list — an alias is built into the application and is not an entitlement check for the account. No API key is accepted: the child environment is stripped of provider credential variables and there is no API-key fallback.

When the official tool is not signed in, the app opens a visible terminal running that tool's own login — for Devin, `devin auth login` — and re-checks status afterward; the same command can be run manually in any terminal. The Devin CLI credential is separate from the signed-in Devin Desktop session: signing in to the desktop app does not sign in the CLI, and the office checks only the CLI. The Devin model catalog is read from `devin models list --format json` once the CLI is signed in; there is no provisional suggestion list before that.

**Never launch the office itself from an agent terminal.** Provider CLIs read their environment when they resolve credentials: a CLI spawned under an agent-protocol environment — one carrying `ACP_BACKEND` or other `ACP_*` variables, as happens when the office process is started from inside a coding agent's terminal — can falsely report a signed-out account even though the tool is signed in. The office strips `ACP_*` variables from the environment of every child process it spawns, alongside the provider credential variables it already removes, but it cannot repair the environment it was itself launched under. Start the app from an ordinary desktop or shell session; if a signed-in tool reports signed-out inside the app, suspect the launch environment before re-authenticating.

Devin encodes effort in the model variant rather than a separate effort axis — `swe-2-max` is the max-effort variant, `swe-2-high` a lower one — so the variant is chosen in the Model field and the separate effort field stays at Provider default unless a catalog entry explicitly declares real effort levels.

Two fields beyond provider, model and team describe how a local agent is configured:

- **Execution environment** — HOSTED_SETUP_REQUIRED or LOCAL. Records created before this field existed are labeled HOSTED_SETUP_REQUIRED. The environment is part of the readiness scope: evidence observed under one environment never satisfies the other, and a local agent never silently falls back to a hosted route or vice versa.
- **Tool profile** — STANDARD or CODE_NAV, the office-side declaration of the tool surface the session is configured for. A recorded profile is configuration, not proof the session ran under it.

A saved local profile is never proof that the runtime exists. Signing in is not proof a local session can run: readiness requires office-observed LOCAL_* evidence for the scope's actual route, and a route with no configured local adapter fails closed rather than dispatching through another surface.

### Preparing a local request

A local session sees only what the office stages for it, and staging starts from the project's recorded location:

- The project folder is chosen through the system's folder dialog; the field in the project form is read-only and not free-typed, and saving revalidates that the path is absolute and an existing directory. Choosing a folder never uploads, indexes or reads its contents — it is recorded for provenance and file selection only, and the office database stays in application data.
- Saving a project location creates a managed `inputs/` directory inside the chosen folder so the user can see where shared files belong. Membership in that directory shares nothing by itself; files are shared only through explicit selection.
- Input files are chosen through the wired file picker rooted at the project folder. Selections are validated in the main process before they can become a saved allowlist: every path must resolve inside the project folder and is recorded relative to it, up to 200 files per pick, and credential/tool-configuration paths and the office's reserved `_office/` bookkeeping names are refused.
- Preparing the request snapshots the selected files into office-owned staging: each file is copied, hashed and inventoried, generated bookkeeping lands under `_office/` (a README naming the staged set and a manifest listing every byte), and the snapshot can be rebuilt from stored workspace bytes after a restore — the source folder is never reread.

### Delivering work locally

The readiness model names three local routes — LOCAL_MAILBOX, LOCAL_CLI_EXEC and LOCAL_ACP — but only the mailbox has a transport adapter in this build; a scope bound to an unwired route fails closed rather than falling back to another surface. The mailbox transport works as follows:

1. The office writes a scoped packet directory under a workspace-local sessions root: `packet.json` plus the session's result contract, and the declared input files copied from the snapshot staging path under `inputs/`, each hashed. The packet directory is the session's external identity.
2. The user runs the local session against that directory in the official tool.
3. The session writes `result.json` plus its declared artifact files. The receipt must carry exactly `state`, `detail` and `outputs` — each output naming its path, sha256 and byte count — and may additionally self-report `appliedModel`, `appliedEffort` and `delegation`.
4. The office reads the directory back, verifies every declared sha256 and byte count against the bytes on disk and reports the outputs through the normal inventory. Undeclared or mismatched files are not results, and a missing, oversized, malformed or hash-mismatched receipt is an office-local UNKNOWN reading — never a session report.

Each step records only what the office itself did, as office-observed evidence:

- Writing the packet records LOCAL_SUBMIT, TOOL_CONFINEMENT (the scoped workspace delivery) and DELEGATION_CONTROL (the packet carries the frozen single-agent payload; the mailbox has no delegation channel), and the job is left UNKNOWN awaiting a session — a written packet is not an acceptance, and the office does not record one it did not observe.
- Reading a fully verified `result.json` records LOCAL_OBSERVE plus LOCAL_OUTPUT_FETCH for the verified output inventory, and records MODEL_APPLICATION, EFFORT_APPLICATION or DELEGATION_CONTROL only for the self-report fields the receipt actually declared — an absent field stays absent.
- Cancellation writes a `cancel.requested` sentinel in the packet directory and records LOCAL_CANCEL once that sentinel is on disk: ending the session is a real cancellation of that local session, honestly labeled — it is not a provider cancellation acknowledgement, and no provider-side job exists to acknowledge.

The recorded route and packet identity are the durable facts, so a restart cannot duplicate a dispatch.

### What the request view shows

Start request records readiness blockers in two groups. Blockers that fail the manual step in front of the user — no account check, an unsigned-in tool, a missing capability snapshot, a stale check — stop that action. Blockers that only gate automatic start — unverified model application, or missing dispatch-family evidence for this scope — leave preparation and the packet write available, because writing a packet records the office's own first local evidence rather than claiming capability. A hosted-transport warning appears only when a selected participant could actually reach a hosted route; an all-local selection records no cloud-transport blocker.

Account checks go stale on the office's own clock, not a provider guarantee: five minutes for hosted scopes, thirty minutes for local scopes, because the manual packet/handoff flow spans more wall-clock than a hosted dispatch. A stale check blocks external action until the account is rechecked; staleness is a freshness rule, never a claim the account signed out.

Local-route errors describe only what the office found. A missing session directory or missing `result.json` reads as UNKNOWN awaiting a session — silence is never reported as a failed or completed job — and a malformed, oversized or hash-mismatched receipt names its defect rather than guessing at a session report.

### What local evidence establishes

Local evidence is office-observed: the office itself wrote, spawned, read or terminated, so it is recorded as OBSERVED evidence at TOOL_SUPPORTED level — never ACCOUNT_VERIFIED provider attestation. Because the office is the observing authority on a local route, that TOOL_SUPPORTED/OBSERVED evidence is what a local readiness scope requires; hosted scopes still require provider-side ACCOUNT_VERIFIED attestation. The local and hosted families share no operations, so neither can ever satisfy the other. The labels mean only what they say:

- Scoped workspace delivery, recorded under TOOL_CONFINEMENT, is not enforced isolation, sandboxing or blinding.
- A model, effort or delegation setting reported by a local session is self-report unless the tool's own output verifies it.
- A local cancel ends that local session; it is not a provider acknowledgement.
- No usage or allowance accounting exists for local sessions; the Devin CLI reports no usage windows to this application.

Because scoped delivery is not isolation, local agents are ineligible for blinded-review, holdout-custody and independently-verified-gate roles unless enforced isolation is separately verified. Label definitions: [evidence.md](evidence.md).

## Worked generic cycle

A user asks for a volatility forecasting study. The Director drafts a claim and comparison; C proposes metrics and uncertainty, D proposes falsification, A plans code and B checks acceptance coverage. After contract freeze, workers produce and verify bounded code on provider infrastructure. A/B positions persist; the Director approves the package.

The user exports it, independently runs it in Colab and later imports outputs. The desktop validates metadata, hosted verification checks the copied outputs, and C/D independently assess findings. A valid negative result is preserved as a useful research finding. The Director may retire the hypothesis or propose a newly versioned experiment. No step calls or observes Colab through an agent tool.
