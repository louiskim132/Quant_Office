# Provider model catalogs

How the office answers "which models can this account use" for each provider, and
how to keep that answer accurate. Written 2026-09-16 after a user report that
"gpt6" was missing from the OpenAI list. Code references are to
`app/src/main/subscriptions.ts`, `app/src/shared/effort.ts` and
`app/tests/devin-catalog.test.ts` at this checkout's round base. No installation
was performed and no live CLI call was made against a signed-in account.

## The gpt6 question, answered first

- No model is literally named `gpt6` or `gpt-6`. The GPT-6 family is real:
  OpenAI announced **GPT-6 Astra** on 2026-09-03 with API id `gpt-6-astra`,
  rolling out in stages — limited organizations first, then all ChatGPT
  Plus/Pro/Business/Enterprise plans, plus the OpenAI API, Azure and Bedrock.
- It is also a Codex model: the official Codex models page lists `gpt-6-astra`
  as the top recommended model, available in the Codex CLI and IDE extension —
  but not Codex cloud — with availability that "depends on the rollout, your
  sign-in method, and your client."
- So the report is half right. The office's *curated* OpenAI suggestion list
  (`PROVIDER_MODEL_SUGGESTIONS.openai`) is stale: it tops out at the gpt-5.6
  family and still names `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.1-codex` and
  `gpt-5-codex`, which the current docs treat as deprecated for ChatGPT sign-in
  (`gpt-5.2` and `gpt-5.3-codex` explicitly; `gpt-5.5` itself retires from Codex
  on 2026-10-14). But the suggestion list is not the catalog — after sign-in the
  live `model/list` response replaces it, and that response is account-scoped.
  If a signed-in account's rollout stage does not include Astra yet, then
  `gpt-6-astra` being absent from the live catalog is accurate entitlement
  reporting, not a bug.

## Per provider today

### Codex / OpenAI — live account-scoped catalog

- Path: `CodexMetadata` spawns `codex.exe app-server --listen stdio://` and
  speaks newline-delimited JSON-RPC. The method allowlist is `initialize`,
  `account/read`, `account/login/start`, `account/login/cancel`,
  `account/rateLimits/read`, `model/list`.
- Sign-in: `account/read` must report `account.type === 'chatgpt'`; API-key
  authentication is refused outright.
- Catalog: `model/list` with `{limit: 100, includeHidden: false}` is paged via
  `nextCursor` to exhaustion. Each entry contributes `id`, `displayName`,
  `supportedReasoningEfforts` (filtered to the office's known effort names) and
  `defaultReasoningEffort`. This is the only provider whose catalog carries
  per-model effort data, recorded as ACCOUNT_VERIFIED for that account.
- Caveats: app-server `model/list` is the mechanism the official surfaces use
  but is not a documented CLI contract — no supported `codex models` subcommand
  exists (openai/codex issue #23279; maintainers point at `model/list`). Results
  reflect the signed-in account's entitlement and rollout stage;
  `includeHidden:false` excludes anything the server flags hidden. A
  `model/list` failure currently aborts the entire status check rather than
  degrading to a note (unlike Devin).

### Devin — live CLI catalog after CLI sign-in

- Path: `devin auth status` first (a logged-out or unparsable status returns the
  connection unsigned with a note), then `devin models list --format json`. The
  documented command "lists the models available to your account, organized by
  model family."
- `devinModelCatalog` walks the JSON and collects `id`/`slug`/`name`/
  `model_uid` fields — family objects (e.g. `swe`) and variant objects
  (`swe-2-max`, label-derived names) alike — deduplicated, capped at 512.
- Effort: Devin encodes effort in the model variant (`swe-2-max` vs `swe-2`), so
  `effortIsIndependentAxis('devin')` is false and the effort field stays
  Provider default. The honest effort source is the catalog's variant naming
  itself — nothing is inferred.
- Caveats: the catalog is read only after `devin auth status` reports signed in;
  a catalog failure degrades to `connection.note` ("Devin model catalog
  unavailable. Refresh to retry.") with models empty. No usage windows exist.

### Claude — curated aliases, no live endpoint

- Path: `claude auth status` must report a signed-in claude.ai subscription
  (Console/API accounts are refused). No catalog call is made; the model list is
  `PROVIDER_MODEL_SUGGESTIONS.claude`, built into the app.
- The documented Claude Code surface confirms the gap: `--model` takes an alias
  (`sonnet`, `opus`, `haiku`, `fable`) or a full model id, and `/model` opens an
  interactive picker — no documented non-interactive command prints the
  account's model list.
- Implication: the list can silently drift from what the installed CLI and the
  account actually offer. It is recorded as DOCUMENTED/TOOL_SUPPORTED — "built
  into this application … not an entitlement check" — never ACCOUNT_VERIFIED.
  Aliases are contract-stable names the CLI resolves; pinned ids age out as
  Anthropic retires snapshots. Effort: the aliases expose no effort levels, so
  `['default']` is the only honest answer.

## Recommendations — retrieval contract for future rounds

1. **Live catalog where a supported one exists.** Codex `model/list` after
   sign-in; Devin `models list --format json` after CLI sign-in. Treat the
   result as account-scoped truth for that moment: absence means entitlement or
   rollout stage, never proof the model does not exist.
2. **Curated lists are fallback UX, never catalog truth.** Keep suggestion
   entries labeled as suggestions (the model input is free-text and
   provider-side validation stays authoritative), pin a review date next to each
   list, and re-check against primary docs at that cadence. Today the OpenAI
   list needs `gpt-6-astra` added and the deprecated codex-suffixed 5.x entries
   re-evaluated; the Claude list needs the same review-date discipline.
3. **Surface staleness honestly.** An empty live catalog already lands as
   MODEL_CATALOG UNAVAILABLE plus a user-visible "unavailable, refresh to retry"
   note on Devin; on Codex a catalog failure currently fails the whole status
   check. Decoupling account check from catalog check is a design decision for a
   future round, not assumed here.
4. **Effort data per provider.** OpenAI: only from live
   `supportedReasoningEfforts`/`defaultReasoningEffort` (e.g. Astra drops the
   `none` effort level — whatever the catalog returns is the truth). Devin: from
   variant naming/catalog metadata only; no separate axis. Claude: UNKNOWN
   beyond `default` until a catalog source exists.
5. **Watch points.** If a supported `codex models` CLI command ships
   (openai/codex#23279), prefer it over the undocumented app-server method. On
   each Claude review pass, re-check the cli-reference/commands docs for a
   non-interactive model list.

## Sources

Code (this checkout, at the round base):

- `app/src/main/subscriptions.ts` — `CodexMetadata`/`allowedMethods`, `status`,
  `observe`, `devinModelCatalog`, `claudeIdentity`.
- `app/src/shared/effort.ts` — `PROVIDER_MODEL_SUGGESTIONS`, `efforts`,
  `effortIsIndependentAxis`.
- `app/tests/devin-catalog.test.ts` — catalog parsing contract; notes the CLI is
  not signed in on this machine so no test may spawn it.

Primary sources (accessed 2026-09-16):

- <https://openai.com/index/gpt-6-astra/> — GPT-6 Astra announcement and staged
  rollout plan.
- <https://openai.com/products/release-notes/> — 2026-09-03 release entry;
  migration notes (no `none` reasoning effort, no custom temperature/top_p).
- <https://developers.openai.com/codex/models> — recommended Codex models
  including `gpt-6-astra`; per-surface availability; deprecation and retirement
  dates for the gpt-5.x generation.
- <https://docs.devin.ai/cli/reference/commands> — `devin models list`
  [`--format json`] is the documented account model list.
- <https://code.claude.com/docs/en/cli-reference> and
  <https://code.claude.com/docs/en/commands> — `--model` aliases and the
  interactive `/model` picker; no list command.
- <https://github.com/openai/codex/issues/23279> — no supported `codex models`
  command; app-server `model/list` is the existing path.

UNKNOWN / unverified here:

- The exact `model/list` response for this machine's OpenAI account — no live
  CLI call was made, per this packet's constraint.
- Whether `includeHidden:false` would have surfaced `gpt-6-astra` during its
  staged rollout on any given account.
- The current Devin account catalog — the CLI is not signed in on this machine.
