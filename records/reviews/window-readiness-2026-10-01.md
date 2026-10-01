# B2b / B4 — readiness projection and profile paging

Base: `beab1ce`. Local candidate on `codex/revision-20261001`; not merged or installed.

B2b reproduces both audit defects: last append can differ from greatest observedAt, and a metadata refresh can lack earlier current-version local transport evidence. The baseline failed the append-order regression. The fix retains the last appended snapshot, assignment-cited snapshots and the last supplier for each operation/scope/evidence rank, in original order. Observed evidence remains above documentation; explicit invalidations remain eligible. Full store history is unchanged.

Measured on a scratch copy of `Archive/workspace-live-before-agent-reset-20260927.sqlite`, reading SQLite directly with readOnly=true and never starting the application. All other public-state fields use the same exclusion rules, so the sizes compare capability projections rather than unrelated UI changes.

| Projection | Snapshots | JSON UTF-8 bytes |
| --- | ---: | ---: |
| Before #56 (full capabilities) | 308 | 12,941,345 |
| #56 timestamp/latest + cited filter | 52 | 2,682,722 |
| B2b entire current-version candidate set | 280 | 12,714,848 |
| B2b final supplier projection | 55 | 2,822,192 |

The first-stage candidate set restored most of the original payload, so the second-stage scope/rank filter was necessary. 15,055 comparisons passed for effectiveEvidence (scoped and unscoped), providerReadiness, agentDispatchReadiness and agentBinding on full/window states. Source hash before/after was identical: `862878f970c089b164b3a4b30ee3b02dd8ec9ad6124eea48e001dd7a8d8996e2`. Raw size record: `Docs/Reviews/revision-2026-10-01/window-measurement.json`. Reproduce: `pnpm exec tsx scripts/measure-window.ts <archive-file> <report-file>`.

B4 now follows jobEventPage.nextCursor, resets on job/tab/revision change, blocks stale responses, deduplicates appended IDs and labels the list oldest first. The packaged synthetic user-level check opened the profile's Assignments tab and loaded 50 → 100 → 125 distinct ordered events; the button disappeared at the end, and changing tabs reset to the first page. No provider was dispatched. Evidence: app/test-output/profile-paging/acceptance.json and all-125.png, copied outside Git with the final verification logs. Reproduce using QRO_EXECUTABLE pointing at a QRO_TEST_BUILD=1 package: `pnpm exec tsx tests/profile-paging.desktop.ts`.
