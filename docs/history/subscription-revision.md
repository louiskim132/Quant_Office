# Subscription setup revision — desktop 0.2.0

This revision supersedes architecture 0.3 wherever the earlier plan specifies API billing, currency budgets, an empty Add Agent tab or fixed team/worker counts.

Local execution is authorized for the graphical app, its development tests, official provider sign-in tools and read-only account/model/usage metadata. It remains prohibited for agent research, model training, scientific tests and calculations. Colab remains completely outside the team.

Agent creation is a two-phase operation. Add validates the draft, checks the selected provider's subscription identity and launches official sign-in only if needed. The main process retains a short-lived confirmation ticket bound to the draft and account. Nothing enters the persistent roster yet. Confirm rechecks account identity and, for Codex, available model metadata, then appends an immutable agent event. Cancel, expired tickets, account changes and unavailable Codex models cannot create an agent. No credentials appear in the renderer or workspace backup.

Name, provider, model, team, role and instructions belong to the agent. Account allowance belongs to the provider account and is shared by every agent using it. There is no roster or per-role maximum. Provider concurrency constraints apply to active work only when actually reported. Each new agent is HOSTED_SETUP_REQUIRED; authentication is not evidence of hosted research capability.

Codex uses the official app-server with an explicit metadata-only method allowlist. It never starts a thread, turn, process or research tool. Usage windows use provider-reported durations, remaining percentages and reset timestamps. No usage is estimated. Claude sign-in runs the unmodified official Claude Code binary in its own interactive window. Only auth status JSON is read; Quant Research Office does not read, collect or intermediate Claude session tokens. Claude usage retrieval and model entitlement checking are unavailable in this version and labeled accordingly. The official usage page can be opened manually.

The local installed provider account is reused; switching accounts in the official provider tool changes the identity returned on the next verification. This release does not manage multiple simultaneous credential profiles for a provider. Registered account labels are historical setup identities, not a claim of continuous connectivity.

Existing workspace records retain their legacy monetary fields for backward-compatible event integrity; these fields have no billing or dispatch effect. Existing events are not rewritten. New agent metadata participates in the same event chain, projection verification and workspace backup.

References: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude CLI authentication commands](https://code.claude.com/docs/en/cli-reference), [Claude authentication](https://code.claude.com/docs/en/authentication), [Claude integration terms](https://code.claude.com/docs/en/legal-and-compliance).
