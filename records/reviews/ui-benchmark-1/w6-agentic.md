# w6 — Agentic-tool UI comparator study

Round: `ui-benchmark-1`. Worker: `worker-6`. Baseline: packaged `App\` build mirroring main `65bddec`, captured by the organizer under `drafts/organizer/ui-baseline/` (`empty/`, `populated/`, `live/`).

Comparator set (assigned): Devin's own UI (devin.ai + docs.devin.ai) plus adjacent agentic work surfaces — Devin Desktop / ex-Windsurf docs (docs.devin.ai/desktop, windsurf.com redirect), Cursor (cursor.com + cursor.com/docs), GitHub Copilot cloud agent (github.com + docs.github.com), Jules (jules.google/docs), Replit Agent (docs.replit.com), Claude Code (code.claude.com/docs + anthropic.com), and OpenAI Codex (developers.openai.com/codex — openai.com itself blocked capture, see §6).

Focus per packet: **agent activity representation** (working state, evidence, plans, diffs) and **status honesty** — scored against the office's isometric scene + "provider-reported activity" labels (centerpiece: `drafts/organizer/ui-baseline/live/live-20-settled-office.png`).

## 1. Scope and capture method per artifact

All captures use **source method (a)** — direct free capture with Playwright 1.63.0 (`app/node_modules/playwright`, `chromium`, headless, 1600×1000 viewport, full-page screenshot + `innerText` text file + raw HTML saved per page, best-effort cookie-consent dismissal). Scripts and run manifests are in `swipe/worker-6/` (`capture.cjs`, `capture2.cjs`, `capture3.cjs`, `manifest.json`, `manifest2.json`, `manifest3.json`). No paid/authenticated surfaces were used; nothing was purchased.

Three passes were run on 2026-09-30:

| Pass | Targets | Outcome |
| --- | --- | --- |
| 1 | Product/marketing landings + docs roots for 8 comparators (17 URLs) | 17/17 HTTP 200; openai.com rendered a client-side "couldn't load" page (documented gap); windsurf.com redirected to a Devin Desktop page |
| 2 | Deep docs pages discovered from pass-1 nav links (27 URLs) | All returned; `docs.cursor.com/docs/*` redirected to `cursor.com/docs` (6 duplicate landing captures kept as redirect evidence, superseded by pass 3); 4 guessed `docs.windsurf.com/desktop/*` paths 404'd (real paths live under `docs.devin.ai/desktop/*`) |
| 3 | Corrected hosts: `cursor.com/docs/*`, `docs.devin.ai/desktop/*`, `developers.openai.com/codex*` (12 URLs) | 12/12 captured with distinct content |

Artifacts are full-page captures of **public docs and marketing pages**, including the product-UI screenshots those pages embed. Live in-app behavior behind login (app.devin.ai sessions, github.com Agents page in a repo, the Jules web app) was not captured — see §6.

## 2. Artifact inventory (swipe path → what it shows)

Every `.png` below has a sibling `.txt` (source URL, final URL, HTTP status, extracted text — citable quotes below are from these) and a sibling `.html`. All paths are `swipe/worker-6/`.

### Devin (cloud) — primary comparator

| Artifact | What it shows |
| --- | --- |
| `devin-home.png` | devin.ai marketing home: hero shows the real session UI (sidebar session list, chat with plan, embedded IDE); "From problem to merged PR" 4-step loop (plan → code/test → Devin Review → automate) with UI screenshots per step; "keeps working when your laptop is closed" |
| `devin-docs-home.png` | "Introducing Devin" doc: session UI = conversational interface + embedded IDE; three watch-and-take-over cards — **Shell** ("watch commands being executed and view output logs"), **IDE** ("follow Devin's actions in real-time and take over to do some pair programming"), **Browser** (watch Devin browse/test web apps); Devin-in-Slack surface |
| `devin-docs-session-tools.png` | Session tools doc: **Progress tab** — "All shell commands, code edits, and browser activity will be logged in one unified view"; command history with **time navigation** (greyed-out commands are at a future point); side chats (`/btw`); IDE takeover requires pausing Devin first; interactive browser for CAPTCHA/MFA assist |
| `devin-docs-session-insights.png` | Session Insights doc: retrospective analytics — session overview metrics, ACU usage, session-size tiers (XS–XXL), event timeline, knowledge usage, editable playbook, "interpreting common insight patterns" (e.g., high ACU + few user messages) |
| `devin-docs-recordings.png` | Testing & Video Recordings doc: Devin records an annotated video of an end-to-end test run and sends it as proof — "a code reviewer watches and immediately thinks 'yep, it works'" |
| `devin-docs-ask.png` / `devin-docs-handoff.png` / `devin-docs-scheduled.png` | Ask Devin (Q&A mode), hand a session from any agent/CLI to Devin Cloud, scheduled recurring sessions |
| `devin-cognition-home.png` | Cognition company site (context only) |

### Devin Desktop (ex-Windsurf) — adjacent agentic surface

| Artifact | What it shows |
| --- | --- |
| `windsurf-home.png` | windsurf.com redirect → "Devin Desktop" marketing: "A team of agents for every engineer", "One Space for every agent", "Agents on ACP" (multi-agent protocol), plan pricing |
| `windsurf-docs-home.png` | docs.windsurf.com redirect → `docs.devin.ai/desktop/getting-started` (docs merged post-acquisition) |
| `ddocs-agent-command-center.png` | **Agent Command Center doc**: "Kanban-style view… grouped by status, so you can see at a glance what each agent is working on, what is blocked, and what is ready for review"; unifies **local + cloud agents** in one board; sessions **locked/greyed-out and read-only while their agent runs**; sign-out shows a sign-in prompt rather than an error; native OS notification when a session finishes or needs input (one setting covers every agent kind, off by default) |
| `ddocs-spaces.png` | Spaces doc: a Space groups "all of the agent sessions, PRs, files, and context" for one task; new sessions inherit the Space's context; drag sessions onto each other to group |
| `ddocs-cascade.png` | Cascade doc: auto-created **Todo list** to track progress on complex tasks; **queued messages** while the agent works; revert any step or named checkpoint; multiple Cascades in parallel |
| `ddocs-quick-review.png` / `ddocs-devin.png` | Quick Review surface; running Devin cloud sessions inside Devin Desktop |
| `windsurf-docs-agent-command-center.png`, `windsurf-docs-cascade.png`, `windsurf-docs-devin.png`, `windsurf-docs-quick-review.png` | 404 pages from the pre-merge `docs.windsurf.com` host — kept as redirect/migration evidence, superseded by the `ddocs-*` captures |

### Cursor

| Artifact | What it shows |
| --- | --- |
| `cursor-home.png` / `cursor-features.png` | Marketing: IDE hero with agent panel + diff review; "Agents turn ideas into code"; **Mission Control interface**; "Works autonomously, runs in parallel"; Slack/GitHub surfaces |
| `cursor-doc-agent-overview.png` | Agent docs overview |
| `cursor-doc-agents-window.png` | **Agents Window doc**: "agent-first interface… unified workspace to build with agents across repos and environments, including local, cloud, remote SSH"; command-palette open; can run alongside the editor |
| `cursor-doc-plan-mode.png` | **Plan Mode doc**: agent "creates a comprehensive implementation plan" → user reviews/edits through chat or markdown files → "click to build"; plans saved as files in home dir or workspace; revert-and-refine loop documented |
| `cursor-doc-agent-review.png` | Agent Review doc: dedicated code review on local changes; auto-run after every agent task or manual (`/agent-review`, Source Control tab); Quick vs deep review-depth table |
| `cursor-doc-cloud-agent.png` | Cloud Agents overview (background agents on remote machines) |
| `cursor-docs-home.png` | Docs landing (correct content); `cursor-docs-agent-overview.png`, `cursor-docs-agents-window.png`, `cursor-docs-plan-mode.png`, `cursor-docs-agent-review.png`, `cursor-docs-cloud-agent.png`, `cursor-docs-subagents.png` | six identical captures of the docs landing after `docs.cursor.com` redirected to `cursor.com/docs` — superseded by `cursor-doc-*` |

### GitHub Copilot cloud agent

| Artifact | What it shows |
| --- | --- |
| `gh-copilot-feature.png` | Copilot feature page: "Command your craft"; "manage agent-driven work from one place"; agent-authored PR with session link visible in checks UI; plan tiers |
| `gh-copilot-docs.png` | Copilot docs root (agents nav tree) |
| `gh-cloud-agent.png` | "About Copilot cloud agent": assign an issue → Copilot plans/codes/tests in the background → pushes commits to a **draft PR** → requests review; session-log link; "sharing context between Copilot CLI and cloud agent sessions" |
| `gh-agent-management.png` | "About agent management": one control page to "jump between agent sessions, check progress"; **monitor live session logs** "in real time"; track all active sessions per repo; **steer agents mid-session** without stopping the run; open a session in VS Code / Copilot CLI |
| `gh-coding-agent-howto.png` | How-to hub redirect → `…/use-copilot-agents/cloud-agent` (kept as nav evidence) |

### Jules (Google)

| Artifact | What it shows |
| --- | --- |
| `jules-docs.png` | Docs root |
| `jules-docs-running-tasks.png` | "Running Tasks" doc — **"Watching Jules work": an activity feed as each step completes; inline explanations of each change; a mini diff preview for each file** (diff editor for the full view); final summary = files changed, total runtime, lines added/changed/removed; **pause/unpause**; mid-task feedback chat; GitHub-issue label trigger |
| `jules-docs-review-plan.png` | Review-plan doc: plan approval gate before coding, feedback loop |

### Replit Agent

| Artifact | What it shows |
| --- | --- |
| `replit-home.png` / `replit-agent-docs.png` | Marketing + Agent overview |
| `replit-docs-task-board.png` | **Task board doc**: columns **Drafts / Active / Ready / Done** — "what Agent has planned, what is running, what is ready for review, and what has already been applied"; card UI with "Apply changes to main version" / Dismiss / "Message agent"; per-task settings (auto-apply, auto-approve plan, rename, review changes, cancel) |
| `replit-docs-task-lifecycle.png` | **Task lifecycle doc**: explicit states — Draft → Active → Queued (dependency or task-limit wait) → Ready (finished but **not applied to main version**) → Applying → Done; plus Archived and Cancelled; "review the task's work log, test results, and preview before applying"; each task isolated in its own copy of the project |
| `replit-docs-plan-mode.png` | Plan Mode doc (plan before build) |

### Claude Code

| Artifact | What it shows |
| --- | --- |
| `claude-code-page.png` | anthropic.com marketing (terminal-first agent) |
| `claude-code-docs.png` / `claude-docs-sessions.png` / `claude-docs-desktop.png` | Docs overview; session management; desktop app |
| `claude-docs-agent-view.png` (+ `.txt`) | **Agent view doc**: `claude agents` full-terminal monitor — "lists every session grouped by state, with pinned sessions and **the ones that need you at the top**"; documented groups: Pinned / Ready for review / **Needs input** / Working; each row shows name, **current activity**, and **age** (finished sessions freeze at run duration); sessions readable as JSON from the shell; honest post-shutdown states ("sessions show as failed or stopped after shutdown") |

### OpenAI Codex (partial coverage)

| Artifact | What it shows |
| --- | --- |
| `openai-codex.png`, `openai-codex-intro.png` | openai.com returned HTTP 200 but rendered "This page couldn't load" (client-side block) — kept as gap evidence |
| `openai-codex-dev.png`, `openai-codex-cloud.png` | Codex docs on the ChatGPT Learn site: "Work in > Cloud" tasks, per-task workspace that "can keep working while your computer is asleep", "Inspect changed files and check results, request follow-up changes, and commit or open a pull request", "Approve for me" control |

## 3. Comparator scorecard (seven rubric dimensions, 1–5)

Scores judge **what the captured artifacts demonstrate about the shipped UI's activity/status model**, not marketing claims in the abstract. Quotes cite the artifact; inferences are marked (inf).

| Comparator | 1 Density | 2 Navigation | 3 Queue/status | 4 Presence/notif | 5 Status honesty | 6 Empty/loading/error | 7 Accessibility |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Devin (cloud) | 4 | 4 | 3 | 4 | 4 | 3 | 3 |
| Devin Desktop (ACC) | 4 | 4 | 5 | 4 | 4 | 3 | 3 |
| Cursor | 5 | 4 | 4 | 3 | 3 | 3 | 4 |
| GitHub Copilot agent | 4 | 4 | 4 | 4 | 4 | 3 | 4 |
| Jules | 3 | 3 | 3 | 3 | 4 | 3 | 2 |
| Replit Agent | 4 | 4 | 5 | 3 | 4 | 4 | 2 |
| Claude Code | 4 | 4 | 4 | 3 | 4 | 4 | 3 |
| OpenAI Codex (partial) | 3 | 3 | 3 | 3 | 3 | 3 | 3 |

Evidence per comparator:

- **Devin (cloud)** — Density 4: session UI combines chat, plan, Progress tab, Shell/IDE/Browser in one screen (`devin-docs-home.png`, `devin-home.png`). Nav 4: session-list sidebar + tabbed tools + Slack as an alternate surface (`devin-docs-home.png`, `devin-home.png`). Queue/status 3: session list exists but the cloud product docs show no status-grouped workboard; that surface is Devin Desktop's ACC (`devin-docs-home.png`, `ddocs-agent-command-center.png`). Presence/notif 4: Slack-native presence (@Devin in threads), scheduled sessions, works while laptop closed (`devin-docs-home.png`, `devin-home.png`). Honesty 4: the Progress tab logs "all shell commands, code edits, and browser activity… in one unified view" with time navigation, and testing produces an annotated video "as proof" — evidence-grade honesty, though no explicit verified-vs-claimed label vocabulary (`devin-docs-session-tools.png/.txt`, `devin-docs-recordings.png/.txt`). Empty/err 3: "Recording failed" state documented; no empty/loading states shown publicly (`devin-docs-recordings.png`). A11y 3 (inf): IDE takeover inherits editor affordances; nothing else evidenced.
- **Devin Desktop (ACC)** — Queue/status 5: Kanban grouped by status across **local and cloud** agents — "what is in flight, what needs your attention, and what is finished", Blocked column visible (`ddocs-agent-command-center.png`). Presence/notif 4: per-session native OS notification on finish-or-needs-input, one setting per agent kind, off by default (`ddocs-agent-command-center.png/.txt`). Honesty 4: running sessions render **greyed-out and read-only** — the UI itself marks state as not-yours-to-touch; signed-out shows a sign-in prompt rather than an error (`ddocs-agent-command-center.png/.txt`). Nav 4: Spaces group sessions+PRs+files+context per task (`ddocs-spaces.png/.txt`). Density 4: compact cards, one line of status each (`ddocs-agent-command-center.png`). Empty/err 3, A11y 3 (inf: no captures evidence either).
- **Cursor** — Density 5: full IDE + agent panel + diff review + Mission Control (`cursor-home.png`, `cursor-doc-agents-window.png`). Nav 4: command-palette "Open Agents Window", IDE↔agents-window simultaneity (`cursor-doc-agents-window.png`). Queue/status 4: Agents Window unifies local/cloud/SSH agents in one workspace (`cursor-doc-agents-window.png/.txt`). Presence/notif 3: parallel agents + Slack/GitHub surfaces; no in-product attention queue evidenced (`cursor-home.png`, `cursor-features.png`). Honesty 3: Plan Mode produces a reviewable markdown plan artifact and Agent Review re-checks the agent's own changes — strong workflow gates, but no explicit verified/reported/unknown distinction (`cursor-doc-plan-mode.png/.txt`, `cursor-doc-agent-review.png/.txt`). Empty/err 3 (no evidence). A11y 4 (inf): VS Code heritage, keyboard-first command palette evidenced in `cursor-doc-agents-window.png`.
- **GitHub Copilot agent** — Density 4: Agents tab + session log + PR diff surfaces (`gh-copilot-feature.png`, `gh-agent-management.png`). Nav 4: lives inside existing repo/agents-page navigation (`gh-agent-management.png/.txt`). Queue/status 4: "track active sessions", run many concurrently, one control page (`gh-agent-management.png/.txt`). Presence/notif 4: inherits GitHub notifications; agent PRs request review; sessions open in VS Code/CLI (`gh-agent-management.png/.txt`, `gh-cloud-agent.png`). Honesty 4: **live session logs in real time** + every change lands as commits on a draft PR — an auditable trail; steer mid-session is itself honestly scoped (consumes credits per message) (`gh-agent-management.png/.txt`, `gh-cloud-agent.png`). Empty/err 3. A11y 4 (inf): GitHub's documented accessibility program; not directly evidenced by these captures.
- **Jules** — Honesty 4: activity feed per completed step, inline explanation per change, mini diff preview per file, final summary with files/runtime/line counts (`jules-docs-running-tasks.png/.txt`). Queue/status 3: pause/unpause + task list; scheduled tasks (`jules-docs-running-tasks.png/.txt`, `jules-docs.png`). Density/Nav/Presence 3. Empty/err 3 (a dedicated "Errors and failures" docs page exists per `jules-docs.png` nav). A11y 2: nothing evidenced.
- **Replit Agent** — Queue/status 5: the most explicit lifecycle captured — Draft → Active → Queued → Ready → Applying → Done (+ Archived/Cancelled), per-stage icons, dependency- and limit-based queueing, isolated per-task copies until apply (`replit-docs-task-lifecycle.png/.txt`, `replit-docs-task-board.png/.txt`). Honesty 4: **"Ready" means finished but not applied** — done-ness and merged-ness are never conflated; work log + test results + preview precede apply (`replit-docs-task-lifecycle.png/.txt`). Density/Nav 4 (`replit-docs-task-board.png`). Presence 3 (message-agent + follow-ups only, `replit-docs-task-board.txt`). Empty/err 4: cancelled/archived are first-class documented states (`replit-docs-task-lifecycle.txt`). A11y 2: nothing evidenced.
- **Claude Code** — Queue/status 4: agent view groups sessions **by state** — Pinned / Ready for review / **Needs input** / Working — "the ones that need you at the top"; rows show live activity text and age (`claude-docs-agent-view.txt`; the `.png` rendered cramped — text artifact is the primary evidence). Honesty 4: state read from a supervisor process; post-shutdown sessions honestly "show as failed or stopped"; session state scriptable as JSON — the status surface and the machine-readable record are one thing (`claude-docs-agent-view.txt`). Density 4: compact terminal rows. Nav 4: attach/background/switch/filter by `--cwd`, `/fork` (`claude-docs-agent-view.txt`). Presence 3: terminal + desktop app (`claude-docs-desktop.png`). Empty/err 4: an unusually honest public troubleshooting catalog — "terminal host died", "session isn't responding", "fails before starting with a possibly low memory note" (`claude-docs-agent-view.txt`). A11y 3 (inf): keyboard-native TUI but no screen-reader evidence.
- **OpenAI Codex** — scored 3 across the board as **partial coverage**: only `developers.openai.com`/`ChatGPT Learn` docs captured (`openai-codex-dev.png`, `openai-codex-cloud.png`); the product UI itself was not reachable. Documented: per-task cloud workspaces, "Approve for me" gate, review-then-PR flow (`openai-codex-cloud.png/.txt`). All Codex scores are inference-flagged.

## 4. Office comparison per dimension

Baseline artifacts cited are under `drafts/organizer/ui-baseline/`.

1. **Information density** — Baseline: `live/live-20-settled-office.png` (isometric scene, ~6 status captions, one feed item), `populated/populated-01-office.png`. **Comparators better.** Cursor's Agents Window, the ACC Kanban and Replit's board carry an order of magnitude more actionable status per pixel (`cursor-doc-agents-window.png`, `ddocs-agent-command-center.png`, `replit-docs-task-board.png`). The office deliberately spends most of the viewport on a spatial metaphor with one datum per desk — glanceable at 10 feet, thin at 10 inches. The scene is the office's identity; the gap is that **no denser status view exists alongside it** (inference: from the baseline set no table/board view of agent work is offered on the Office page).
2. **Navigation model** — Baseline: `populated/populated-01-office.png` sidebar groups + `empty/empty-command-palette.png` "Go to…" palette. **Comparators better.** Office navigation is competent (grouped sidebar + palette) but flat: no task-scoped grouping like ACC **Spaces** ("sessions, PRs, files, and context for a task or project into a single view", `ddocs-spaces.png/.txt`) and no dual-mode surface like Cursor's IDE↔Agents Window (`cursor-doc-agents-window.png`).
3. **Queue/status UX** — Baseline: `live/live-20-settled-office.png` ("1 working now" banner, per-desk "Working · 29s" / "Idle · no open provider work", status bar "1 working · 0 need you · 8 agents"), `live/f-20-project-detail.png` (request rows: "Status: ready" / "Provider job: failed"), `live/live-11-running-agents.png` (agents table). **Comparators better.** The office communicates ambient state beautifully but offers no status-grouped, actionable queue: ACC's Kanban (`ddocs-agent-command-center.png`), Replit's seven-state lifecycle (`replit-docs-task-lifecycle.png`), and Claude's state-grouped list (`claude-docs-agent-view.txt`) all turn status into an ordered work surface.
4. **Presence and notifications** — Baseline: `live/f-11-attention-panel.png` (NEEDS YOU dropdown with reason + concrete action), `live/live-20-settled-office.png` (bell badge), `live/live-11-running-agents.png` (sidebar badge). **Parity — different strengths.** In-app, the office's attention queue is as good as anything captured: like Claude's "the ones that need you at the top" (`claude-docs-agent-view.txt`) and ACC's needs-attention column (`ddocs-agent-command-center.png`), but each item carries a human-readable reason and next action. Outside the app it loses: ACC ships a native OS notification per session (`ddocs-agent-command-center.png/.txt`) and Devin/Copilot reach users through Slack/PR surfaces (`devin-docs-home.png`, `gh-agent-management.png`); the office shows no external notification path in the baseline.
5. **Status honesty** — Baseline: `live/live-20-settled-office.png` ("provider-reported activity", "Working · 29s", "Idle · no open provider work"), `live/live-11-running-agents.png` (an agent mid-hop still labeled **"Unknown"**), `live/live-24-history.png` ("Office observation is not provider attestation"; "this view does not perform a new chain verification"), `live/f-20-project-detail.png` (two-track "Status: ready" + "Provider job: failed"). **Office does it better — its signature advantage.** No captured comparator exposes a verified/self-reported/unknown epistemic vocabulary in the status surface itself. Devin's unified activity log + annotated video proof (`devin-docs-session-tools.txt`, `devin-docs-recordings.txt`) and Copilot's live session logs + draft-PR commits (`gh-agent-management.txt`) deliver strong *evidence* trails, and Replit's not-applied-yet "Ready" (`replit-docs-task-lifecycle.txt`) is honest about done-ness — but only the office labels *what kind of claim a status is*. Recommendation: treat this as the crown jewel; extend, don't dilute.
6. **Empty/loading/error states** — Baseline: `empty/empty-01-office.png` ("Set up your office · 0/5" actionable checklist, "Nobody working right now", "The conversation starts here"), `live/f-10-office-failed.png` + `live/f-11-attention-panel.png` (failed provider job surfaced with retry path). **Parity.** The office's checklist empty-state is genuinely among the best captured; its failed-hop handling (attention item with "Open the request to retry or cancel") is real. Replit covers more terminal states publicly (Cancelled/Archived, `replit-docs-task-lifecycle.txt`) and Claude catalogs failure modes in docs (`claude-docs-agent-view.txt`); the office's in-scene error affordance is thinner — a failed hop does not visibly mark a desk in the office-scene captures (inference from `live/f-10-office-failed.png`, which shows the Projects surface, not the scene).
7. **Accessibility** — Baseline evidence is visual only. Observable defect: **mixed-locale timestamps** — the office feed renders "오전 4:45" in `live/live-20-settled-office.png` and "9월 30일 오전 4:35" in `live/f-11-attention-panel.png` inside an otherwise en-US UI (OS locale leaking into display). The bespoke isometric scene's screen-reader story cannot be verified from screenshots (inference: canvas/div scenes typically need a parallel accessible list — none evidenced). Comparators mostly inherit platform a11y (GitHub, VS Code-derived Cursor; Claude's keyboard-native TUI). **Comparators likely better; the office needs an a11y pass plus a locale-consistency fix.**

## 5. Proposed revision packet seeds (ranked by expected impact)

1. **Attention-first grouped work queue.** Problem: agent status on the Office page is ambient, not actionable — no grouped queue of blocked/failed/needs-input/working items (`live/live-20-settled-office.png`). Evidence: `swipe/worker-6/ddocs-agent-command-center.png` (Kanban by status, blocked column), `swipe/worker-6/claude-docs-agent-view.txt` (needs-you sessions pinned to top), `swipe/worker-6/replit-docs-task-board.png`; baseline `drafts/organizer/ui-baseline/live/f-11-attention-panel.png` already has the seed of it. Rough scope: renderer office/attention surfaces — group the NEEDS YOU feed and per-seat captions into a ranked queue with per-item age; keep the scene as the ambient layer. Do not break the verified/reported label vocabulary.
2. **Provider-evidence step log in the activity feed.** Problem: the office chat feed shows one prose line per hop ("Brief draft in progress: …", `live/live-20-settled-office.png`) — comparators attach structured evidence per step. Evidence: `swipe/worker-6/devin-docs-session-tools.txt` (all commands/edits/browser actions in one unified, time-navigable log), `swipe/worker-6/jules-docs-running-tasks.txt` (activity feed + inline explanation + mini diff per file), `swipe/worker-6/gh-agent-management.txt` (live session log). Rough scope: renderer feed-item component + provider-job record — expandable step rows typed by action (command/edit/file/test) and tagged office-observed vs provider-reported, preserving the provenance split already proven in `live/live-24-history.png`.
3. **Explicit request lifecycle: finished ≠ applied.** Problem: the request row's two statuses ("Status: ready" + "Provider job: failed", `live/f-20-project-detail.png`) are honest but flat — no explicit lifecycle (planned → running → provider-finished → applied/verified → done) like Replit's seven-state model. Evidence: `swipe/worker-6/replit-docs-task-lifecycle.png` + `.txt`; partial precedent in `live/f-10-office-failed.png`. Rough scope: request status display in Projects/request detail + attention-panel phrasing; clarifies what "ready" means next to a failed provider job without touching the record schema (display-layer proposal).
4. **Locale-consistent timestamp rendering.** Problem: OS-locale (Korean) timestamps render inside an en-US UI ("오전 4:45", `live/live-20-settled-office.png`; "9월 30일 오전 4:35", `live/f-11-attention-panel.png`) — a visible polish/honesty-of-presentation defect. Evidence: those baseline artifacts; comparators n/a. Rough scope: shared datetime formatter + the feed/attention call sites; cheapest seed here.
5. **Steer/pause affordance on active seats.** Problem: live seats offer observation only; every serious comparator offers mid-run input — Jules pause + mid-task feedback (`swipe/worker-6/jules-docs-running-tasks.txt`), Copilot steer mid-session (`swipe/worker-6/gh-agent-management.txt`), Devin IDE takeover + side chats (`swipe/worker-6/devin-docs-session-tools.txt`), Cascade queued messages (`swipe/worker-6/ddocs-cascade.txt`). Baseline: `live/live-20-settled-office.png` "Working · 29s" seat. Rough scope: seat popover/request detail action row (packet depends on what the provider transport actually supports — organizer to scope).

## 6. Gaps and honesty notes

- **No authenticated surfaces.** app.devin.ai, the GitHub repo Agents tab in a logged-in session, jules.google.com's app UI, and cursor.com's in-product UI were not captured — comparators are judged from public docs/marketing captures plus the product screenshots embedded in them. Where a claim rests on docs prose rather than a visible UI, it cites the `.txt` artifact; where it rests on an embedded screenshot, it cites the `.png`.
- **openai.com blocked capture** (client-side "This page couldn't load", HTTP 200 — `swipe/worker-6/openai-codex.png`, `openai-codex-intro.png`). Codex coverage is therefore partial (developer-docs surfaces only) and every Codex score is inference-flagged.
- **Redirects encountered and kept as evidence:** `windsurf.com` → Devin Desktop marketing (`windsurf-home.png`); `docs.windsurf.com` → `docs.devin.ai/desktop/*` (`windsurf-docs-home.txt` FINAL-URL; four `windsurf-docs-*.png` 404s superseded by `ddocs-*.png`); `docs.cursor.com` → `cursor.com/docs` (six duplicate `cursor-docs-*.png` landing captures superseded by `cursor-doc-*.png`); `gh-coding-agent-howto` → `…/use-copilot-agents/cloud-agent`.
- **Marketing/docs bias.** Embedded product screenshots in docs may be staged renders; docs describe intended behavior, not observed behavior. Scores reflect the *status model as documented*, not verified runtime behavior.
- **`claude-docs-agent-view.png` rendered poorly** (dense docs page squashed in full-page capture); the `.txt` is the primary evidence for that comparator and is cited as such.
- **Locale artifacts in baseline:** the Korean timestamps noted in §4.7 come from the organizer's captured baseline, not my captures — flagged as a baseline defect finding, not a capture artifact. (Cursor's cookie banner also rendered in Korean on this machine — geo/locale detection, unrelated.)
- **Nothing outside `records/reviews/ui-benchmark-1/w6-agentic.md` was modified** in the checkout; all captures live under `swipe/worker-6/` outside Git, plus capture scripts/manifests for provenance.
