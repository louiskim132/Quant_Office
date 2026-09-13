# Local consumption, effort and activity — desktop 0.3.0

## Boundaries

Local transcript reconstruction is a pure file-read operation. It makes no inference calls, paid API probes, credential requests or Colab connections. It measures selected local records, not authoritative subscription allowance. The rolling last five hours and seven days are reporting periods, not guessed provider reset windows. Files may cover multiple accounts and billing modes; absent web/mobile/other-device activity is not reconstructed. Do not use the counters to authorize research dispatch against a subscription ceiling.

The native subscription usage page remains the source for Claude's remaining allowance. A token-sized API call uses a separate API interface and is not a substitute for subscription accounting.

## Reconstruction

The default directory is the user's `.claude/projects`; a native folder picker supports other transcript locations. Only `.jsonl` regular files inside the selected directory tree are scanned. Links and out-of-tree resolved paths are skipped. Each scan reads a bounded snapshot of file sizes, so appending files cannot make the scan run indefinitely. Scans start fresh, avoiding stale offsets after truncation or replacement.

Assistant messages with valid session IDs, response IDs, timestamps and integer usage counters are considered. Responses are deduplicated by provider message ID (record UUID fallback); repeated/streamed snapshots use the maximum of each reported token counter rather than adding the snapshots. Input, output, cache read and cache creation are counted separately. The scanner returns aggregates, coverage diagnostics and the folder path, never message content. Nothing is uploaded or persisted from the scan.

Limits: 512 MiB total input per scan, 5,000 JSONL files, 20,000 directory entries, depth eight, two MiB per line and 100,000 unique response identities. Exceeding a limit is reported as partial coverage. Missing or invalid fields, future timestamps and unfinished JSON lines are reported rather than guessed. Model/day totals are within the last seven days; day labels use UTC.

## Effort

Effort can be selected during Add Agent and changed by clicking the agent's office desk. Existing records without an effort remain Provider default; historical events are never rewritten. Updates check the previous saved value to reject stale edits and append an agent event. The setting is a preference for the next provider request, not proof that a model applied it. Provider-hosted dispatch is still unimplemented.

Codex exposes effort options through model metadata and a non-default change checks the current agent account/model. Claude support is based on documented model families; unknown models and models without effort expose default only. Account-level restrictions still need validation at future dispatch. The app rejects unsupported choices instead of selecting a different effort silently.

## Work and conversation logs

Click a registered desk for its detail view. The Logs page additionally supports all-agent and between-agent views. Office configuration events have provenance OFFICE_EVENT. Explicitly imported transcripts have provenance USER_IMPORTED. These are visible messages, tool summaries/results and status records; no internal thinking blocks are imported. No agent execution or conversation is fabricated.

Native Claude JSONL imports require the session/timestamp and user/assistant message shape. A native transcript is associated with the selected agent by the importing user. This association is not provider-verified. Inter-agent exchanges use normalized JSONL, one object per line:

```json
{"format":"qro-log-v1","conversationId":"experiment-review-1","messageId":"message-001","from":"REGISTERED-SENDER-AGENT-UUID","to":"REGISTERED-RECIPIENT-AGENT-UUID","kind":"MESSAGE","text":"Visible review request or response","timestamp":"2026-09-07T12:00:00Z"}
```

Replace UUID placeholders with agent IDs shown in each agent detail view. Every row must involve the selected importing agent. `from` and `to` can also be `USER`, `TOOL`, or `SYSTEM`; `kind` is `MESSAGE`, `TOOL`, or `STATUS`. The same conversation ID groups messages; each message needs a stable external message ID. Native Claude transcripts cannot establish between-office-agent attribution merely from role names, so the importer does not infer it.

Imports allow one file up to 16 MiB, 20,000 lines, two MiB per source line and 64,000 characters per visible entry. Imported endpoints must exist. Invalid or conflicting imports fail atomically. Re-importing matching message identities does not duplicate them. Parsed entries and the original source file hash are stored in the verified SQLite event stream and included in workspace backup. Original source bytes are not copied into the office. All text is rendered inertly, without execution or remote content loading.

## Evidence and references

54 local automated checks cover reconstruction, partial files, duplicates, immutable logs, endpoint validation, effort controls and backup recovery alongside prior app checks. Desktop integration exercises actual Codex metadata with an isolated office and fixture transcript imports. No model prompts are used.

Official references: [Claude local usage breakdown](https://code.claude.com/docs/en/costs), [Claude effort levels](https://code.claude.com/docs/en/model-config), [Codex model metadata](https://learn.chatgpt.com/docs/app-server).
