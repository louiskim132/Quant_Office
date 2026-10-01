# L1 / L2 — review notes, gates remain open

The user explicitly excluded completion of legal review. Counsel must record a decision for each provider and authentication mode. The source packet remains [provider-terms-review-prep-2026-09-28.md](provider-terms-review-prep-2026-09-28.md). Add these questions to that review:

1. May the owner use their own subscription through the official CLI, with this office supplying prompts and managing local processes?
2. May customers use their own subscriptions through the distributed office, and under what provider-specific restrictions?
3. May the same subscriber sign in separately under QRO-Agent, a second local Windows account used for process isolation?
4. Which provider-hosted session operations are permitted on that subscription, and which require a separate agreement or billing mode?

For each answer, preserve the provider, plan, sign-in mode, reviewed terms/version/date, permitted operations, restrictions and counsel decision. Product tests and official login success do not answer these questions. No counsel decision was obtained, and L1 is not complete.

D-3 remains deferred under U8 until legal review is resolved and the user reopens it. Prepared release sequence: select a per-machine installer/runtime location usable by QRO-Agent; obtain the signing identity; define a customer-readable release/update host and rollback policy; build and sign exact artifacts; install/update/uninstall in a clean Windows VM; scan the final package for workspace data, credentials and developer identifiers. No certificate, hosting, signed installer, update service or clean-machine acceptance was acquired or claimed here.

L3 stays settled: GitHub Free, N4 triggers and the procedural exact-head merge gate. X4 stays optional: the stale/dirty Git anchor was not reset. X5 is prepared: the current installed App was copied to `Quant Office/Archive/App-before-revision-20261001`; its asar matches `7E7C7FE471D15530F04B8AFF44CC624F348F45AAA7FC6D5B1EA7AD9237212C44`. Any later installed mirror must use an integrated release, confirm the app is closed and record its hash. This revision is a local candidate, not an installed release.
