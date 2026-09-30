# UI benchmark round `ui-benchmark-1` — worker-7 office self-audit

Date: 2026-09-30, local. Subject build: the packaged `Quant Office\App\` build mirroring `main` `65bddec`, as captured by the organizer in `drafts/organizer/ui-baseline/`. This document scores the office's own UI against the shared seven-dimension rubric using only those captured artifacts — the baseline side of the benchmark. No product code was changed.

## 1. Scope and capture method used per artifact

Scope: every page of the office UI (Office, Agents, Projects, Reviews, Artifacts, Memory, History, Usage, Settings) plus shared chrome (top bar, sidebar, NEEDS YOU panel, status bar, dialogs, command palette), in three workspace states — `empty/` (fresh workspace), `populated/` (seeded project, agents and requests), `live/` (a real dispatched hop across UNKNOWN/RUNNING/FAILED).

Capture method: none of the artifacts were captured by this worker. All 38 PNGs were produced by the organizer before publication (per the round request: Playwright against the packaged build). This worker's method was static image review of each file at native 1783x1034 resolution, byte-level deduplication via `md5sum`, and close crops (System.Drawing) of the sidebar badge and status-bar regions where small text was ambiguous. Suspected copy strings were verified against renderer source (`app/src/renderer/*.tsx`, `app/src/shared/request-summary.ts`) before being reported as defects; every reported item below cites the artifact where it is visible. Static screenshots cannot evidence keyboard focus order, screen-reader announcements, motion or timing — the accessibility column is therefore a lower-bound visual assessment only.

## 2. Artifact inventory

38 files in `drafts/organizer/ui-baseline/`; md5 comparison shows 5 byte-identical pairs, so the set carries **33 distinct images**. Duplicates mean several filename-claimed states were never actually captured (see section 6).

| Artifact | What it shows |
|---|---|
| `empty/empty-00-boot.png` | Byte-identical to `empty-01-office.png` — the fully loaded Office page, not a boot/loading frame. |
| `empty/empty-01-office.png` | Office page, empty workspace: "Set up your office · 0/5" checklist card, isometric scene ("Nobody working right now", "No director seated"), empty Office chat with 5 filters, top bar "Select a project"/"All experiments"/"Go to…"/bell/"0 agents registered", status bar "0 working · 0 need you · 0 agents". |
| `empty/empty-agents.png` | Agents page empty: filter row (Membership/Search/Team/Role/Provider), "0 matching agents · no seat limit", "No agents match these filters" empty state, "Add agent" top-right. |
| `empty/empty-projects.png` | Projects page empty: "0 active projects · 0 archived", lifecycle filter + "Find a project" search, "Every discovery starts with a question" + "Create first project" CTA. |
| `empty/empty-reviews.png` | Reviews empty: generic "A home for your research — Create or select a project…" + "Create project" CTA. Identical copy to Artifacts/Memory empties. |
| `empty/empty-artifacts.png` | Artifacts empty: same generic "A home for your research" block. |
| `empty/empty-memory.png` | Memory empty: same generic block under the honesty subtitle "session and user reports, not provider-verified facts". |
| `empty/empty-history.png` | History: "6 recorded records · showing 6", Activity/Technical events tabs, 4 filters, honesty note "this view does not perform a new chain verification", one collapsed "Office Activity" group, Korean-locale timestamp "9월 30일 오전 4:25" next to English "Sep 30, 2026". |
| `empty/empty-usage.png` | Usage: policy banner, provider cards "Account not checked · 0 active profiles (account not checked)", "Missing values are never estimated", per-card "Refresh usage"/"Open official usage page". |
| `empty/empty-settings.png` | Settings→Connections: 7-section tab row, three provider cards (Claude/OpenAI/Devin) with recorded-observation lines, "Check account", disabled-looking "Verify cloud transport…", "Technical details"/"Advanced · Use my own API key" disclosures. |
| `empty/empty-add-agent.png` | Add Agent full-page 3-step wizard (Profile & permissions → Verify account → Review & confirm): provider/transport/model/effort/role pickers, honest microcopy ("not provider-hosted, isolated or independently attested"), unattended-run consent checkbox paragraph. |
| `empty/empty-command-palette.png` | "Go to…" modal: clipped placeholder "Search pages, projects, re…", flat list of 10 items (9 pages + Add Agent) in an order that differs from the sidebar. |
| `populated/populated-00-boot.png` | Byte-identical to `populated-01-office.png` — no boot frame captured. |
| `populated/populated-01-office.png` | Office populated: seated agents ("Test dir 1", "Test PM A" — "Idle · No open provider work"), top-bar avatar chips D1/PA/W1/C1, "4 agents registered", chat empty state, status bar "0 working · 0 need you · 4 agents". |
| `populated/populated-agents.png` | Agents table, 4 rows: NAME / TEAM·ROLE / PROVIDER·MODEL·EFFORT / ACCOUNT ("▸ Local CLI", "▸ Hosted setup") / STATUS ("Idle"), "Profile & logs" + "Archive agent" row actions, "4 matching agents · no seat limit". |
| `populated/populated-projects.png` | Projects: "1 active projects · 0 archived", card "Volatility research" with mandate, "Not selected", "5 requests", "0 findings · Just now", "Active" chip, "Open project ↗". |
| `populated/populated-reviews.png` | Reviews gated: "Choose a project — This page shows one project at a time" + lone "Volatility research" button. |
| `populated/populated-artifacts.png` | Artifacts: same "Choose a project" gate. |
| `populated/populated-memory.png` | Memory: same "Choose a project" gate. |
| `populated/populated-history.png` | History: "18 recorded records · showing 14", groups "Volatility Research" ("7 loaded updates · Sep 30, 2026") and "Office Activity" ("7 loaded updates"), Korean-locale timestamps. |
| `populated/populated-usage.png` | Usage populated: "Account not checked · 1 active profiles (account not checked)" per card. |
| `populated/populated-settings.png` | Settings identical to empty set (connections are workspace-independent). |
| `populated/populated-add-agent.png` | Add Agent wizard identical to empty set. |
| `populated/populated-command-palette.png` | Palette gains an 11th item "Project · Volatility research"; placeholder still clipped. |
| `populated/populated-new-request.png` | "New request" modal: name/objective/project/work type/director fields, "the pipeline arms launch only after you confirm the shaped brief" helper. |
| `live/live-10-running-office.png` | Byte-identical to `live-11-running-agents.png` — the running office scene was never captured under this name. |
| `live/live-11-running-agents.png` | Agents during dispatched hop (UNKNOWN phase): Test dir 1 "Unknown" chip + truncated "Volatility estimat…" pill; sidebar badge "1" on Office; bell badge "1"; "8 agents registered"; status bar "0 working · 1 need you · 8 agents". |
| `live/live-20-settled-office.png` | Office mid-work (RUNNING): scene header "1 working now", Test dir 1 "Working · 29s" on "Volatility estimate baseline", PM desks "Idle · No open provider work"; chat "1 participants · All projects" with "Test dir 1 is working · provider-reported activity" card, Korean time "오전 4:45"; D1 avatar with active ring; status bar "1 working · 0 need you · 8 agents"; no sidebar badge. |
| `live/live-24-history.png` | History during run: "44 recorded records · showing 36"; "Volatility Research" group "Observation recorded: result.json cannot be trusted: it repeats or rewinds sequence 1 — the last verified receipt … (hash 58b46dbe…) — a receipt must advance" ("22 loaded updates"); "Office Activity" "Office-observed transport evidence for claude via local mailbox: local observer … Office observation is not provider attestation" ("14 loaded updates"). |
| `live/live-25-reviews.png` | Reviews still "Choose a project" while a request runs on the only project. |
| `live/live-26-artifacts.png` | Artifacts still gated mid-run. |
| `live/live-27-usage.png` | Usage unchanged during run ("1 working" in status bar). |
| `live/live-28-memory.png` | Memory still gated mid-run. |
| `live/f-10-office-failed.png` | Project detail (FAILED state): project selector "Volatility research" + "All experiments" filter; project-scoped tab row (Memory/Artifacts/Reviews + "No activity recorded" + D1 chip); request list with "A Step Failed" chip on expanded "Volatility estimate baseline" ("Status: ready", "Provider job: failed", "Open request"); "Register a research branch" disclosure; status bar "0 working · 1 need you · 1 failed lately · 8 agents". Filename says "office" but the shot is the project page. |
| `live/f-11-attention-panel.png` | Same view with NEEDS YOU dropdown open: "Request / Volatility estimate baseline — A step failed — Open the request to retry or cancel the failed step." |
| `live/f-20-project-detail.png` | Project detail top: "Back to projects", PROJECT MANDATE card ("Edit project", "Archive project", "+ New request"), stat cards "5 Requests · 0 Open decisions · 0 Findings · 0 Imported files", record-link tab row, request list. |
| `live/f-20-project-detail-full.png` | Byte-identical to `f-20-project-detail.png` — the "full" scroll capture did not happen. |
| `live/f-21-request-open.png` | Byte-identical to `f-10-office-failed.png` — no open request-detail artifact exists. |

## 3. Per-page × dimension scorecard

Scores 1–5 (5 = shipped-product quality). Each cell cites one primary artifact; supporting artifacts follow per row. Dimensions abbreviated: **DEN** information density · **NAV** navigation model · **QUE** queue/status UX · **PRE** presence and notifications · **HON** status honesty · **ELE** empty/loading/error states · **ACC** accessibility (visual-only lower bound).

| Page | DEN | NAV | QUE | PRE | HON | ELE | ACC |
|---|---|---|---|---|---|---|---|
| Office | 4 · `live/live-20-settled-office.png` | 4 · `empty/empty-01-office.png` | 4 · `live/live-20-settled-office.png` | 4 · `populated/populated-01-office.png` | 5 · `live/live-20-settled-office.png` | 4 · `empty/empty-01-office.png` | 3 · `populated/populated-01-office.png` |
| Agents | 4 · `populated/populated-agents.png` | 4 · `populated/populated-agents.png` | 4 · `live/live-11-running-agents.png` | 3 · `live/live-11-running-agents.png` | 4 · `live/live-11-running-agents.png` | 2 · `empty/empty-agents.png` | 3 · `populated/populated-agents.png` |
| Projects | 3 · `populated/populated-projects.png` | 4 · `populated/populated-projects.png` | 3 · `live/f-20-project-detail.png` | 2 · `populated/populated-projects.png` | 4 · `live/f-10-office-failed.png` | 5 · `empty/empty-projects.png` | 3 · `populated/populated-projects.png` |
| Reviews | 1 · `live/live-25-reviews.png` | 2 · `populated/populated-reviews.png` | 1 · `live/live-25-reviews.png` | 1 · `live/live-25-reviews.png` | 3 · `empty/empty-reviews.png` | 2 · `populated/populated-reviews.png` | 3 · `empty/empty-reviews.png` |
| Artifacts | 1 · `live/live-26-artifacts.png` | 2 · `populated/populated-artifacts.png` | 1 · `live/live-26-artifacts.png` | 1 · `live/live-26-artifacts.png` | 3 · `empty/empty-artifacts.png` | 2 · `populated/populated-artifacts.png` | 3 · `empty/empty-artifacts.png` |
| Memory | 1 · `live/live-28-memory.png` | 2 · `populated/populated-memory.png` | 1 · `live/live-28-memory.png` | 1 · `live/live-28-memory.png` | 4 · `empty/empty-memory.png` | 2 · `populated/populated-memory.png` | 3 · `empty/empty-memory.png` |
| History | 4 · `live/live-24-history.png` | 4 · `live/live-24-history.png` | 3 · `live/live-24-history.png` | 1 · `live/live-24-history.png` | 5 · `live/live-24-history.png` | 3 · `empty/empty-history.png` | 3 · `live/live-24-history.png` |
| Usage | 3 · `empty/empty-usage.png` | 3 · `empty/empty-usage.png` | 3 · `populated/populated-usage.png` | 1 · `live/live-27-usage.png` | 5 · `empty/empty-usage.png` | 4 · `empty/empty-usage.png` | 4 · `empty/empty-usage.png` |
| Settings | 4 · `populated/populated-settings.png` | 4 · `populated/populated-settings.png` | 4 · `populated/populated-settings.png` | 1 · `populated/populated-settings.png` | 5 · `populated/populated-settings.png` | 4 · `empty/empty-settings.png` | 3 · `populated/populated-settings.png` |
| Shared chrome | 4 · `live/f-11-attention-panel.png` | 4 · `empty/empty-command-palette.png` | 4 · `live/f-10-office-failed.png` | 4 · `live/live-11-running-agents.png` | 4 · `live/f-11-attention-panel.png` | 4 · `live/f-11-attention-panel.png` | 3 · `empty/empty-command-palette.png` |

Row notes:
- **Office** — the scene and chat carry real state ("Working · 29s", "provider-reported activity", "Nobody working right now"); density is good but the illustrative scene spends ~55% of the content width on a picture. Chat's 5 filters are the densest controls in the app. Supporting: `empty/empty-01-office.png`, `populated/populated-01-office.png`.
- **Agents** — a proper table with five filters and honest "Unknown" chips; pulled down by the misdiagnosed first-run empty state. Supporting: `live/live-11-running-agents.png`.
- **Projects** — card + detail view is honest ("Not selected", "Provider job: failed") but thin at one project; detail page is the only place experiment/request state aggregates. Supporting: `live/f-10-office-failed.png`, `live/f-20-project-detail.png`.
- **Reviews / Artifacts / Memory** — never captured with content: the only artifacts show the "Choose a project" gate, so queue/status/presence score 1 by absence, not by observed badness. Memory's honesty subtitle lifts its HON score.
- **History** — strongest honesty copy in the product ("does not perform a new chain verification", hash receipts, "not provider attestation"); loses density/nav points to silent truncation ("showing 36" of 44) and mixed-locale timestamps.
- **Usage / Settings** — honest-by-default pages; low PRE scores reflect absence of presence surfaces rather than defects.
- **Shared chrome** — status bar ("N working · N need you · N failed lately · N agents"), sidebar `needsYou` badge (hidden at 0 — verified consistent in `live/live-20-settled-office.png` vs `live/live-11-running-agents.png`), NEEDS YOU panel with actionable reason, palette, and two dialogs (Add Agent wizard, New request). Cost: clipped palette placeholder and order mismatch.

## 4. Strongest and weakest evidence per dimension

The shared section-4 shape asks for dimension-level comparison; for a self-audit that becomes: the baseline artifact that makes each dimension look best, and the one that makes it look worst.

| Dimension | Strongest evidence | Weakest evidence | Verdict |
|---|---|---|---|
| Information density | `live/live-24-history.png` — grouped subjects, per-group update counts, hash-bearing event copy | `live/live-25-reviews.png` — a full page spent on one sentence and one button | Bimodal: record surfaces are dense and information-rich; the three project-gated pages are near-empty by construction. |
| Navigation model | `live/f-20-project-detail.png` — breadcrumb + mandate + record tabs + list in one project context | `empty/empty-command-palette.png` — clipped placeholder, flat order diverging from sidebar grouping | The two-axis model (global pages × project scope) is legible, but identical labels (Reviews/Artifacts/Memory) name two different scopes, and the palette is a weak second route. |
| Queue/status UX | `live/f-10-office-failed.png` — request rows with Canceled/Draft/failed chips, expanded "Status: ready / Provider job: failed" split | `live/live-25-reviews.png` — zero queue visibility on a page that exists to review work | The project detail page is a real work queue; the global pages don't participate in it. |
| Presence and notifications | `live/f-11-attention-panel.png` — NEEDS YOU panel names the item, its reason and its remedy; bell + sidebar badges + taskbar setting agree | `live/live-27-usage.png` — system pages contribute nothing to presence | Coherent attention model (needs-you count drives bell, sidebar badge and status bar); it just stops at the chrome. |
| Status honesty | `live/live-24-history.png` — "Office observation is not provider attestation", "result.json cannot be trusted … a receipt must advance" | `empty/empty-agents.png` — "No agents match these filters" misreports a zero-state as a filter miss | The product's signature strength. Verified vs self-reported vs unknown is distinguished in copy everywhere; the few lapses are copy bugs, not model gaps. |
| Empty/loading/error states | `empty/empty-projects.png` — named empty state with primary CTA | `empty/empty-agents.png` — filter-shaped empty state with no CTA and wrong diagnosis | Three different empty-state strategies (CTA, filter-miss, generic block) with inconsistent quality; no loading state was captured at all. |
| Accessibility | `empty/empty-add-agent.png` — fully labeled form, visible step rail, explicit consent text | `populated/populated-agents.png` — bare "▸" disclosure affordances, truncated pills, small chip text | Labels and aria strings exist in source (e.g. `aria-label` on the needs-you bell), but icon-only controls, clipped placeholders and canvas-drawn scene labels limit what static evidence can certify. |

## 5. Findings — discrete defects and frictions

Each finding cites the artifact(s) where it is visible. Suspected strings were verified in renderer source before listing; severity is judged visually.

**Copy and grammar**

1. "N matching agents · no seat limit" claims a filtered result even when no filter is set; on an empty workspace it reads "0 matching agents". `empty/empty-agents.png`, `populated/populated-agents.png`.
2. Plural slips: "1 active projects" (`populated/populated-projects.png`), "1 participants" (`live/live-20-settled-office.png` chat header), "1 active profiles" (`populated/populated-usage.png`, `live/live-27-usage.png`).
3. "N recorded records" stutters — "6 recorded records · showing 6", "44 recorded records · showing 36". `empty/empty-history.png`, `live/live-24-history.png`.
4. Redundant parenthetical: "Account not checked · 1 active profiles (account not checked)". `populated/populated-usage.png`.
5. "the pipeline arms launch only after you confirm the shaped brief" — "pipeline arms" is ambiguous phrasing in a readiness-critical helper. `populated/populated-new-request.png`.
6. "A Step Failed" chip carries a leading article and title case beside single-word siblings ("Draft", "Canceled", "Ready"). `live/f-10-office-failed.png`.

**Empty-state strategy**

7. Agents first-run empty state misdiagnoses: "No agents match these filters — Adjust the … filters" on a workspace with zero agents and zero filters applied; no CTA. `empty/empty-agents.png`.
8. One generic empty block — "A home for your research — Create or select a project to organize experiments, requests, and evidence" — serves Reviews, Artifacts and Memory verbatim; page-blind copy. `empty/empty-reviews.png`, `empty/empty-artifacts.png`, `empty/empty-memory.png`.
9. CTA asymmetry: Projects' empty state embeds "Create first project"; Agents' offers nothing; History shows global records with no empty state at all. `empty/empty-projects.png`, `empty/empty-agents.png`, `empty/empty-history.png`.

**Navigation and project scope**

10. Project-gated pages dead-end: Reviews/Artifacts/Memory render only "Choose a project" + a bare project-name button; the sole existing project is never auto-selected, and the pages stay blank even while a request runs on it. `populated/populated-reviews.png`, `live/live-25-reviews.png`, `live/live-26-artifacts.png`, `live/live-28-memory.png`.
11. Duplicate labels, different scopes: sidebar "Reviews/Artifacts/Memory" are global pages, while an identically named tab row inside project detail is project-scoped — same words, two meanings. `live/f-20-project-detail.png` vs `live/live-25-reviews.png`.
12. Command palette placeholder is clipped mid-word ("Search pages, projects, re…") and its flat item order does not match the sidebar's grouped order. `empty/empty-command-palette.png`, `populated/populated-command-palette.png`.
13. "All experiments" dropdown renders in the top bar even with no project selected — an inert control in the default state. `empty/empty-01-office.png`.
14. Page eyebrow inconsistency: Office shows "YOUR RESEARCH WORKSPACE"; every other page shows "QUANT RESEARCH OFFICE". `empty/empty-01-office.png` vs `empty/empty-agents.png`.

**Status and attention surfaces**

15. Status-bar's third counter is unlabeled: "8 agents" counts registered agents but sits beside verb-phrase counters "working / need you / failed lately". `live/live-11-running-agents.png`.
16. History truncates silently: "44 recorded records · showing 36" with no visible load-more control. `live/live-24-history.png`.
17. Mixed-locale timestamps: Korean "9월 30일 오전 4:45" beside English "Sep 30, 2026" in the same lists and chat cards. `empty/empty-history.png`, `live/live-24-history.png`, `live/live-20-settled-office.png`.
18. Agents row truncates the active-request pill mid-word ("Volatility estimat…") with no visible tooltip. `live/live-11-running-agents.png`.
19. Icon-only affordances: the bell renders its badge as a bare numeral; project cards carry an unlabeled icon button; scene seat labels are illustration-scaled. `populated/populated-01-office.png`, `populated/populated-projects.png`.
20. Disabled-looking "Verify cloud transport…" button on the Claude card shows no reason for its state. `populated/populated-settings.png`.
21. Usage refresh is per-card only — three cards, three separate "Refresh usage" buttons, no refresh-all. `empty/empty-usage.png`.
22. "Search loaded messages" in Office chat honestly scopes to loaded messages but reads as full-history search. `empty/empty-01-office.png`.

## 6. Ranked revision packet seeds

Proposals only — no roadmap edits, no product changes. Ranked by expected impact on the audit's weakest cells (project-scoped pages and empty states score lowest).

1. **Project context that follows the user** — auto-select the sole project (and remember the last selection) on Reviews/Artifacts/Memory; replace the bare "Choose a project" button with an inline picker that also surfaces the project's live state. Evidence: `live/live-25-reviews.png`, `live/live-26-artifacts.png`, `live/live-28-memory.png`, `populated/populated-projects.png` ("Not selected"). Rough scope: `app/src/renderer` project-scope state + the three gated pages' guard component.
2. **One empty-state contract** — page-specific title, one-line value proposition and one primary CTA for every empty state; fix the Agents misdiagnosis ("workspace has no agents" vs "filters matched nothing") and retire the generic "A home for your research" block. Evidence: `empty/empty-agents.png`, `empty/empty-reviews.png`, `empty/empty-artifacts.png`, `empty/empty-memory.png`, `empty/empty-projects.png` (the good model). Rough scope: shared empty-state component + per-page copy.
3. **Copy and pluralization pass** — fix "1 active projects"/"1 participants"/"1 active profiles", "recorded records", the "(account not checked)" duplication, "matching agents" when unfiltered, "pipeline arms", "A Step Failed" casing. Evidence: `populated/populated-projects.png`, `live/live-20-settled-office.png`, `populated/populated-usage.png`, `live/live-24-history.png`, `populated/populated-new-request.png`, `live/f-10-office-failed.png`. Rough scope: `app/src/renderer` copy strings + a pluralization helper.
4. **History honesty without the gaps** — add a load-more/pagination affordance beyond "showing N", pin timestamps to the UI locale, and split "recorded records" into "N events · showing M". Evidence: `live/live-24-history.png`, `empty/empty-history.png`. Rough scope: `history.tsx` list footer + date formatter.
5. **Command palette as a real second route** — widen the input (or shorten the placeholder), order items to match sidebar grouping, add recent projects/requests. Evidence: `empty/empty-command-palette.png`, `populated/populated-command-palette.png`. Rough scope: the palette modal component.
6. **Label the status bar's agent counter and disambiguate duplicate tab labels** — "8 agents" → "8 registered"; consider scoping project-detail tab labels (e.g. "Project reviews") or merging the two navigation layers. Evidence: `live/live-11-running-agents.png`, `live/f-20-project-detail.png`, `live/live-25-reviews.png`. Rough scope: `main.tsx` status bar + `research.tsx` tab row labels.
7. **Truncation and icon-only affordances** — tooltips/aria text for the request pill, project-card icon button and clipped strings; revisit "Volatility estimat…" truncation. Evidence: `live/live-11-running-agents.png`, `populated/populated-projects.png`. Rough scope: table cell + icon-button components.

## 7. Gaps and honesty notes

- **Five byte-identical duplicate pairs** (md5-verified) reduce 38 files to 33 distinct images: `empty-00-boot`=`empty-01-office`, `populated-00-boot`=`populated-01-office`, `live-10-running-office`=`live-11-running-agents`, `f-20-project-detail`=`f-20-project-detail-full`, `f-10-office-failed`=`f-21-request-open`. Consequences: **no boot/loading-state evidence exists**; the **running office scene in the UNKNOWN phase was not captured** (live-10 is the Agents page); the **open request-detail surface has no artifact** (f-21 duplicates the project page). Scores for those surfaces rest on adjacent evidence.
- **Filename-vs-content mismatch:** `f-10-office-failed.png` depicts the project detail page, not the office page; `live-20-settled-office.png` depicts a RUNNING state ("1 working"), not a settled one. The audit cites what each file shows, not what its name implies.
- **Static-image limits:** accessibility scores are a visual lower bound — keyboard traversal, focus rings, screen-reader output and motion are unevidenced; contrast was judged at 1783px without pixel measurement. Live timing ("Working · 29s") is a single frame, not a latency claim.
- **States never exercised in evidence:** no Reviews/Artifacts/Memory content anywhere (always gated), no multi-project workspace, no archived rows, no Technical-events tab, no populated chat threads beyond one running card, no request-detail page, no settings sections other than Connections.
- **Source verification:** reported strings were cross-checked against `app/src/renderer` and `app/src/shared/request-summary.ts` at base `65bddec` to avoid citing rendering artifacts as copy defects (e.g. the top-bar "Subscription usage" label is correctly spelled in source — its small-size rendering is not a typo). Reading source does not change the evidentiary basis: every finding cites the screenshot where it is visible.
- No live-provider, network, paid or user-data operations were run; the audit consumed only the organizer's committed baseline artifacts.
