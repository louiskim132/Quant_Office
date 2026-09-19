> Surface-level findings note from round `local-lifecycle`, worker-4. This is a findings record, not a design decision. All observations are from `--help` output, version output, installed binaries, config files, and vendor documentation shipped with the Devin CLI. **No model-invoking command was run** — no `codex exec`, no `claude -p`, no `devin -p`, no Devin task creation, no live-provider fixture — and no account quota was intentionally consumed. Help/version/config observations are **not** equivalent to a live behavioral isolation test; statements about what a flag confines are vendor help/doc claims, not office-verified behavior. Inferred conclusions are labeled `inferred`.

# Local sandbox probe — what each CLI can actually confine

Machine: Windows (`win32-x64`), user profile `C:\Users\louis`. Probe date: 2026-09-19.

## Tier definitions

| Tier | Meaning |
| --- | --- |
| instruction-level | Scope is conveyed by prompt, config, working directory, or tool-call approval policy. Nothing at the OS stops an out-of-scope action; enforcement is the agent's own compliance or a user approval prompt. |
| write-confinement | A mechanism (OS sandbox or tool-layer enforcement) prevents writes outside the declared scope. |
| read-confinement | A mechanism prevents reads outside the declared scope. Stronger than write-confinement and required for sealed/blinded roles. |

## Codex — `codex-cli 0.154.0`

Binary probed: `C:\Users\louis\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe` (companion `codex-code-mode-host.exe` in the same directory; `codex-windows-sandbox-setup.exe` present under `codex-resources\`).

| Probe | Salient output | What it confines | Verified by | Tier | Unverified without a live run |
| --- | --- | --- | --- | --- | --- |
| `codex.exe --help` | `sandbox` subcommand: "Run commands within a Codex-provided sandbox"; `-c` example `sandbox_permissions=["disk-full-read-access"]` | Existence of a sandbox subsystem and a disk-read permission tier | help text | — | — |
| `codex.exe exec --help` | `-s, --sandbox <read-only\|workspace-write\|danger-full-access>` — "Select the sandbox policy to use when executing model-generated shell commands"; `--add-dir <DIR>` "Additional directories that should be writable alongside the primary workspace"; `--dangerously-bypass-approvals-and-sandbox` "execute commands without sandboxing… Intended solely for running in environments that are externally sandboxed"; `-C/--cd` working root | Write policy for model-generated shell commands: read-only denies writes; workspace-write permits writes to the workspace plus `--add-dir` dirs; danger-full-access removes the sandbox | help text | write-confinement (claimed, OS-level) | Whether the default mode confines anything when `-s` is not passed; whether reads are scoped in `workspace-write` mode; whether non-shell tools (file edits, MCP) are inside the sandbox |
| `codex.exe sandbox --help` | "Full command args to run under Windows restricted token sandbox"; `--sandbox-state-readable-root <ROOT>` (repeatable) "Add a readable root to the supplied sandbox state"; `--sandbox-state-disable-network` "Disable direct network access in the supplied sandbox state"; `-P/--permission-profile <NAME>` | A Windows **restricted-token** sandbox (a real OS security mechanism); readable roots imply a declared-read-set mechanism; network access can be disabled | help text | read-confinement mechanism exists (claimed) | Which reads are confined by default; exact semantics of readable roots vs. `disk-full-read-access`; whether the restricted token engages for office-style sessions |
| `%USERPROFILE%\.codex\config.toml` | `[windows] sandbox = "elevated"`; no top-level `sandbox_mode`/`sandbox_permissions`; `[projects.'…'] trust_level = "trusted"` entries including prior office `local-sessions\session-…` directories | Windows sandbox component installed/enabled; per-project trust records (incl. office mailbox session dirs) | config inspection | — | What policy `elevated` + `trusted` actually applied in those sessions — `inferred`: likely workspace-write with restricted token, but not stated |
| install dir listing | `codex-windows-sandbox-setup.exe` present under `codex-resources\` | The Windows sandbox requires a setup helper; it exists on this machine | installed binary | — | Whether the helper was run and the sandbox actually engages |

**Codex summary.** The vendor claims an OS-level (Windows restricted-token) sandbox governing *model-generated shell commands*, with write modes `read-only`/`workspace-write`/`danger-full-access`, a readable-roots mechanism, and a network-disable option. That is a claimed write-confinement tier with a read-confinement mechanism available — but the office's mailbox route passes no flags: the user launches the CLI, so the effective policy is whatever the user's invocation/config defaults to, and the office neither controls nor observes it. `inferred`: with `workspace-write` plus explicit readable roots and disabled network, Codex could plausibly reach read-confinement for shell commands — unverified without a live run, and non-shell tool surfaces are unclear.

## Claude Code — `2.1.273`

Binary probed: `C:\Users\louis\.local\bin\claude.exe` (`claude doctor`: "Running: native (2.1.273)", "No installation issues found", no managed/organization settings).

| Probe | Salient output | What it confines | Verified by | Tier | Unverified without a live run |
| --- | --- | --- | --- | --- | --- |
| `claude.exe --help` | `--permission-mode <acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan>` | Whether tool calls auto-run or prompt for approval — an approval policy, not OS confinement | help text | instruction-level | — |
| `claude.exe --help` | `--allowedTools/--allowed-tools`, `--disallowedTools/--disallowed-tools` (e.g. `"Bash(git *) Edit"`); `--tools <tools...>` "Specify the list of available tools… Use `\"\"` to disable all tools" | Which built-in tools the agent may call, including argument-pattern scoping for shell commands | help text | instruction-level (tool-call gating) | Whether a denied tool can be reached indirectly (e.g., via MCP) |
| `claude.exe --help` | `--add-dir <directories...>` "Additional directories to allow tool access to" | Widens the set of directories the file tools may access — implies file tools are dir-scoped by default | help text | — | The default directory scope and its enforcement strength |
| `claude.exe --help` | `--restricted` — "removes the built-in tools that run commands or code (Bash, PowerShell, REPL and the other code-running tools) and WebFetch unless `--tools` names them… Also confines the file tools to the working directories (`--add-dir` included), refuses bypassPermissions, and lets only a person or the configured permission handler approve writes to settings, git and tool-configuration files" | With code-running tools removed, remaining file tools are confined to the working directories — read **and** write confinement, enforced inside Claude Code's own file-tool implementations (tool-layer, not OS) | help text | read-confinement (tool-layer, claimed) | Robustness of the confinement (symlinks, junctions, path traversal); whether MCP servers/configured tools bypass it |
| `claude.exe --help` | `--dangerously-skip-permissions` — "Bypass all permission checks. Recommended only for sandboxes with no internet access." | Acknowledges the CLI's own gates are permission checks; vendor recommends an *external* sandbox for real isolation | help text | — | — |
| `claude doctor`; `~/.claude/settings.json` | No managed settings; settings.json contains model/theme only — no `permissions`/`sandbox` config | Nothing configured on this machine tightens the default permission surface | config inspection | — | — |

**Claude summary.** No OS-sandbox flag exists. Permission modes and tool allow/deny lists gate *tool calls* (instruction-level). `--restricted` is the strongest surface: it removes code-running tools and confines file tools to working directories — a claimed tool-layer read-confinement, not OS enforcement. If any shell tool remains allowed, confinement collapses to instruction-level because a shell can read outside the directory scope.

## Devin — `devin 3000.10.21 (611c1cba)`

Binary probed: `devin.exe` on PATH. Documentation probed: `sandbox.mdx` and `reference/permissions.mdx` shipped with the installed CLI.

| Probe | Salient output | What it confines | Verified by | Tier | Unverified without a live run |
| --- | --- | --- | --- | --- | --- |
| `devin --help` | `--sandbox` — "[Research Preview] Sandbox exec-tool processes (macOS seatbelt / Linux bwrap+seccomp). When passed, commands can write only within the workspace and granted `Write(...)` scopes, and can read everything except paths hidden by `Deny(Read(...))` rules." | OS-level sandbox for exec-tool subprocesses: writes confined to workspace + granted scopes; reads allow-by-default minus `Read(...)` deny paths | help text | write-confinement + deny-based read-hiding (claimed, OS-level) | Behavior on this machine — see `sandbox setup` below |
| `devin.exe sandbox setup` | "Sandbox mode on Windows requires running Devin inside WSL 2… Sessions that pass `--sandbox` or run under enterprise Required enforcement will refuse to start outside WSL." | **On native Windows the OS sandbox is unavailable and fail-closed** — sessions refuse rather than run unsandboxed | direct command output (this machine) | instruction/permission-level only on this machine | Whether WSL-2-based use is viable for office sessions |
| `devin --help`; permissions.mdx | `--permission-mode <auto\|accept-edits\|smart\|dangerous>` — "auto-approves read-only tools… 'dangerous' auto-approves all tools"; scopes `Read(glob)`, `Write(glob)`, `Exec(prefix)`, `Fetch(pattern)`, tool names, `mcp__*`; precedence org > session > project-local > project > user | Approval policy over tool calls; deny/ask/allow rules per path glob, command prefix, URL pattern, tool | help text + docs | instruction-level (tool-call gating) | — |
| sandbox.mdx | Writable paths = workspace + granted `Write(...)` scopes, "everything else is read-only"; readable = everything except `Read(...)` deny paths "hidden from sandboxed commands entirely"; fail-closed if sandbox resolution fails; "**Windows**: OS-level sandboxing is not currently supported… hard-fail when `--sandbox` is passed… including when the CLI runs as an ACP server"; domain filtering via loopback proxy (`allowed_domains`/`denied_domains`, "currently unstable"); `sandbox.excluded` `Exec(...)` rules can run matching commands *outside* the sandbox (deny > ask > allow) | On supported platforms: OS write-confinement + deny-list read-hiding + optional network proxy; exclusions can pierce the sandbox | vendor docs | — | Exclusion rules and `edit`/`write` tools run *in the CLI process, outside the sandbox* — agent's own file tools are bounded only by permission rules |
| `devin acp --help` | `--agent-type`: `summarizer` "no tools", `review` "read-only + shell tools"; `--model`, `--refusal-fallback` | Per-agent-type tool-surface scoping on the ACP route | help text | instruction-level (tool-call gating) | Whether ACP sessions honor `--sandbox` on this platform — docs say ACP/Desktop sessions hard-fail under `--sandbox` on Windows |

**Devin summary.** Devin publishes the most explicit OS-sandbox contract of the three — fail-closed, write-confinement plus deny-based read-hiding plus optional network filtering — **but not on native Windows**: `devin sandbox setup` states plainly that Windows requires WSL 2 and sessions refuse to start otherwise. On this machine, Devin's effective tier is instruction/permission-level only. Its read-hiding is also deny-list shaped (hide declared paths), which suits secret-file exclusion but not "may read only the packet" allow-list scoping.

## Comparison against the office mailbox claim

`app/src/main/local-session.ts` records `TOOL_CONFINEMENT` as: tools receive packet contents only; filesystem is one dedicated session directory; network is not restricted by the office; environment is a user-launched official CLI session on this machine. Against the probe:

- The mailbox's dedicated directory is a **delivery scope**, not an enforcement. None of the three CLIs is launched by the office with confinement flags; each session's effective policy is whatever the user's own invocation and config produce — office-observed, never office-enforced.
- On this Windows machine: Codex *could* plausibly enforce workspace-write + readable-roots + no-network for shell commands if invoked so (`inferred`, unverified live); Claude `--restricted` offers tool-layer file confinement; Devin cannot offer OS confinement natively at all.
- Therefore the current mailbox records describe **instruction-level scoping** and must not be read as provider-enforced OS isolation — consistent with the roadmap's existing warning that Serena paths, worktrees, and plugin settings do not prove OS isolation.

## Implication for sealed-review eligibility

Sealed-review stages (S2/S7 blinded review, holdout custody, independently verified gates) require **read-confinement**: the reviewer must provably be unable to read holdout/blinding material outside its packet. On this machine, no local CLI route currently offers office-enforced, office-verified read-confinement:

- Codex's readable-roots mechanism is the closest candidate but is unverified behaviorally, governs shell commands (other tool surfaces unclear), and is not wired into the mailbox.
- Claude `--restricted` is tool-layer confinement only — unverified against escape paths, and void if a shell tool is allowed.
- Devin's OS sandbox hard-fails on native Windows; its deny-list read-hiding does not match allow-list packet scoping regardless.

This supports keeping the existing eligibility rule — local agents remain ineligible for blinded review, holdout custody, and independently verified gate roles — until a specific route's isolation is both office-controlled and verified by a live behavioral probe. Nothing here is a design decision; it is a findings record for the organizer.
