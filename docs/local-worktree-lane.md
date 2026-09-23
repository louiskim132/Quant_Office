# Local worktree lane — provider grouping truth and lane design — 2026-09-19

Scope: how Codex, Claude Code and Devin group local sessions, what the
"one provider project, session-per-worktree" lane actually delivers per
provider, and where the isolated flat lane stays mandatory. Everything
below is surface probing — `--help`/`--version` output, on-disk session
stores and files the providers themselves wrote. No model-invoking
command was run (no `codex exec`, no `claude -p`, no `devin` session
creation); no account quota was consumed. Items marked **inferred** were
not directly verified on screen and say so.

Probed versions on this machine: `codex-cli 0.154.0` (session records up
to `cli_version 0.155.0-alpha.2.6` also inspected), `claude 2.1.273`,
`devin 3000.10.21`.

## 1. The three layers stay separate

The adopted isolation model for the local-lifecycle round keeps three
independent layers:

- **Grouping** — how the provider's own UI/store indexes sessions
  (sidebar project, resume-picker filter, `list` scope). Organizational
  only; it confines nothing.
- **Working directory** — the cwd a session runs in. It scopes where the
  session's tools focus and what auto-discovery reads; it does not
  restrict what the session may read. A session with
  `cwd = session-1/` can still open `session-2/` — per-packet cwd gives
  scoping, not confinement.
- **Sandbox / permission mode** — the layer that actually restricts
  reads/writes. Codex `-s/--sandbox`, Claude `--restricted` /
  `--permission-mode`, Devin `--sandbox` + `--permission-mode` live here.

The worktree lane changes grouping and working-directory only. It is
not an isolation upgrade, and this document makes no confinement claim
for it.

## 2. Codex — CLI storage is cwd-keyed; the Desktop project layer is a separate surface

Storage keys — where records live (verified by store inspection):

- `~/.codex/session_index.jsonl` (25 lines inspected): records carry
  exactly `id`, `thread_name`, `updated_at` — no cwd, no repo or
  project identity. Grouping does not live in the index.
- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, first line
  (`type:"session_meta"`): carries `session_id`, `id`,
  `parent_thread_id` (fork lineage), `cwd`, `originator`,
  `cli_version`, `source`, `thread_source`, `model_provider`. No repo
  or project field in cli_version 0.153.4 records.
- Newer records (cli_version `0.155.0-alpha.2.6`, originator
  "Codex Desktop", source "vscode") add `runtime_workspace_roots` — an
  array of workspace roots. Observed values: a two-root array
  (`...\Quant Office\repo` + `...\Codex\quant-team`) in one Desktop
  session, and single-root arrays equal to the office packet directory
  in the two pilot sessions under
  `...\Quant Research Office\workspace\local-sessions\session-*`.
  Multi-root workspaces exist in newer builds; the office packet-dir
  sessions each landed as their own single-root record.
- Distinct `cwd` values across all 57 inspected rollouts: each
  different directory is a separate key — the repo, its parent folder,
  `Documents\Codex\<date>` session dirs, and two office packet dirs all
  appear as independent values. Nothing at the storage layer collapses
  them into a repo group.
- `~/.codex/external_agent_session_imports.json`: Codex Desktop imports
  Claude sessions from `~/.claude/projects/<mangled-cwd>/*.jsonl` into
  its own threads — cross-provider confirmation that the Claude project
  key is the literal cwd path.
- `~/.codex/config.toml` (inspected): model/effort/notify/desktop/plugin
  settings only; no project-related configuration.

Session-picker scope — which sessions a surface lists (verified by
`--help` on the probed binary):

- `codex resume --help`: the picker filters sessions by cwd by default;
  `--all` — "Show all sessions (disables cwd filtering and shows CWD
  column)". Direct evidence that the CLI's session listing is keyed on
  cwd — and that one flag lifts the filter.
- `codex agents --help`: "Browse all agent sessions on the shared local
  app-server daemon" — a cross-cwd listing surface at the daemon level;
  `-C <DIR>` only sets the directory "for new tasks on a remote
  server".
- `codex --help`: `-C/--cd <DIR>` sets the working root;
  `--worktree` — "Run the session in a new managed Git worktree";
  `--add-dir <DIR>` — additional writable directories alongside the
  primary workspace; `-s/--sandbox <read-only|workspace-write|
  danger-full-access>`; `resume`, `fork`, `queue`, `archive`,
  `unarchive`, `delete` manage saved sessions by id or name;
  `migrate-rollouts` — "Inspect or migrate legacy local sessions to
  paginated thread history".

Grouping behavior — what a native project/sidebar surface groups:

- Codex Desktop's own embedded instructions (read inside a rollout
  `session_meta` `base_instructions` payload — provider-written
  documentation, inspected not executed): the sidebar has "pinned,
  custom, project, and task sidebar sections" with `list_projects`,
  `create_sidebar_section`, `move_project_to_sidebar_section` and
  `reorder_sidebar_projects` tools — projects are a first-class Desktop
  grouping. `create_thread` returns
  `::created-thread{clientThreadId="..."}` "for queued worktree
  setup" — Desktop threads can queue managed-worktree setup.
- OpenAI's published worktree documentation describes native worktree
  task grouping — **DOCUMENTED** from vendor docs, not re-verified on
  screen in this probe.
- `originator` values observed: `"Codex Desktop"` (43) and
  `"codex_work_desktop"` (14) — **inferred** to be the consumer and
  work desktop variants; not verified.
- Same payload: "### Projectless Chat — This projectless thread starts
  in a generated directory under the user's Documents/Codex folder."
  The matching on-disk dirs exist (`Documents\Codex\2026-09-*\<name>`;
  inspected `re`, `d`, `canva-plugin-*`, `presentations-plugin-*` —
  none contains a `.git` marker, so they are generated workspaces, not
  git worktrees).

What this means: the CLI resume picker and the rollout store are
cwd-keyed — two worktrees of one repo are two separate sessions to the
CLI, resolvable only by `--all`, `codex agents`, or explicit id. The
**project grouping lives in the Desktop app**, whose sidebar groups
threads under attached workspace folders (roadmap D2 note: the saved
'Agent Team' project points at a parent folder). Native worktree
support in Codex Desktop is documented — but it is **not** evidence
that an office-launched CLI session lands in a Desktop project: that
association is **UNVERIFIED**, no Desktop session was launched on a
worktree in this probe. Confirm once on screen before the lane relies
on it.

## 3. Claude Code — cwd-keyed project dirs; picker surfaces reach wider

Storage keys — where records live (verified by inspection):

- `~/.claude/projects/`: directory names are path-mangled cwds —
  `C--Users-louis-Desktop-AI-Quant-Office`,
  `...-Quant-Office-repo`, and
  `...-repo-sessions-next-batch-001-organizer` coexist as separate
  projects. The parent folder, the repo and a worktree of the repo each
  mint their own project directory.
- `~/.claude.json` `projects` keys: literal absolute paths; `C:\...`
  and `C:/...` spellings of the same folder coexist as separate keys.
  Keying is the raw cwd string, not a canonicalized repo identity.

Session-picker scope — which sessions a surface lists:

- Observed on the probed binary (`claude --help`): `-c/--continue` —
  "Continue the most recent conversation **in the current directory**";
  `-r/--resume [value]` — resume by session ID or picker; `-n/--name`;
  `--session-id <uuid>`. `claude agents --help`: `--cwd <path>` —
  "Show only background sessions started under <path>";
  `--all`/`--json` for the unfiltered view.
- **DOCUMENTED**, subject to installed-version verification: Claude
  Code's interactive surfaces offer repository-wide session picking —
  the `/resume` picker, the `Ctrl+W` session list and exact-id resume
  reach sessions beyond the current project directory. The probe
  confirmed `-r` accepts a session id; the interactive surfaces
  themselves were not opened on screen, so this claim rides on vendor
  documentation for the installed version family, not observation.
- Where `--worktree` worktrees land on disk: **unverified** — no
  claude-managed worktree directory was found on this machine (checked
  `~/.claude/`, the office repo and `Desktop\Codex\quant-team`). The
  help text confirms the feature (`-w/--worktree [name]`, with `--tmux`
  for the worktree session); its storage layout is not.

Grouping behavior — what a native project/sidebar surface groups:

- `claude project --help`: the only subcommand is `purge [path]` —
  "Delete all Claude Code state for a project (transcripts, tasks,
  file history, config entry)". "Project" in the CLI is path-keyed
  state; no CLI command groups multiple folders under one project —
  verified by absence across `claude --help`, `claude project --help`
  and `claude agents --help` on the probed version.
- `claude rm <id>` — "Delete a background session, and its worktree
  when that is safe" — worktree lifecycle is bound to the session.
- `--add-dir` widens tool access but does not change the project key;
  `--permission-mode` and `--restricted` belong to the permission
  layer, not grouping.
- Claude Desktop's parallel-session UI is a **distinct surface** from
  the CLI store. What it groups and whether an office-launched session
  appears in it are both UNKNOWN until a trial observes them.

What this means: the storage key is the cwd, so each worktree mints its
own project entry — but a storage key is not a picker ceiling. The
documented picker surfaces reach across project directories, and Claude
Desktop is a separate grouping surface entirely. "One Claude project
per office project" is UNSUPPORTED on the probed CLI surface; whether
any surface would group office-launched sessions usefully stays
UNKNOWN.

## 4. Devin — `working_directory` is the only binding

Storage keys — where records live (verified by read-only inspection):

- `%APPDATA%\devin\cli\sessions.db`, `sessions` table (inspected via a
  read-only `node:sqlite` query): `working_directory TEXT NOT NULL` is
  the location binding. A `workspace_dirs TEXT` column exists but is
  `[]` on the 12 most recent rows — multi-dir capability in schema,
  unused in practice.
- Live rows confirm per-cwd binding: each of the seven worker checkouts
  and the organizer checkout of this desktop batch is a separate
  session row keyed by its own `working_directory` (e.g. this session
  is `sparkly-thrush` @ `...\worker-6`), and the 2026-09-18 pilot left
  a row bound to an office packet dir under
  `...\Quant Research Office\workspace\local-sessions\`. Roadmap
  2026-09-18 records `devin -p` headless runs registering named rows
  here and `devin -r <id> -p` resuming them.
- Devin Desktop reads the same `sessions.db` — the store is shared —
  but Desktop and CLI are distinct credential surfaces: a signed-in CLI
  does not imply a signed-in Desktop app. What the shared store says
  about either surface's display is a separate question from what the
  schema contains.

Session-picker scope — which sessions a surface lists (verified by
`--help`):

- `devin list` — "List sessions in the current directory";
  interactive/json/csv formats; the scope is fixed to the cwd.
- `-c/--continue` most recent; `-r/--resume [<id>]`; `rm` — delete by
  id/name/prefix (`--force`); `--respect-workspace-trust` —
  non-interactive mode fails in untrusted directories.
- `devin acp --help`: `--agent-type` {summarizer, review}, `--model`,
  `--refusal-fallback`. No grouping concept — the ACP server carries
  session semantics only.
- `--sandbox` [Research Preview] (macOS seatbelt / Linux bwrap+seccomp
  only) and `--permission-mode` {auto, accept-edits, smart, dangerous}
  belong to the permission layer, not grouping.

Grouping behavior — what a native project/sidebar surface groups:

- No project/repo-grouping command exists in the CLI help — verified
  by absence on the probed version.
- Devin Desktop groups its session list by the working directory's
  workspace per the roadmap's 2026-09-18 probe — **UNKNOWN** at the GUI
  level: it was inferred there from the shared store; the display was
  never confirmed on screen. The CLI database says nothing about how
  Desktop renders it, and a schema row is not a grouping claim.

What this means: each office worktree is an independent Devin session
entry; `devin list` in the repo root shows only sessions launched
there, not worktree siblings. Desktop-side workspace grouping may exist
but is unconfirmed on screen — and it is Desktop's own surface, not
something the CLI schema grants office-launched sessions.

## 5. Lane design — where "one provider project" holds

The worktree lane (user direction): the office keeps one git repo per
office project; each LOCAL session materializes as a worktree of that
repo instead of a flat packet directory.

Evidence statuses: **OBSERVED** — verified on this machine's probed
binaries/stores; **DOCUMENTED** — vendor documentation (embedded or
published), not re-verified on screen; **UNKNOWN** — not yet observed;
**UNSUPPORTED** — verified absent on the probed surface. Every dated
claim is a point-in-time observation of the versions listed at the top
of this document, not a guarantee about other versions.

| Provider | Surface | Storage key | Picker/grouping claim | Evidence status | Date + how checked |
| --- | --- | --- | --- | --- | --- |
| Codex | CLI `resume` picker | rollout `session_meta.cwd` | Filters sessions to cwd; `--all` lifts the filter | OBSERVED | 2026-09-19 — `codex resume --help`, rollout inspection (cli 0.154.0) |
| Codex | `codex agents` | shared app-server daemon | Browses all sessions cross-cwd | OBSERVED | 2026-09-19 — `codex agents --help` |
| Codex | Desktop sidebar | `runtime_workspace_roots` on newer records | Project/sidebar sections group threads; managed-worktree setup exists | OBSERVED | 2026-09-19 — `session_meta` embedded instructions + rollout records |
| Codex | Desktop worktree tasks | same | Repo-attached project groups worktree tasks | DOCUMENTED | 2026-09-19 — OpenAI published worktree docs; not launched on screen |
| Codex | Office-launched CLI session → Desktop project | — | An externally launched session associates with a Desktop project | UNKNOWN | 2026-09-19 — never probed; native worktree support is not this evidence |
| Claude Code | `~/.claude/projects/` | path-mangled cwd directory | One project directory per cwd | OBSERVED | 2026-09-19 — directory listing |
| Claude Code | `--continue`, `agents --cwd` | same | Continue/list scoped to cwd | OBSERVED | 2026-09-19 — `claude --help`, `claude agents --help` (2.1.273) |
| Claude Code | `-r/--resume`, `/resume` picker, `Ctrl+W` list, exact-id resume | same | Repository-wide session picking beyond the cwd | DOCUMENTED | 2026-09-19 — `-r` confirmed in help; picker surfaces per vendor docs, installed-version dependent, not opened on screen |
| Claude Code | CLI grouping command | — | Groups multiple folders under one project | UNSUPPORTED | 2026-09-19 — absent across probed help surface |
| Claude Desktop | parallel-session UI | separate surface | Parallel sessions under its own grouping | DOCUMENTED; office-integration UNKNOWN | 2026-09-19 — vendor surface; no office trial |
| Devin | CLI `list`/`resume`/`rm` | `sessions.working_directory` | List scoped to cwd; resume/remove by id | OBSERVED | 2026-09-19 — `devin --help`, read-only `node:sqlite` query (3000.10.21) |
| Devin | Office-bound packet dir → `sessions.db` row | `sessions.working_directory` | The office resolves a packet dir's own session row on observe | OBSERVED | 2026-09-19 — read-only `discover()` trial against six real packet dirs: four resolve live devin session ids (`ribbon-museum`, `honey-almanac`, `fortunate-charger`, `hammerhead-fisher`); two have none (never ran); an empty control dir resolves none |
| Devin | Desktop session list | shared `sessions.db` | Groups by the working directory's workspace | UNKNOWN | 2026-09-19 — inferred from the shared store on 2026-09-18; GUI never confirmed on screen |
| Devin | CLI grouping command | — | Groups sessions across cwds | UNSUPPORTED | 2026-09-19 — absent across probed help surface |
| Office | Bound `observe()` → `groupingStatus`/`providerProjectId` | per-provider record key | A resolved provider record upgrades the binding's grouping to OBSERVED; absence infers nothing and never downgrades | OBSERVED | 2026-09-19 — wired in `LocalMailboxAdapter.observe` via `discover()`; batch-checkout trials resolved devin `working_directory` rows for organizer/worker-1/worker-2 and the claude project dir for organizer |

So the lane delivers "one provider project, session-per-worktree" only
where a repo/workspace-root grouping exists — Codex Desktop's project
sidebar (DOCUMENTED for its own sessions; the office-launch association
is UNKNOWN). Everywhere else it degrades to per-cwd entries, which is
still an improvement over flat packet dirs only in the shared git
dimension (common history, branches, diffs), not in provider
organization.

Working-directory consequences: each worktree is its own cwd, so
per-cwd surfaces (claude `--continue`, `agents --cwd`; codex `resume`
default filter; `devin list`) see one session at a time — acceptable
for office dispatch where the office tracks externalIds itself.
Cross-cwd surfaces (codex `resume --all`, `codex agents`, claude
`agents --all` and the documented repo-wide pickers, the Devin Desktop
global list) accumulate every session — the same orphan-accumulation
concern the roadmap recorded for `devin rm` cleanup applies, and each
provider needs its own cleanup path (codex `archive`/`delete`,
`claude rm` — which also removes the worktree "when that is safe" —
`devin rm --force`).

## 6. Sealed-review caveat — the flat lane stays mandatory

None of the probed grouping layers confine anything. Grouping is
organizational; worktree cwd is scoping; only each provider's
sandbox/permission layer restricts reads, and a worktree session
without one can read its sibling worktrees, the shared `.git`, and
every flat packet dir alike. A shared-root lane if anything *widens*
incidental exposure — siblings share a git object store and a project
grouping — relative to unrelated flat directories.

Sealed-review stages therefore keep relying on the isolated flat lane
plus instruction-only isolation, exactly as today; the worktree lane
is for unsealed office-labor packets only. Nothing in this document
weakens the roadmap's confinement honesty requirements: the office
confines nothing at the filesystem layer in either lane.

## 7. Manual usage note

For manual use alongside office dispatch: attach the office-project
repo root once as a project in the Codex app (organizer direction);
sessions launched from it should then group under that project in the
sidebar (**UNVERIFIED** — confirm once on screen; the underlying
session records still key the worktree cwd). For Claude and Devin
there is nothing to attach: each worktree session is a separate
cwd-keyed entry, resumed by `claude -r`/`--session-id` inside that
worktree and listed by `devin list` inside that worktree.
