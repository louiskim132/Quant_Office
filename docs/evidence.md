# Evidence labels

How the office labels what it has and has not verified. A label describes the strength and source of one record; it is never upgraded by repetition, and no label claims more than the operation that produced it. Current runtime status for each scope lives in the [readiness matrix](../app/docs/readiness.md).

## Levels and kinds

| Level | Meaning |
| --- | --- |
| ACCOUNT_VERIFIED | The provider's own response verified the item for this account — for example a signed-in subscription reported by the official tool, or a model catalog it returned. |
| TOOL_SUPPORTED | The installed tool exposes the surface, or the office exercised it directly on this machine. Office capability, not provider attestation. |
| DOCUMENTED | Reference material only: documentation, a built-in alias list or a recorded request. It can never make anything runnable on its own. |
| UNAVAILABLE / UNKNOWN | Checked and absent, or never established for this account and tool. |

Evidence kind separates OBSERVED — the operation was actually exercised — from DOCUMENTED reference material. Every record is bound to the provider, identity, credential context, tool version, route, environment, model, effort and delegation scope it was produced under; it does not transfer to another scope, environment or route.

## Local operations

The LOCAL_SUBMIT / LOCAL_OBSERVE / LOCAL_OUTPUT_FETCH / LOCAL_CANCEL family, together with MODEL_APPLICATION, EFFORT_APPLICATION, DELEGATION_CONTROL and TOOL_CONFINEMENT, forms the LOCAL_DISPATCH readiness family. Local evidence is always office-observed — the office itself wrote, spawned, read or terminated something on this machine — and is labeled at most TOOL_SUPPORTED/OBSERVED. It is never ACCOUNT_VERIFIED provider attestation, and local evidence never satisfies a hosted requirement or the reverse.

Evidence accrues only from the operation the office just performed, and only while the fact it describes is still checkable: LOCAL_SUBMIT is recorded while the written `packet.json` is on disk, LOCAL_OBSERVE and LOCAL_OUTPUT_FETCH only behind a fully hash-verified `result.json`, and LOCAL_CANCEL only while the cancel sentinel exists. On a local route the office is the observing authority, so TOOL_SUPPORTED/OBSERVED is the level a local scope's readiness requires; a hosted scope still requires provider-side ACCOUNT_VERIFIED/OBSERVED, and the two families share no operations.

| Operation | What it records | What it does not record |
| --- | --- | --- |
| LOCAL_SUBMIT | The office submitted work to the local session — writing the scoped packet directory (`packet.json` plus the result contract and hashed declared inputs under `inputs/`) or spawning the child process — and the route was recorded. The job is left UNKNOWN, awaiting a session. | Hosted dispatch; the provider receiving or accepting a job. |
| LOCAL_OBSERVE | The office read the session's own reported state from a `result.json` that passed strict shape validation with every declared output verified. | Provider-reported status; an account-side job. Silence — an absent, oversized or malformed receipt — records nothing. |
| LOCAL_OUTPUT_FETCH | The office read back every artifact `result.json` declared and verified each declared sha256 and byte count against the bytes on disk. | Artifact correctness, review quality or custody. |
| LOCAL_CANCEL | The office ended the local session — cancel sentinel or process kill. A real cancellation of that session. | A provider cancellation acknowledgement; nothing provider-side exists to acknowledge. |

## Scoped delivery is not isolation

TOOL_CONFINEMENT records how a session's tools, filesystem, network and environment were configured — for example a packet delivered only into a dedicated workspace folder. Readiness checks the content of that record, not its presence: every field must describe an actual restriction. Even a fully described confinement is scoped workspace delivery, not enforced blinding, sandboxing or independent isolation.

A model, effort or delegation value a local session reports in `result.json` (`appliedModel`, `appliedEffort`, `delegation`) is self-report: it is recorded as MODEL_APPLICATION, EFFORT_APPLICATION or DELEGATION_CONTROL only when the receipt actually declared it — an absent field is never inferred — and the office observed the claim in the receipt, not the applied setting itself. Self-report is not proof a session ran under those values unless the tool's own output verifies them. A saved agent profile — including its execution environment and tool profile — is configuration, never proof that a runtime exists or that a session ran under it.

## Eligibility

Because scoped delivery is not isolation, local agents are ineligible for blinded-review, holdout-custody and independently-verified-gate roles unless enforced isolation is separately verified. Office-observed local evidence never counts as provider attestation, hosted execution or usage/allowance accounting, and local readiness never falls back to hosted evidence or vice versa.

Local sessions never run research computation: training, evaluation and backtests stay in the user's manual Colab flow, and a local agent is never a substitute for the user's run.
