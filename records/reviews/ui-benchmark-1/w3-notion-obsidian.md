# ui-benchmark-1 — worker-3: Notion + Obsidian comparator study

Round: `ui-benchmark-1` · Base: `65bddec303aadd95fb21585c7a48a8685bf3c8d8` · Focus: records UX (databases, pages, properties), graph/backlink navigation, information density.

Path prefixes used below:

- `swipe/worker-3/` → `C:\Users\louis\Desktop\AI\Quant Office\repo-sessions\next-batch-001\swipe\worker-3\` (outside Git, reference-only)
- `ui-baseline/` → `C:\Users\louis\Desktop\AI\Quant Office\repo-sessions\next-batch-001\drafts\organizer\ui-baseline\` (office baseline, packaged build mirroring `65bddec`)

## 1. Scope and capture method

Comparators: **Notion** (records UX leader — databases, pages, typed properties, views) and **Obsidian** (graph/backlink navigation leader — graph view, backlinks, Bases tables). All artifacts were captured by source method **(a) direct free capture via Playwright** (`app/node_modules/playwright` 1.63.0, system headless Chromium shell build 1243, viewport 1560×900 plus full-page variants) on public docs/marketing pages on 2026-09-30. Per-file URLs, HTTP statuses and timestamps are recorded in `swipe/worker-3/manifest.json`. No MCP reports or pattern galleries were needed; nothing was purchased or paywalled.

Notes on method coverage:

- First-pass URLs `notion.com/help/databases`, `/help/database-views`, `/help/links-and-backlinks`, `/help/notifications-and-reminders` and `help.obsidian.md/graph-view` returned 404 (help-center restructures). Corrected paths were re-captured; stale 404 artifacts were overwritten so every cited file is a real 200 page.
- These are help/marketing surfaces showing embedded product screenshots and authored product descriptions — not live authenticated product sessions. Where a claim rests on doc copy rather than a rendered UI surface, it is labeled *(inference)*.
- Korean-language locale banners and a cookie-consent overlay appear in Notion captures (capture host locale); they are environment artifacts, not Notion UI.

## 2. Artifact inventory

| Artifact | What it shows |
| --- | --- |
| `swipe/worker-3/notion-help-intro-to-databases.png` (+ `-full.png`) | Notion Help "Intro to databases": embedded *Projects Database* screenshot — view tabs (All launches / Feed / Timeline / Status) over a table with Feature / Owner / Status / Priority columns, status pills and person avatars |
| `swipe/worker-3/notion-help-database-properties.png` (+ `-full.png`) | Property-type catalog: Text, Number, Select, **Status (To-do / In Progress / Complete)**, Multi-select, Date, Person, Files, Checkbox, URL, Email, Phone, Formula, Relation, Rollup, timestamps |
| `swipe/worker-3/notion-help-views-filters-sorts.png` (+ `-full.png`) | Views doc: table/board/timeline/calendar/list/gallery/chart layouts of one dataset; filter, sort and group controls; linked views of other databases |
| `swipe/worker-3/notion-help-links-and-backlinks.png` (+ `-full.png`) | Backlinks mechanics: auto-created on @-mention; "Linked to this page" section listing source pages (Expense Policy → Team Home etc.); private backlink labeling |
| `swipe/worker-3/notion-help-collaborate.png` (+ `-full.png`) | Real-time collaboration: profile photos show where teammates are working; edits appear instantly; per-change highlighting (blue added, gray strikethrough removed) |
| `swipe/worker-3/notion-help-notifications.png` (+ `-full.png`) | Inbox & notifications: sidebar Inbox with red badge (mentions) vs grey badge (updates), filters (Unread / Archived / All workspace updates), per-page notification settings, archive, Agent-assisted inbox triage |
| `swipe/worker-3/notion-help-sidebar.png` (+ `-full.png`) | Sidebar navigation: workspace switcher, Search / Home / Notion AI / Inbox top level, Teamspaces / Private / Shared sections, nested page tree |
| `swipe/worker-3/notion-product-projects.png` (+ `-full.png`) | Marketing hero for Notion Projects — illustration-level only, used for positioning claims not UI evidence |
| `swipe/worker-3/notion-help-keyboard-shortcuts.png` (+ `-full.png`) | Full keyboard reference: desktop shortcuts, Markdown-style input, `@` `[[` `+` commands, slash commands ("everything without touching your mouse") |
| `swipe/worker-3/obsidian-home.png` (+ `-full.png`) | obsidian.md product page embedding the real app: file-explorer sidebar, tabbed editor, inline tags, a local-graph panel, mobile companion |
| `swipe/worker-3/obsidian-help-graph-view.png` (+ `-full.png`) | Graph view doc + the help site's own live **INTERACTIVE GRAPH** widget (nodes sized by link count, click-to-open, powered by Obsidian Publish) |
| `swipe/worker-3/obsidian-help-backlinks.png` (+ `-full.png`) | Backlinks doc: linked vs **unlinked** mentions, collapse/expand, "show more context", sort order — plus the same interactive graph widget and a "LINKS TO THIS PAGE" footer rendered on the docs page itself |
| `swipe/worker-3/obsidian-help-properties.png` (+ `-full.png`) | Properties doc: typed frontmatter properties (Text, List, Number, Checkbox, Date, Date & time) with dedicated UI editor and `Ctrl+;` hotkey |
| `swipe/worker-3/obsidian-help-status-bar.png` (+ `-full.png`) | Status bar doc: `"2 backlinks  |  edit-mode icon  |  89 words  |  558 characters"` — plugin-extensible status strip; Sync plugin icon reports sync state on click |
| `swipe/worker-3/obsidian-help-bases.png` (+ `-full.png`) | **Bases** (new core plugin): embedded real vault screenshot — sidebar listing 15 bases, "Books" table with `To-read · 30 results` filter chip, Title/Author/Year/Genre columns, Sort/Filter/Properties toolbar, column-picker panel with "Add formula", status bar "4 backlinks · 158 words"; data stored in local Markdown + `.base` files |
| `swipe/worker-3/obsidian-help-canvas.png` (+ `-full.png`) | Canvas doc: spatial 2-D layout of notes on an open `.canvas` JSON format |
| `swipe/worker-3/obsidian-plugins.png` (+ `-full.png`) | Community plugin registry: "Browse 8,241 plugins and 843 themes", Popular / New / Updated lists, `Ctrl K` search |
| `swipe/worker-3/manifest.json` | Machine-readable capture log: file → URL → HTTP status → title → timestamp → method `a-playwright` |

## 3. Comparator scorecard

Scores are 1–5 against the round rubric. Citations name the artifact the claim rests on.

### Notion

| Dimension | Score | Evidence |
| --- | --- | --- |
| Information density | **4** | Database tables pack ~8 rows × 4 typed columns plus view tabs into a single card-width strip (`notion-help-intro-to-databases.png`, `notion-help-views-filters-sorts.png`); density is high but still card-padded compared to a true grid tool. |
| Navigation model | **4** | Sidebar tree with workspace switcher and Teamspaces/Private/Shared sections (`notion-help-sidebar.png`); automatic backlinks surface inbound references under every page title (`notion-help-links-and-backlinks.png`); breadcrumbs in embedded screenshots. Docked one point: deep nesting buries records and there is no map/graph view (absence is visible across all nav artifacts). |
| Queue/status UX | **3** | First-class Status property (To-do / In Progress / Complete) plus board/timeline/grouped views model a manual work queue well (`notion-help-database-properties.png`, `notion-help-views-filters-sorts.png`). Nothing automatic: status is user-set, no job lifecycle, no failed-state surfacing beyond a property value. |
| Presence and notifications | **5** | Live presence avatars and instant-edit indicators (`notion-help-collaborate.png`); full Inbox — red mention badge vs grey update badge, per-page notification settings, unread/archived filters, Agent-assisted triage (`notion-help-notifications.png`). Best-in-class for this rubric. |
| Status honesty | **2** | No captured artifact distinguishes verified vs self-reported vs unknown state; sync is implicit and invisible in docs *(inference — no UI evidence of provenance labeling)*. |
| Empty/loading/error states | **2** | No captured artifact shows skeletons, error banners or designed empty wells in the product *(inference — docs copy does not evidence these surfaces)*. |
| Accessibility | **3** | Comprehensive published keyboard model — desktop shortcuts, Markdown input, `@`/`[[`/`+`/slash commands (`notion-help-keyboard-shortcuts.png`). Screen-reader and contrast behavior not evidenced *(inference)*. |

### Obsidian

| Dimension | Score | Evidence |
| --- | --- | --- |
| Information density | **5** | The Bases screenshot simultaneously renders a 15-item base sidebar, a ~15-row × 4-column table, an active filter chip (`To-read · 30 results`), a Sort/Filter/Properties toolbar, a column-picker with formulas and a status bar (`obsidian-help-bases-full.png`). The editor chrome is minimal and even the status strip carries data (`obsidian-help-status-bar.png`). |
| Navigation model | **5** | Strongest in class for record-link traversal: graph view (local + global), backlinks with *unlinked* mentions, outgoing links, tabs, file explorer, command palette (`obsidian-help-graph-view.png`, `obsidian-help-backlinks.png`, `obsidian-home.png`). The docs site itself ships a working interactive graph widget — the navigation model is literally embedded in its documentation. |
| Queue/status UX | **1** | No work-queue or job-lifecycle concept exists; status equals note properties/tasks via community plugins at best (`obsidian-plugins.png` shows the ecosystem that would have to supply it). |
| Presence and notifications | **1** | Single-player local-first tool: no inbox, presence or push model in any artifact; the only ambient signal is a sync-state icon in the status bar (`obsidian-help-status-bar.png`). |
| Status honesty | **3** | Everything shown is local Markdown ground truth — there is nothing to misreport, and the Sync plugin icon exposes sync state and its log on click (`obsidian-help-status-bar.png`); Bases doc states plainly "all the data … is stored in your local Markdown files" (`obsidian-help-bases.png`). No verified/self-reported distinction because no external provider claims exist to verify. |
| Empty/loading/error states | **2** | Little captured evidence: docs list file-recovery as a core plugin in the nav (`obsidian-help-backlinks.png` sidebar), and the help site's own 404 page appeared during capture (not retained as an artifact — overwritten on the corrected re-capture). *(inference)* |
| Accessibility | **2** | Hotkey model documented (`obsidian-help-properties.png`, `obsidian-help-status-bar.png`) and the docs site is semantic HTML, but the core UI is a custom-rendered workspace (canvas/graph surfaces in `obsidian-home.png`, `obsidian-help-canvas.png`) with historically weak screen-reader support *(inference — not evidenced in artifacts)*. |

## 4. Office comparison

For each dimension: the baseline artifact that is the strongest (or weakest) evidence, and who does it better.

| Dimension | Baseline evidence | Verdict |
| --- | --- | --- |
| Information density | `ui-baseline/populated/populated-projects.png` (one card row on a 1783-px canvas) and `ui-baseline/live/f-20-project-detail.png` (~3 request rows + chip strip); densest office surface is `ui-baseline/populated/populated-history.png` (~14 grouped records + filter bar). | **Both comparators win.** Notion packs typed columns and view tabs (`swipe/worker-3/notion-help-views-filters-sorts.png`) and Bases packs table + filter chip + property picker + status bar into one pane (`swipe/worker-3/obsidian-help-bases-full.png`). The office spends a viewport on what the comparators show in a strip. |
| Navigation model | `ui-baseline/populated/populated-projects.png` sidebar (flat 9-item grouped nav) + `ui-baseline/live/f-20-project-detail.png` cross-record chips (Memory / Artifacts / Reviews / agent). | **Obsidian wins on the record-link axis this packet owns** — real backlink enumeration and an interactive graph (`swipe/worker-3/obsidian-help-backlinks.png`, `swipe/worker-3/obsidian-help-graph-view.png`) vs the office's chips that assert links exist but don't show *what links here*. Notion's tree ≈ office's sidebar in depth (`swipe/worker-3/notion-help-sidebar.png`), but Notion adds automatic backlinks (`swipe/worker-3/notion-help-links-and-backlinks.png`), which the office lacks. Office's project-scoped selector is a genuinely clearer task focus than either comparator's open-ended nav — worth keeping. |
| Queue/status UX | `ui-baseline/live/live-10-running-office.png` (RUNNING hop), `ui-baseline/live/f-10-office-failed.png` (FAILED), `ui-baseline/live/f-21-request-open.png` (request row: Status `ready` / Provider job `failed`). | **Office wins.** A real machine-driven lifecycle — dispatched, running, failed, cancelled — vs Notion's user-maintained Status property (`swipe/worker-3/notion-help-database-properties.png`) and Obsidian's nothing (`swipe/worker-3/obsidian-plugins.png`). |
| Presence and notifications | `ui-baseline/live/f-11-attention-panel.png` (NEEDS YOU dropdown), bell badge + `N need you` status bar in `ui-baseline/live/live-20-settled-office.png`. | **Notion wins** — its Inbox groups updates by page/thread, distinguishes mention (red) from update (grey), offers per-page settings and archive (`swipe/worker-3/notion-help-notifications.png`). The office's NEEDS YOU panel is a credible single-user equivalent (an attention queue, not a chat inbox) — second place. Obsidian has none (`swipe/worker-3/obsidian-help-status-bar.png`). |
| Status honesty | `ui-baseline/live/live-20-settled-office.png` ("provider-reported activity" label), `ui-baseline/live/f-21-request-open.png` (request `ready` vs provider job `failed` split), `ui-baseline/populated/populated-history.png` ("integrity hashes are available in Technical events; this view does not perform a new chain verification"). | **Office wins clearly** and should protect this. Neither comparator labels provenance at all — Notion's sync is silent (`swipe/worker-3/notion-help-collaborate.png`), Obsidian's only honesty affordance is the sync icon/log (`swipe/worker-3/obsidian-help-status-bar.png`). The office's verified-vs-reported labeling has no counterpart here. |
| Empty/loading/error states | `ui-baseline/empty/empty-01-office.png` ("Set up your office · 0/5" checklist, "Nobody working right now"), `ui-baseline/populated/populated-memory.png` + `populated-artifacts.png` ("Choose a project" gate), `ui-baseline/live/f-10-office-failed.png` (FAILED state). | **Office wins on captured evidence** — it evidences designed empty, gated and failed states; neither comparator's public docs evidence their in-app empty/error surfaces (see section 6 caveat). Caveat: the "Choose a project" gate is honest but blocks the whole page — a friction issue, not an honesty one (seed #3). |
| Accessibility | `ui-baseline/populated/populated-command-palette.png` (keyboard-driven "Go to…" palette); timestamps render in host-locale Korean ("9월 30일 오전 4:35") inside `ui-baseline/live/f-20-project-detail.png` and `ui-baseline/populated/populated-history.png` — an i18n-consistency slip visible in the baseline. | **Roughly tied, weakly evidenced on all sides.** Notion publishes a complete keyboard model (`swipe/worker-3/notion-help-keyboard-shortcuts.png`); Obsidian documents hotkeys (`swipe/worker-3/obsidian-help-properties.png`); the office has a working palette. No artifact evidences screen-reader support anywhere *(inference)*. |

## 5. Proposed revision packet seeds (ranked by expected impact)

Proposals only — no roadmap edits, no product changes. Rough file scope is indicative, not binding.

1. **Typed-property request table on project detail.** Problem: the Requests section renders one tall expandable card per request (`ui-baseline/live/f-20-project-detail.png`, `f-21-request-open.png`); with 5+ requests the mandate/stats context scrolls away and status scanning is row-by-row. Notion and Bases both show the pattern: a compact grid of typed columns (status pill, owner, created, provider state) with inline sort/filter (`swipe/worker-3/obsidian-help-bases-full.png`, `swipe/worker-3/notion-help-views-filters-sorts.png`). Rough scope: `app/src/renderer/projects.tsx`, `app/src/renderer/projects.css`.
2. **"Linked records" (backlinks) panel on project/request detail.** Problem: the chip row on project detail (`ui-baseline/live/f-20-project-detail.png`) asserts that Memory/Artifacts/Reviews exist but never enumerates *which records reference this one* — the exact gap Obsidian's linked/unlinked mentions panel and Notion's auto-backlinks close (`swipe/worker-3/obsidian-help-backlinks.png`, `swipe/worker-3/notion-help-links-and-backlinks.png`). Proposed: an expandable inbound-references list per entity with counts and an honest empty state (office already has "No activity recorded" as a precedent). Rough scope: `app/src/renderer/projects.tsx`, `app/src/renderer/components.tsx`; **flag for organizer** — cross-record enumeration may need a store query or IPC surface that is organizer-owned.
3. **Ungate Memory/Artifacts behind an inline selector, not a page block.** Problem: `ui-baseline/populated/populated-memory.png` and `populated-artifacts.png` render a full-page "Choose a project" wall — discovery is blocked until the user already knows where to look. Bases keeps the same chooser as a non-blocking sidebar list with the table live beside it (`swipe/worker-3/obsidian-help-bases.png`). Rough scope: `app/src/renderer/memory.tsx`, `app/src/renderer/artifacts.tsx`, `app/src/renderer/memory-layout.ts`.
4. **Saved views / view tabs for the request list.** Problem: the project Requests section offers lifecycle filter + search but no persisted named cuts (Notion's All launches / Feed / Timeline / Status tabs — `swipe/worker-3/notion-help-intro-to-databases.png`). Office-natural equivalents: `All · Needs you · Failed lately · Drafts`. Rough scope: `app/src/renderer/projects.tsx`; persisted view definitions would touch the store — organizer-owned surface, flag it.
5. **Inbox-grade triage for NEEDS YOU.** Problem: the NEEDS YOU dropdown (`ui-baseline/live/f-11-attention-panel.png`) is a flat list; Notion's Inbox groups by record/thread, filters unread/archived, and exposes per-source notification settings (`swipe/worker-3/notion-help-notifications.png`, `swipe/worker-3/notion-help-notifications-full.png`). Grouping by request/project plus a per-project mute would scale the office's attention model past a handful of agents. Rough scope: `app/src/renderer/shell-widgets.tsx`, `app/src/renderer/queue.tsx`, `app/src/renderer/main.tsx`.

## 6. Gaps and honesty notes

- **Capture ceiling is docs + marketing.** Both comparators gate real product sessions behind accounts; every UI claim rests on embedded product screenshots and authored help copy in `swipe/worker-3/` artifacts, never on a live workspace. Scores for status honesty, empty/loading/error and accessibility are marked *(inference)* where no artifact evidences the surface.
- **No live empty/error/loading evidence for either comparator** — the office's seeded empty/FAILED baselines had no comparator counterpart to weigh against; that verdict is "wins on captured evidence", not "wins absolutely".
- **Accessibility is inference everywhere.** Contrast can be eyeballed in captures (both comparators use high-contrast text on light/dark surfaces) but focus order, ARIA and screen-reader behavior are unverifiable from screenshots.
- **Retried URLs:** four Notion paths and one Obsidian path returned 404 under the old help-tree shape and were re-captured at corrected paths; all manifest entries show the final 200 URL. The earlier 404 artifacts were overwritten in place so no cited file is a dead page.
- **Environment artifacts in captures:** Korean locale banner and cookie-consent overlay on Notion pages (host locale), and headless-Chromium rendering (no web-font fallbacks observed, but minor).
- **Baseline observation, not a comparator claim:** office timestamps render in host-locale Korean inside `ui-baseline/live/f-20-project-detail.png` and `ui-baseline/populated/populated-history.png` — noted here as evidence, not scored (self-audit packet covers it).
- **Nothing purchased or paywalled**; methods (b)/(c) unused because (a) covered the target set. The swipe directory is outside Git; only this document is committed.
