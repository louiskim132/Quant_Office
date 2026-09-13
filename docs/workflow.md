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

## Worked generic cycle

A user asks for a volatility forecasting study. The Director drafts a claim and comparison; C proposes metrics and uncertainty, D proposes falsification, A plans code and B checks acceptance coverage. After contract freeze, workers produce and verify bounded code on provider infrastructure. A/B positions persist; the Director approves the package.

The user exports it, independently runs it in Colab and later imports outputs. The desktop validates metadata, hosted verification checks the copied outputs, and C/D independently assess findings. A valid negative result is preserved as a useful research finding. The Director may retire the hypothesis or propose a newly versioned experiment. No step calls or observes Colab through an agent tool.
