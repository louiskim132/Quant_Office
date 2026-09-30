# Architecture decisions — version 0.3

These decisions resolve the product architecture. They do not freeze scientific policies or claim an implemented application.

| ID | Decision | Reason and consequence |
| --- | --- | --- |
| ADR-001 | Generalized quant research team | The user clarified that CatBoost illustrates the hierarchy. Projects supply their own model/data/metric/policy packages; the example is inactive by default. |
| ADR-002 | Windows graphical EXE | The user requested a desktop program with a DeskRPG-like office. Electron + React + PixiJS replaces the previous FastAPI/browser UI proposal. |
| ADR-003 | Deterministic local controller | UI, routing, file transfer, metadata checks and durable state run locally. No local model inference or agent-authored executable work. |
| ADR-004 | OpenAI/Anthropic-hosted agent work only | Each executable task requires a verified provider-owned execution profile. Missing dependencies block or route within these providers; inference access alone is insufficient. |
| ADR-005 | Zero agent/controller interaction with Colab | Colab has no adapter, credential, browser automation, live file access, launch, poll or callback. The user exports code and later imports files manually. |
| ADR-006 | User-imported results retain external origin | Integrity checks/reconstruction can strengthen evidence but cannot invent a provider receipt for an unobserved run. |
| ADR-007 | One Director, four PMs, two worker slots | Preserve the requested hierarchy/model targets, independent role contexts and globally bounded worker capacity. |
| ADR-008 | Independent first reviews and one rebuttal | A/B and C/D rounds preserve original disagreement and prevent early conclusion sharing; decisions bind frozen bundles. |
| ADR-009 | Versioned contracts before autonomy | Stable schemas and authority checks precede live delegation. Model prose cannot set gates or modify protected scientific rules. |
| ADR-010 | SQLite single writer plus remote snapshots | Atomic events/projections/outbox support restart; remote Git and a dedicated artifact archive preserve authoritative history. |
| ADR-011 | Byte/content identities and conservative invalidation | Source, data, config, tests, environment, package and launcher changes invalidate affected approvals/cache stages. |
| ADR-012 | Idle/waiting means no agent calls | Avatars are presentation only. An experiment awaiting the user's files generates no autonomous reminders or model polling. |
| ADR-013 | Separate execution, validity, finding and advancement | Invalid/incomplete evidence cannot become a null result; engineering completion cannot imply strategy promotion. |
| ADR-014 | Narrow desktop IPC and model tools | No arbitrary local shell, URL execution or state-setting endpoint. Provider transport and artifact gateways enforce scope. |
| ADR-015 | Finalized source is a portable static deliverable | The team can author a notebook and instructions without interacting with Colab. User-run code has no team callbacks or embedded agent APIs. |
| ADR-016 | Reserve maximum enforceable liability | All shared spend ceilings account for outstanding maximum charges; estimates are informational and unknown liability blocks dispatch. |
| ADR-017 | Explicit smoke-before-expensive-work gate | Full-run approval binds accepted compatible smoke evidence or a reviewed launcher enforcing the gate; conditional approval is not a passed smoke. |
| ADR-018 | Enforce region/exposure at artifact transfer | Mixed/unclassified and protected-derived artifacts cannot pass through ordinary grants; any protected access requires user authority and an exposure event before transfer. |
| ADR-019 | Detached approval envelope | Finalize and hash payload bytes before creating approval; inventories and outer transport hashes cannot introduce circular dependencies. |

## Precedence and history

Architecture 0.1 focused on packaging the supplied CatBoost source. Version 0.2 generalized projects but still described a local web service and an over-integrated Colab handoff. Version 0.3 supersedes those choices with the current desktop/provider/user boundary.

The original handoff and source stay unchanged as historical references. The example packaging document is non-normative for the platform and subordinate to ADR-003 through ADR-005. The current architecture, workflow, provider and UI documents govern implementation.

## Setup inputs, not unresolved architecture

Provider account access and exact model/tool capabilities, approved hosted build/test profiles, user budget limits, remote Git/archive destinations and the first real research mandate must be configured before their dependent operations. No provider prices, entitlements, GPU/Windows build availability or research outcomes are assumed.
