# LOCAL_CLI_EXEC provider probes — 2026-09-20

Phase-1 probe record for the office-spawned local CLI route. Each line distinguishes
what was observed on this machine from what help text advertises. Scratch packets lived
under `%TEMP%\qro-cli-probe`; the authoritative legs used real v2 packets written by
`prepareLocalPacket` and were validated by the office's own `readLocalResult`.

Tool versions observed: claude `2.1.273`, codex `0.154.0`, devin `3000.10.21 (611c1cba)`.

## Claude (`C:\Users\louis\.local\bin\claude.exe`)

- `claude -p "<prompt>" --output-format json` runs unattended. The JSON envelope carries
  `session_id`, `modelUsage` (per-model tokens/cost, `canonicalModel`), `result`,
  `permission_denials`, `terminal_reason`, and usage/cost metadata — but only at process
  end; mid-run session identity must come from the registration directory, not stdout.
- Without a permission bypass the session reads the packet but **every write is denied**
  (denials enumerated in `permission_denials`; it honestly reported being blocked and
  even attempted a RUNNING receipt). `--dangerously-skip-permissions` is the flag that
  made writes succeed in this scratch setup; `--permission-mode` variants exist but the
  bypass is what was exercised end to end.
- With the bypass: wrote `outputs/probe.txt` (exact copy of the declared input) and a
  `result.json` that **passed `readLocalResult` end-to-end** — COMPLETED, sequence 1,
  attempt/packet binding correct, output hash+bytes verified, UTF-8 no BOM, honest
  `applied` self-report (`claude-opus-5`, medium, delegation false vs. the packet's
  placeholder `probe-model`).
- Sessions register under `~/.claude/projects/<cwd-key>/<session-id>.jsonl`.
  `claude --resume <session-id>` resumed the probe session correctly.
- `--model` exists; `modelUsage` reports what actually ran — launch-arg model vs.
  applied-model cross-check is viable evidence.

## Codex (`codex-cli 0.154.0`)

- `codex exec -s workspace-write --skip-git-repo-check "<prompt>"` runs unattended with
  the spawn `cwd` set to the packet directory — **no `-C` needed**; earlier scratch runs
  showed `-C` does not make the model's shell start in that directory (PowerShell opened
  at `C:\`, and `Set-Location` into the packet dir was denied by the sandbox; only
  `cmd /c cd /d <dir>` worked). The spawn `cwd` is the authoritative placement.
- The workspace-write sandbox **was observed** refusing a `Set-Location` outside the
  workspace root on Windows; writes inside the packet dir succeeded. Read confinement
  outside the workspace is **untested** — do not claim it.
- Flags observed in help: `-s/--sandbox {read-only|workspace-write|danger-full-access}`,
  `-a/--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`, `-C/--cd`,
  `-m/--model`, `--json`, `--output-schema`, `--ephemeral`, `exec resume [id]` /
  `--last`.
- The real-packet run produced `outputs/probe.txt` + `result.json` that **passed
  `readLocalResult`** — COMPLETED, sequence 1, bound IDs, hash/bytes verified, no BOM.
  Codex wrote no `applied` block (no self-report) — applied-model evidence for codex
  comes only from launch args.
- Sessions register under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`.
- `codex exec` prints a `session id:` line on stdout during the run — stdout capture is
  a viable mid-run session-id source for this provider.

## Devin (`devin.exe 3000.10.21`)

- `devin -p` was proven in the earlier session probes (`--respect-workspace-trust false`
  required — help confirms print mode cannot show the trust prompt and fails untrusted
  dirs without it); sessions register in `sessions.db`; `devin list --format json` and
  `-r` resumption verified.
- `--model <MODEL>` exists on the top-level command. `--permission-mode` accepts
  `auto | accept-edits | smart | dangerous`; `auto` only auto-approves read-only tools,
  so contract writes need `accept-edits` or stronger.
- **`devin acp` is a real ACP stdio server.** `initialize` returns capabilities:
  `sessionCapabilities: {list, delete, additionalDirectories}`, `loadSession: true`,
  `promptCapabilities: {image, embeddedContext}`, `mcpCapabilities: {http: false,
  sse: false}`, plus Cognition `_meta` extensions (multiRootWorkspace,
  terminalLifecycle, chains, userShellCommand, …). `_meta.mcpConfigPath` names the
  global MCP config file.
- `session/list` works **unauthenticated** and returns the same inventory `devin list`
  shows (ids, cwd, titles, updatedAt, `_meta` Cognition fields).
- `session/cancel` is implemented **as a notification** (spec-correct): sent as a
  request it returns `-32601 Method not found`; sent as a notification the
  `acp_bridge_dispatch{method="session/cancel"}` handler runs cleanly.
- `session/new` is gated: `-32000` "ACP host has not authenticated" — the ACP host must
  call `authenticate` with `meta.api_key` (or the `devin-browser` PKCE method). Local
  CLI credentials are intentionally not used in ACP mode. **Consequence: ACP is not a
  drop-in spawn path** — it requires handling the user's API key. `devin -p` remains the
  Phase-2 launch path; ACP stays recorded for a possible `LOCAL_ACP` route later.
- `session/new` does carry an `mcpServers` field — recognized by the schema (an
  untagged enum; the probe's shape was rejected at deserialization for missing the
  variant fields, e.g. `env`). Whether per-session MCP config actually applies is
  unverifiable until past the auth gate.
- **Blocker found during this probe**: the stored credential at
  `%APPDATA%\devin\credentials.toml` (Sep 12, `windsurf_api_key`) is rejected —
  `devin auth status` reports "Not logged in." `devin -p` therefore fails today with
  "Not logged in." The Devin contract-adherence leg is **unproven** until the user
  re-authenticates (`devin auth login`) and the run is repeated.
- **Auth split-brain observed**: `devin auth login` reports "already logged in" (the
  browser/IDE session is live) while `auth status` and `-p` read the on-disk credential
  and still report "Not logged in" — the file's mtime never advanced past Sep 12, so the
  login path did not persist a CLI-readable credential. The deterministic unblock is
  `devin auth login --force-manual-token-flow` (paste a token), or complete the browser
  PKCE redirect so the credential file is actually rewritten; `auth status` flipping to
  logged-in is the verification.

## Authoritative verdict

| Provider | Unattended spawn | Contract files | `readLocalResult` | Session register | Resume | Cancel surface |
|---|---|---|---|---|---|---|
| claude | yes (`-p`, needs `--dangerously-skip-permissions`) | yes | VALIDATED (COMPLETED) | `~/.claude/projects/<cwd-key>/` | `--resume <id>` | kill PID + sentinel |
| codex | yes (`exec -s workspace-write`, spawn-cwd) | yes | VALIDATED (COMPLETED) | `~/.codex/sessions/…/rollout-*.jsonl` | `exec resume [--last]` | kill PID + sentinel |
| devin | proven earlier; currently blocked — credential expired | unproven | unproven | `sessions.db` + `list --format json` | `-r <id>` | kill PID + sentinel; ACP `session/cancel` notification exists |

Unproven and not claimed: codex read confinement outside the workspace on Windows;
devin contract adherence and model-flag effect; mid-run session-id extraction for
claude (end-of-run JSON and registration-dir discovery are the working surfaces).
