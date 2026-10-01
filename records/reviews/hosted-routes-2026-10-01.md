# S3 — subscription cloud route review, 2026-10-01

Reviewed source `beab1ce`, installed CLI help and the linked primary documentation. No cloud session was created or resumed. A local CLI process ending does not prove that a cloud session stopped. R5 remains BLOCKED_EXTERNAL.

| Provider | Submit | Observe / retrieve | Follow-up | Stop / acknowledgement | Model / effort | Billing and eligibility |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | `codex cloud exec --env …` | `status`, `list`, `diff`, `apply`; diffs are not a complete artifact/event protocol | No dedicated cloud follow-up command in installed help | No cloud cancel command in installed help | Cloud help exposes environment/attempts/branch. Generic config overrides do not prove cloud model/effort application | ChatGPT allowance; purchased credits can extend usage. API-key billing is separate. A complete office lifecycle and an allowance-only boundary are unverified. |
| Claude Code | `--cloud` with description; account sign-in required | Interactive attach/teleport documented; bounded unattended artifact/event retrieval unverified | Attach existing session | No unattended cancel/ack route established; local `stop` commands do not establish cloud cancellation | Local `--model` / `--effort` help does not establish hosted application | Cloud shares subscription limits with no separate VM compute charge. Account eligibility and the missing lifecycle routes keep this blocked. |
| Devin | Docs describe `--cloud -p`, absent from installed global help; installed `devin cloud` manages DRS resources | Streamed terminal session and resume documented; DRS build logs concern builds, not agent outputs | Cloud resume documented | `/archive` is documented; no cancellation acknowledgement contract established | Cloud `/model` documented; separate effort control unverified | Enterprise docs describe existing ACU allocation. This does not prove the current Pro account's cloud allowance or a no-overage boundary; exclude until verified. |

Sources checked: [Codex commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [Codex pricing](https://learn.chatgpt.com/docs/pricing), [Claude cloud](https://code.claude.com/docs/en/claude-code-on-the-web), [Devin cloud](https://docs.devin.ai/cli/cloud), [Devin commands](https://docs.devin.ai/cli/reference/commands), [Devin enterprise authentication and billing](https://docs.devin.ai/cli/enterprise/devin-auth).

The old Claude fixture `session_01Aj1hpgmeoZLdgYVR9eQ6PB` remains last reconciled at USER_REPORTED completion on 2026-09-12 (roadmap R5 / section 13). It was not reattached here. No current machine-readable closure claim is available. Reconcile that session before proposing a new hosted fixture; the plan requires explicit user approval for a new cloud session.

## OF-3 and Devin ACP

Codex `exec --json` is now enabled in the local office launch. Documented command/MCP/web-search item frames become TOOL events while the job is running. Terminal `turn.failed` records become provider-reported FAILED after process exit; unrelated log/error text does not. Source: [OpenAI CLI event definitions](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs). Live bad-model and cancellation evidence is in the B5 record.

`devin acp --model swe-2-max` answered an initialization-only JSON-RPC probe: protocol 1, loadSession true, image/embedded-context true, audio false, HTTP/SSE MCP false, browser authentication advertised. No session or prompt was created. Raw response is outside Git in `Docs/Reviews/revision-2026-10-01/devin-acp-initialize.json`. [Devin ACP documentation](https://docs.devin.ai/cli/acp/zed) and [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization) establish the protocol, not an office transport acceptance.

Remaining OF-3/ACP work: a durable ACP session identity, permission-request handling, prompt/cancel/restart/output receipts, bounded tool updates and subscription identity checks before routing real office jobs. Claude/Devin tool-event normalization is also open. The current initialize response alone cannot close those contracts.
