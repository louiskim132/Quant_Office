> Historical architecture specification. Current runtime status and superseding constraints: [roadmap status, section 11](../ROADMAP.md#11-execution-checklist-and-progress-record). Fixed-team and API-budget provisions below are not active product defaults.

# Records, identity and desktop commands — architecture 0.3

These are implementation-ready record specifications, not yet executable schemas. All record schemas are versioned, reject unknown required versions and extra fields, and distinguish draft incompleteness from frozen validity. Platform settings, project drafts, scientific contracts and verified results are different record types.

## 1. Common envelope and canonical identity

Each domain record has schema_version, record_type, record_id, scope (platform/project/experiment/task), the applicable IDs, created_at in UTC, authenticated actor identity, payload, and optional parent/supersedes references. A stored record has a separate SHA-256 digest over its canonical envelope; the digest is not part of its own input.

Canonical metadata format v1:

- UTF-8 JSON without a byte-order mark, whitespace or trailing newline.
- Unique ASCII field names sorted lexicographically at every object depth; array order is preserved.
- Integer numbers only, from -9007199254740991 through 9007199254740991; serialize in base 10 without exponent, leading zeros or plus sign, and normalize negative zero to 0. Scientific quantities, prices, money and non-integer policy values are explicit decimal strings with declared units.
- Enclose strings in double quotes; escape a quote or reverse solidus with a preceding reverse solidus. Encode every control character U+0000 through U+001F as a six-character JSON Unicode escape with lowercase hexadecimal digits, even where a short escape exists. Emit all other Unicode scalar values literally as UTF-8, including forward slash and U+2028/U+2029. Preserve code points without normalization. Reject invalid Unicode, duplicate keys, NaN and infinity.
- Explicit null for known absence; missing fields and empty arrays follow the individual schema and are not silently equivalent.
- Golden cross-runtime vectors are required before accepting hashes from different implementations.

Files and archives use hashes of their actual bytes. Remote URLs/provider file IDs are separate locators, not content identities. The active configuration pins schema and canonicalization versions. A schema migration appends a new record and link; it cannot overwrite the source of an existing approval.

Release identity is acyclic. First finalize a payload archive containing source, configuration, static launcher, dependency lock, contract, tests and an inventory of payload files. That internal inventory excludes itself and contains no hash of its enclosing archive. Hash the finalized payload bytes, then create a detached ReleaseEnvelope containing that hash, BundleIdentity and applicable approval/verification references. The approval binds the finalized payload; it is never placed inside the payload it approves. If a convenience download ZIP contains the payload and envelope, its outer byte hash is recorded afterward in the transfer receipt and is not a scientific approval dependency.

## 2. Core records

| Record | Required payload |
| --- | --- |
| Project | User mandate, owner, goals, priorities, claim scope, resource limits, storage namespace and parent research lineage |
| ResearchContract | Version/branch/parent; hypothesis and output meaning; selection/exclusion rules; targets and horizons where relevant; model families/baselines/arms; features; evaluation/metric/statistical/uncertainty policy; economics applicability; derivation/evaluation/protected regions; exposure; hard gates; budgets and unresolved facts |
| DataManifest | Frozen dataset version; explicit files/partitions and content hashes; schema, units, row/key counts, population/asset selection; timing/timezone/coverage when relevant; region/access classification, provenance, historical metadata and justified exclusions |
| ScientificPolicy | Version/type, applicability and rationale, assumptions, metric/multiplicity/power rules, relevant time regions, uncertainty, required checks and advancement criteria |
| CostPolicy | When claim-relevant: venue/instrument/order/account/tier assumptions, fees per side with sources/effective dates, spread definition/units, derivation versus diagnostic regions, tick schedule/provenance, coverage requirements, scenarios, included/excluded components and decision rule |
| ResearchPackage | Source/archive/commit identity, interface version, entry-point descriptors, modes, dependency/environment lock, input/result schemas, check definitions and resource requirements |
| TaskContract | Exact inputs, project/experiment/task/supervising PM, objective, allowed artifacts/files/tools/network destinations, output schema, acceptance checks, deadline, token/runtime/currency budget, repair/retry limits and escalation |
| ReviewReport | Role/context/round, frozen input bundle hash, verdict, claims, evidence, executed checks, concrete severity-tagged objections, tested/untested scope, uncertainty, requested action and optional rebuttal-to reference |
| RunManifest | Origin and run/handoff IDs; contract/source/config/data/test/environment/package/launcher hashes; actual versions/hardware; seeds and actual schedule; start/end; execution/validity/finding/engineering/advancement dimensions; artifacts/checkpoints and terminal completeness |
| LineageEvent | Sequence/event/previous-event hash; actor/scope; command and input/output identities; original positions, decisions and reasons; evidence/exposures; supersession/invalidation references; reopening condition; estimated/actual usage and cost |

Additional domain records: RoleDefinition, ProviderProfile, CapabilityProbe, RoleInvocation, BudgetReservation, UsageReceipt, OpenFact, ArtifactInventory, ArtifactGrant, ExposureEvent, EvidenceClaim, CheckResult, ReviewRound, Approval, Invalidation, ReleaseEnvelope, UserHandoff, UserImport and SnapshotReceipt.

## 3. Project-specific scientific fields

Every applicable field must be resolved before its contract is frozen. Applicability is a typed decision with rationale and reviewer, not an omitted field. A non-trading claim can mark trading economics inapplicable before evaluation. A required field cannot become inapplicable after it fails without a new contract/version and invalidation.

Data presence distinguishes ABSENT_COLUMN, PRESENT_NO_VALID_ROWS and PRESENT_VALID_ROWS with counts. Schemas also distinguish genuinely optional diagnostics from required active-policy inputs. Units are named; for market costs use spread_fraction, spread_bps and fee_per_side_fraction with 1 bp = 0.0001 fractional return. A tested display layer renders units without performing scientific derivations locally.

No schema requires CatBoost, approximately 10 assets, barrier labels, a universal spread estimator or a fixed holdout date. Imported example-specific facts stay under that example's namespace.

ArtifactGrant binds exact bytes/partition, purpose, role/context, contract and region classification to permitted disclosure. Derived artifacts inherit restrictive exposure classification from their inputs unless an explicitly reviewed transformation establishes a permissible output. Mixed/unclassified inputs cannot be transferred under a general project grant. Protected-data access records a specific user decision and ExposureEvent before transfer; the actor receiving permission cannot authorize its own access.

## 4. Evidence and execution origins

An EvidenceClaim has statement, evidence_class, artifact/calculation references, generating procedure, limitations and exposure links. Classes: CODE_OBSERVED, SYNTHETIC_REPRODUCED, DATA_MEASURED, RUN_MEASURED, USER_REPORTED and ASSUMPTION. These classes are separate from verification strength.

A ProviderJobReceipt contains the registered task/attempt, actual provider/request/tool/runtime identities, exact input bundle, timestamps, normalized execution status, raw provider-event references, exports and usage. Its origin must be obtained through the adapter, not supplied as model prose.

A UserHandoff records a reviewed archive exported for the user's independent work. It has no provider runtime or remote session. A UserImport links user-selected returned files to that handoff and records user-asserted run metadata. It is never automatically converted to a ProviderJobReceipt.

Verification strength can be USER_ATTESTED, CONTENT_VERIFIED, PROVIDER_EXECUTED or PROVIDER_RECONSTRUCTED. Preserve both origin and verification history. Reconstructing a result on provider infrastructure creates a new job/evidence link; it does not rewrite the imported run's origin.

A CheckResult binds definition/hash, input identity, class (STRUCTURAL, DETECTOR or POLICY), status (PASS, FAIL, INCONCLUSIVE, BLOCKED or NOT_RUN), executor evidence, measurements and limitations. A schema-valid PASS message alone cannot satisfy an execution gate. NOT_APPLICABLE belongs to the frozen check-selection policy; it is not an after-the-fact PASS alternative.

## 5. Bundle and approval

BundleIdentity v1 binds project and experiment, ResearchContract, ResearchPackage descriptor/source/archive, DataManifest, configuration, all required check definitions/result schemas, environment lock, static launcher if present, mode and schedule. Verification approvals additionally bind actual environment receipt, result inventory and review reports.

Approval fields include purpose (contract/preflight/smoke/full run/release/advancement), exact dependencies, authenticated decision actor, decision event, scope and timestamp. Its current validity is derived from append-only invalidations. A model may propose a Director decision only through the role invocation authorized for that purpose. User-owned budget/scope changes require user action.

A proposed decision is rejected if dependent evidence is absent, stale, mock-only, from another project/experiment, or fails required gates. Identical content in two projects does not make their approvals interchangeable. New data downloads do not modify an active experiment.

A changed material dependency invalidates the affected approval graph conservatively. Stage-specific cache optimization may be added later after dependency mapping has acceptance coverage.

Full-run Approval additionally binds its smoke policy: accepted compatible smoke evidence, or the reviewed launcher/check identity enforcing smoke-before-expensive-work. Record which path applies; a conditional package approval is not evidence that smoke has passed. Predeclared no-expensive-stage inapplicability requires its own frozen rationale.

## 6. Database and artifact storage

| Table/group | Key invariants |
| --- | --- |
| events | Append-only sequence, prior hash, actor/scope, unique command ID and payload hash |
| projects / experiments | Ownership, current stage/revision and budget; projections derived from events |
| records / record_dependencies | Immutable canonical bytes and dependency graph by hash |
| tasks / attempts / invocations | Supervisor, role identity, scoped context, leases and provider IDs |
| provider_profiles / capability_probes | Requested and actual capabilities with expiry and execution evidence |
| artifacts / inventories | Content hash, origin, expected count/schema, locator and staging/complete/quarantine state |
| handoffs / imports | User-mediated export/import provenance; no external runtime session handles |
| review_rounds / reports | Exact bundle, required participants, independent submission commitments and one rebuttal each |
| approvals / invalidations | Scope-bound immutable decisions and append-only invalidation links |
| budget_reservations / usage_receipts | Maximum enforceable liability with pricing/provider-cap evidence, separate planning estimate and actual usage; reconciliation without resetting unknown spend |
| outbox / snapshot_receipts | Consistent recovery exports with last event sequence/hash |

Use SQLite foreign keys, WAL and transactions with one writer. A state-changing command atomically appends its event, updates projections and queues recovery snapshot work. Enforce optimistic revision checks. Duplicate command IDs with identical payloads return the original outcome; conflicting reuse is rejected.

BudgetReservation contains currency, ceiling scope IDs, provider-enforced cap/tool profile, upper-bound charge, pricing/cap evidence, remaining reserved liability, planning estimate and reconciliation state. Enforce actual reconciled spend plus outstanding liability plus proposed reservation within every ceiling in the same transaction. Unknown liability blocks dispatch; estimates cannot stand in for an upper bound.

Artifact imports stream into a bounded quarantine directory and finalize only after schema/inventory/hash validation. Archive entries cannot escape their namespace, create symlinks, repeat names or exceed expansion limits. Never execute or deserialize untrusted model/script content. Structured detailed content validation runs as a provider task.

## 7. Desktop IPC command surface

The earlier HTTP route proposal is superseded. The renderer calls a narrow preload bridge; Electron main validates sender, schema, authenticated scope, idempotency and expected revision. The renderer cannot pass arbitrary channel names to a general invoke function.

Read commands: listProjects, getProject, listExperiments, getExperiment, listTasks, getTask, getReviewRound, listArtifacts, getArtifactPreview, getLineage, getSpend and getConnectionStatus.

User mutation commands: createProject, createExperimentDraft, sendScopedMessage, attachSelectedFiles, submitDraftForReview, recordUserScopeDecision, setUserBudget, requestTaskPause, requestTaskCancel, requestBoundedRetry, exportApprovedPackage, importSelectedResults, resolveOpenFact, configureProvider and configureArchive.

Internal controller actions: dispatchEligibleTask, ingestProviderEvent, ingestProviderArtifact, acceptPMOutput, submitRoleReport, closeRebuttal, recordDirectorDecision, invalidateDependents, reconcileJob, reconcileUsage and persistSnapshot. These are invoked only by authenticated controller/provider workflows, not exposed as arbitrary renderer calls.

Model-facing tools are a narrower subset: proposeBoundedTask, requestScopedArtifact, submitReport, proposeDecision and escalate. Tool returns never include unrestricted local paths or credentials.

Forbidden commands include executeLocalShell, importAndRunModule, setGatePass, arbitrarySetState, connectColab, openColab, launchNotebook, pollColab and fetchLiveNotebook. No generic browser/URL executor can substitute for them.

Errors are machine-readable: INVALID_SCHEMA, STALE_REVISION, WRONG_SCOPE, WRONG_BUNDLE, MISSING_EVIDENCE, HARD_GATE_FAILED, CAPABILITY_UNAVAILABLE, BUDGET_EXCEEDED, SUBMISSION_UNKNOWN, IMPORT_INCOMPLETE and FORBIDDEN_EXECUTION_DOMAIN. The UI renders a useful reason and next permitted action.

## 8. Disclosure and retention

First reports are controller-private to their author and authorized review coordinator until all required first reports are durable. Read APIs and artifact retrieval enforce the boundary, including metadata, summaries and search indexes. Original reports remain immutable after disclosure; corrections/rebuttals append linked records.

Store public messages, submitted positions, provider tool evidence and usage. Hidden model reasoning is neither requested nor required. Secrets are redacted before logging; sanitized report previews cannot load external assets.

Retention and deletion are user-owned configuration. Recovery snapshots contain no API keys. Changing retention cannot silently delete evidence underlying an active approval; surface dependent records for an explicit archival/deletion decision. Archived projects retain provenance unless the user requests its removal.
