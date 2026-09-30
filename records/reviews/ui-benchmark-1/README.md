# UI benchmark `ui-benchmark-1` — organizer synthesis and ranked revision proposals

Date: 2026-09-30. Round: `ui-benchmark-1`, findings-only (no product code). Base: `65bddec` (post-C12 formatted `main`); subject build: packaged `Quant Office\App\` mirroring `5992bec` (asar `D44A3C13…`).

This record integrates the seven worker findings docs in this directory and ranks the revision proposals. Per the round request it is the counterpart of the 2026-09-25 launch-readiness review: evidence-bound findings first, proposed packets ranked by impact, roadmap entry by the organizer only.

## Baseline and method

- **Office baseline:** 38 screenshots captured by the organizer on the packaged build under a scratch `QRO_USER_DATA_DIR` — `drafts/organizer/ui-baseline/` (`empty/` all nine pages, `populated/` seeded workspace, `live/` a real dispatched LOCAL_MAILBOX hop through UNKNOWN → RUNNING → FAILED, the NEEDS YOU panel, project detail). No live user data was touched.
- **Comparator corpus:** 519 reference artifacts in `swipe/worker-1..6/` (outside Git, reference-only, ToS-bounded), all captured free via Playwright on public product/docs pages — Linear (64), VS Code (60), Notion+Obsidian (35), GitHub Desktop+Postman+Insomnia (47), Slack+Discord (139), Devin/Cursor/Copilot/Jules/Replit/Claude Code/partial Codex (174). Methods (b)/(c) were not needed; nothing was purchased.
- **Self-audit:** worker-7 scored all nine pages + shared chrome × the rubric against the baseline artifacts and logged 22 discrete findings.
- **Known evidence limits:** the baseline has five byte-identical duplicate pairs (no boot/loading frame; the UNKNOWN-phase office scene and the request-detail surface were never actually captured — the audit reports what each file shows, not what its name implies). Comparator evidence is vendor-published docs/marketing, not authenticated app sessions; workers flagged inference accordingly.

## Cross-worker verdict

**Status honesty is the office's signature advantage — protect it.** Every comparator study independently concluded the verified/self-reported/unknown vocabulary ("provider-reported activity", request "Status: ready" vs "Provider job: failed", History's "not provider attestation" disclaimers) has no counterpart in any captured product. GitHub Desktop's "Last fetched 2 minutes ago" pairs state with *freshness* — the one honesty mechanic the office lacks. Extend the vocabulary (freshness stamps, provenance chips on every record, finished≠applied lifecycle) rather than dilute it.

**The attention model is right but mechanically thin.** NEEDS YOU (bell badge + sidebar badge + status bar + one actionable item with a reason and remedy) is a genuine routed-attention surface — arguably stronger semantics than Slack/Discord. But five of seven workers converged on the same gap: the queue *displays* state in arrival order instead of *prioritizing* it (Linear focus-order, ACC Kanban, Replit's explicit lifecycle, Claude's needs-you-at-top), and the panel is a flat list with no grouping, dismiss, snooze, or triage.

**Density is the largest consistent deficit.** The office routinely shows single-digit elements per viewport where comparators pack dozens — Postman's anatomy, Bases' table+filter+picker strip, VS Code's ~40-element workbench. The isometric scene is the product's identity and stays ambient; the gap is the absence of any denser status view alongside it.

**Project gating dead-ends three pages.** Reviews/Artifacts/Memory render a "Choose a project" wall even with exactly one project in the workspace, while sidebar labels collide with the identically named project-scoped tabs inside project detail.

**Polish items are individually cheap and visible:** plural slips ("1 active projects", "1 participants"), "recorded records" stutter, mixed-locale timestamps (Korean OS format inside en-US UI), clipped command-palette placeholder, silently truncated History, icon-only affordances, the Agents misdiagnosed empty state, and the "A Step Failed" chip casing.

**Not adopted:** a mid-run steer/pause affordance (w6 seed 5) is deferred — it depends on what each provider transport actually supports and is a product decision, not a cosmetic fix. An external notification path (OS notifications, quiet hours; w5 seed 6, w6 §4.4) is real but second-order until the in-app queue lands.

## Ranked revision proposals

Proposals only. Rough file scopes are orientation for the organizer; shared types/IPC/store/schema surfaces are organizer-owned regardless.

1. **Attention-first work queue and triage surface.** Group project request rows and the NEEDS YOU feed by attention class (failed-needing-you → decisions waiting → running → drafts → closed) with collapsible headers and counts; add per-item acknowledge/snooze-lite and a bulk mark-handled; keep "N need you" honest. Evidence: w1 (Linear focus-order `linear-18`), w3 (Notion inbox), w4 (Postman attention widget), w5 (Slack Activity/Discord Inbox), w6 (ACC Kanban, Claude state groups); baseline `live/f-11-attention-panel.png`, `live/f-20-project-detail.png`.
2. **Project context that follows the user.** Auto-select the sole project and remember the last one on Reviews/Artifacts/Memory; replace the full-page gate with an inline picker that shows live state; resolve the global-vs-project duplicate labels. Evidence: w7 findings 10–11, w3 seed 3; baseline `populated/populated-reviews.png`, `live/live-25-reviews.png`.
3. **Freshness and lifecycle honesty.** "Last verified/reported Ns ago" on provider-derived state; a per-request job timeline (minted → dispatched → provider-observed → settled/failed) in the expanded row; an explicit finished≠applied display lifecycle. Evidence: w4 seeds 1–2 (GitHub Desktop fetch-age), w6 seeds 2–3 (Replit lifecycle, evidence step log); baseline `live/live-20-settled-office.png`, `live/f-20-project-detail.png`.
4. **Density pass on lists.** Two-line request/project rows carrying status reason, provider state and recency; typed-property request table on project detail. Evidence: w2 seed 3 (VS Code pick rows), w3 seed 1 (Bases/Notion tables), w4 (Postman row anatomy); baseline `live/f-20-project-detail.png`, `populated/populated-projects.png`.
5. **One empty-state contract.** Page-specific title + value line + primary CTA per empty state; fix the Agents "no agents match these filters" misdiagnosis; retire the generic block on Reviews/Artifacts/Memory. Evidence: w7 findings 7–9; baseline `empty/empty-agents.png`, `empty/empty-reviews.png`.
6. **Copy, pluralization and locale pass.** "1 active projects"/"1 participants"/"1 active profiles", "recorded records" → "N events · showing M", redundant "(account not checked)", "pipeline arms" phrasing, "A Step Failed" casing, host-locale timestamps pinned to the UI locale, History's silent truncation gets a load-more affordance. Evidence: w7 findings 1–6, 16–17; w6 seed 4; baseline `populated/populated-projects.png`, `live/live-24-history.png`, `live/live-20-settled-office.png`.
7. **Command palette + keyboard path.** Widen/shorten the clipped placeholder, order to match sidebar grouping, add recents and commands (New request, Add agent, open NEEDS YOU), j/k triage and documented key hints. Evidence: w2 seed 1, w5 seed 5, w7 finding 12; baseline `empty/empty-command-palette.png`.
8. **Icon-only affordances and truncation.** Tooltips/aria text for the bell badge numeral, project-card icon button, truncated request pill; label the status-bar agent counter. Evidence: w7 findings 15, 18–19; w1 a11y comparison (Linear's real aria-labels on icon controls).
9. **Provenance chips beyond the live view.** Small office-observed / provider-reported / user-imported tags on request rows, agent table cells and history/artifact entries — the honesty vocabulary applied uniformly, not just in the scene. Evidence: w4 seed 4 (Insomnia locality table); baseline `live/live-24-history.png`.
10. **(Stretch) External reach + steer.** OS-native notification for needs-input/finish and a quiet-hours toggle; a steer/pause affordance only after transport capability is confirmed per provider. Evidence: w5 seed 6, w6 seeds and §4.4. Gated — requires a product decision and per-provider capability evidence first.

## What the round did NOT establish

- No authenticated comparator UI was exercised — all comparator evidence is vendor-published public material (bias noted per worker).
- Accessibility scores are visual lower bounds; no screen-reader, focus-order or motion evidence exists on either side.
- Loading-state evidence for the office is absent (duplicate-pair gap above) — recapture in the next acceptance pass.
- These are ranked *proposals*; none is a committed packet. The C12 backlog row is where they would land if adopted.

## Proposed roadmap entry (for §11/§17)

See the organizer's §17 entry of this date — this README is the cited record.
