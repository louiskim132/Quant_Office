<!-- Copy of Quant Office/Docs/Reviews/ui-3d-redesign-2026-10-01-execution.md. The screenshots and the preview harness referenced below live in Quant Office/Docs/Reviews/ui-3d-redesign-2026-10-01/, outside Git. -->

# UI redesign — execution log (2026-10-01)

Status: **IMPLEMENTED LOCALLY AND VERIFIED — not pushed, no PR, not mirrored into `App\`.** See "Verification actually performed" for exactly what ran and what did not.

Worktree: `Quant Office\Worktrees\ui-3d-office-20261001` · branch `feat/ui-3d-office-20261001` · base `80cf088` (tip of `codex/revision-20261001`, itself on `origin/main` `beab1ce`).
The sibling worktree `Worktrees\revision-20261001` was **not touched**: it carries another session's uncommitted LR-16b isolation edits (see "Hand-off to the isolation session").
Installed `App\`, the live `%APPDATA%\Quant Research Office` workspace, `repo\` and `repo-sessions\` were not modified. Every test used a scratch `QRO_USER_DATA_DIR`.

## The request, and where each part landed

| # | You asked for | Delivered |
|---|---|---|
| 1 | Office as an interactive 3D scene like the attached picture | A real WebGL isometric office (three.js): rotate, zoom, pan, focus, per-person name tags with status dots, working monitors, people who walk to meeting tables, a live status board on the wall. The old flat floor stays as an automatic fallback and a Settings choice. |
| 2 | Settings are messy and wordy; isolation buttons are clustered with no status | Settings is now a section rail with status dots and one calm pane at a time. Provider cards lead with one status word and a four-step readiness row. Agent isolation shows a headline state, four steps each with its own status, and only the one action that fits. |
| 3 | The memory graph is far from the requested Obsidian-style brain; add a show/hide-names toggle | The graph is a live force-directed "brain" on a canvas: hubs with packed spokes, hover lights a finding and its neighbours, search lights matches, thousands of findings stay interactive. A labelled **Names** switch (toolbar and panel) hides or shows every name. |
| 4 | Review the current office UI, research other products' aesthetics, revise | Review and research below; a shell refresh (warm neutral palette, calmer sidebar/topbar, readable type scale, Office page leads with the floor). |
| 5 | Log the execution | This file, plus a copy and a roadmap entry in the branch (see "Records"). |

## 1. Review of the existing UI (what was wrong)

Evidence: `ui-3d-redesign-2026-10-01/before/` (the 09-29 build as merged: `office-dark-1440.png`, `memory-dark-1440.png`, `settings-dark-1440.png`, `agents-dark-1440.png`).

- **Office.** A CSS "isometric" floor of flat sprites in fixed role zones. It could not be rotated or zoomed, avatars were stickers, the page opened with a large heading block that pushed the floor down, and the floor shared the row with a 600 px chat column that left it ~800 px wide.
- **Memory.** An SVG graph bounded to 100 nodes / 200 links, rendered as a sparse scatter of equal circles with overlapping 24-character labels ("Finding 1 — bounded re…") and three stacked rows of buttons above it. Nothing like a dense, living graph; no way to hide names.
- **Settings.** One long page of stacked cards behind seven filter-style buttons ("All settings" first). Provider text ran to four sentences per card; the isolation card was a paragraph, a billing caveat repeated twice and two unlabelled buttons with no state anywhere.
- **Shell and type.** Cool teal-grey neutrals against a warm amber accent; 8–11 px body copy in buttons, badges, hints and the status bar; a 65 px topbar carrying a project picker, a text-button, six avatars, a bell, a count sentence and a usage button; a 205 px sidebar with a wordy footer paragraph.

## 2. Research (what was looked at, what was taken)

Done 2026-10-01 on top of the 60-product study in `ui-revision-plan-2026-09-29.md`; scoped to the three surfaces you named.

| Source | What it showed | What was adopted |
|---|---|---|
| **Claw3D** (claw3d.ai; open source per its site, by LukeTheDev — the product in your screenshot) and its fork MyClaw3D | Isometric three.js office; controls "drag · scroll · space+drag · double-click"; per-agent name tags with live status dot; "lock the camera on any team member"; standup and chat overlays; rooms, lounge, ping-pong, servers as set dressing | Orthographic isometric camera with the same control vocabulary; name tags with status dots; chips that lock the camera on a person; amenity set dressing; a floor-level CHAT toggle and a status line. Not copied: no code, art or layout from the product — the scene, avatars and layout are original. |
| **Obsidian graph view** (help docs) | Filters (search, orphans), Groups (colour), Display (arrows, text-fade threshold, node size, link thickness, animate), Forces (centre, repel, link force, link distance), local graph with depth, hover highlights neighbours, node size follows link count | All of it, mapped to honest record semantics: kind = colour, link status = line style, superseded = hollow ring, local-graph depth 1–3, search lights matches, the four force sliders, text-fade threshold, and the Names switch you asked for. |
| **Cosmograph / Sigma.js** (large-graph tooling) | Canvas/WebGL is the right substrate above a few hundred nodes; GPU simulation is the next step beyond that | Canvas 2D with a Barnes–Hut quadtree simulation written in-house (no dependency); 2,000 findings tick in ~4 ms. A GPU engine is the documented next step if a project ever passes ~10,000 findings. |
| **Linear's March 2026 UI refresh** | "Structure should be felt, not seen": dimmer sidebar, fewer borders and icons, softened separators, warmer greys, compact icon-only tabs | Warm neutral palette, dimmer sidebar, softer separators, fewer chips, the active nav item marked by an accent bar instead of a filled block. |
| **Settings UX guidance** (Material, Toptal, Eleken, Uxcel) | Group by purpose, show each integration's on/off status plainly, one line of helper text, tell the user when changes apply | Section rail with status dots; status word on every card; one-line helpers with detail behind "Technical details"; inline confirmation for the two consequential isolation actions. |

Sources: [Claw3D](https://www.claw3d.ai/), [MyClaw3D](https://github.com/0xMerl99/MyClaw3D), [Obsidian Graph view](https://obsidian.md/help/plugins/graph), [Linear: a calmer interface](https://linear.app/now/behind-the-latest-design-refresh), [Cosmograph concept](https://cosmograph.app/docs-general/concept/), [Sigma.js](https://www.sigmajs.org/), [Eleken settings-page guide](https://www.eleken.co/blog-posts/settings-page-ui).

## 3. Decisions

1. **WebGL via three.js (`three@0.186.1`, MIT, exact-pinned) plus `@types/three@0.186.0`.** The only new dependencies; the renderer bundle grows by ~700 KB (1.18 MB total). AGENTS.md makes dependencies organizer-owned — **this needs organizer sign-off before integration**; the user request is the authorization for the feature, not for merging.
2. **A flat fallback is kept.** If WebGL is unavailable (blocked GPU, remote desktop) or the viewer picks "Classic" in Settings → Appearance, the previous 2D floor renders unchanged (`OfficeScene` untouched). Nobody gets a blank box.
3. **Honesty invariants preserved.** Everything a person does on the floor still comes from `shared/activity.ts`. A monitor is lit only for a working person (working / stalled / away / done / failed / unknown each have their own screen), typing animation only while working, people walk only when their location changes (desk ⇄ meeting table), a hire or the first paint never walks in, reduced motion disables walking and the physics. The wall board counts are derived from the same seat views. Set dressing (lounge, ping-pong, kitchen, server closet) is inert.
4. **The brain draws no stored positions.** Only positions a person drags are stored (per project, as before). Every other position is derived: the same findings settle into the same picture in any input order (unit-tested).
5. **Isolation copy stays truthful.** LR-16 isolation v1 needs saved API keys, which conflicts with the subscription-only rule (D-6). The card shows that as its own blocked step and "Set up isolation" asks for confirmation naming it. No new path to API keys was added.
6. **Detail cards overlay the graph instead of taking a column**, so selecting a finding never moves or resizes the picture.

## 4. What was built

### Office (request 1)
- `renderer/office3d/layout.ts` — the floor plan as pure data (desk grid by role zone, meeting tables sized to the largest meeting, aisle/corridor/lane walking network). `routeBetween` never crosses a desk (unit-tested for every desk × several table seats, both directions).
- `office3d/world.ts`, `kit.ts` — parquet floor, desks, monitors, chairs, rugs, round tables, lounge, ping-pong, kitchenette, bookshelf, server closet, windows, wall status board. All static boxes are baked into **one** vertex-coloured mesh (one draw call, one shadow draw). Walls cut away on the camera side.
- `office3d/avatar.ts` — voxel people: standing, walking, seated, typing, talking.
- `office3d/engine.ts` — orthographic isometric camera and `OrbitControls` (drag rotate, wheel zoom to cursor, right/Space-drag pan, double-click focus, arrow-key rotate, +/− zoom, 0 reset), picking, label projection with crowd thinning (a tag shrinks to its status dot when it would overlap another; the name returns on hover), render-on-demand loop (an idle office costs nothing), pauses when hidden/off-screen, full GPU cleanup on dispose.
- `office-stage.tsx`, `office3d.css` — the stage: title and live count, agent chips that lock the camera, meeting banner, zoom/rotate/reset/**names**/full-screen tools, status line with the control hints, a CHAT button that opens the office chat over the lower right of the stage (closed by default, so the floor never changes size), "Now" list beneath as the textual twin. Name tags are real `<button>`s (focusable, labelled, hover card with role/model/status/evidence).
- Layout: the floor is full width (16:10, at most 84 % of the window height); the Office page heading is visually hidden (the stage carries the title) but remains for assistive tech.

### Settings (request 2)
- `settings.tsx`, `settings.css` replace the inline Settings block in `main.tsx` and the old `ProviderConnections` / `AgentIsolation` / `ApiKeyEntry` in `agents.tsx`.
- Rail: Connections · Agent isolation · Notifications · Appearance · Data & recovery · About, with a status dot on the first two (all ready / some / none; active / off).
- Provider card: name, plan, one status word (**Ready**, **Signed in · not verified**, **Not signed in**, **Not checked**, **API key saved**), identity and check time on one line, a four-pill readiness row (Signed in · Model · Dispatch · Ready), Check account / Sign in, and everything else (full readiness, operations, evidence, API-key entry) behind "Technical details" / "Advanced". The cloud-transport containment text and the disabled "Verify cloud transport…" button stay visible.
- Isolation card: headline state; four steps (Windows account · folder access · subscription sign-in — blocked, API keys required · last check with time and N of M); failed check names listed; the single fitting action; setup and removal each ask first. The last check result is remembered in the viewer's preferences.
- New shared pieces: `Switch`, `Segmented`, `Dot` (`components.tsx`), `usePref` (`prefs.ts`).

### Memory brain (request 3)
- `brain-sim.ts` — Barnes–Hut force simulation (links as springs with degree bias, charge by size, gravity that holds a round cloud, circle-packing collisions), deterministic and canonical-order, preserves positions across refreshes and filters, seeds new findings beside a neighbour. 10 unit tests.
- `memory-brain.tsx` — canvas renderer: batched edges and nodes, dashed proposed / dotted refuted / solid confirmed links, optional arrows, hollow superseded rings, pins, compare rings, selection halo, hover and search dimming, zoom-to-cursor, drag-pin, double-click focus or release, keyboard (arrows step through findings, +/−, 0, Esc), hover name tooltip.
- `memory.tsx`, `memory.css` — floating controls: kind chips with counts, toolbar (**Names**, Fit graph, Reset layout, Local graph, pause physics, panel), Obsidian-style panel (Filters: window, refuted, unlinked, local depth · Display: names, arrows, text-fade, node size, link thickness · Forces: centre, repel, link force, link distance). The 100-node / 200-link bound became 5,000 / 20,000 with a visible notice. List, detail card, compare tray, bulk settle, link proposal and composer are unchanged in behaviour.

### Shell polish (request 4)
- Warm neutral dark palette (the theme was named "Warm dark" but rendered teal-grey), softer separators, calmer sidebar (224 px, accent bar on the active item, count badge only when something needs you, footer paragraph moved to a tooltip), 56 px topbar with a "Go to… Ctrl K" field and no duplicate agent-count sentence, 13 px buttons and 12 px helper text instead of 10–11 px, status bar 11 px.

## 5. Verification actually performed

All from `app\` on this Windows machine (Node 24.19, Electron 44.2.0). Every desktop run used a scratch `QRO_USER_DATA_DIR`; no live workspace, no provider call, no agent was dispatched; fixtures are the `Test dir 1`, `Test PM A–D`, `Test worker 1` names at `fixture-unverified / default` (never executed).

| Check | Result |
|---|---|
| `pnpm format:check` | clean |
| `npx tsc --noEmit` | clean |
| `pnpm test` — full unit suite | **1,044 tests — 1,043 pass, 0 fail, 1 existing skip** (base was 1,031 / 1,030 / 1: +8 floor-plan/route, +10 brain-simulation, +1 local-graph neighbourhood, −6 old SVG-layout tests) |
| Dev-build desktop suites (`pnpm build`, then `tsx tests/<suite>.ts`) | `ui-revision.desktop`, `desktop.e2e`, `revision.desktop`, `office-chat.desktop`, `pipeline-request.desktop`, `pipeline.desktop`, **new `office3d.desktop`** — all pass |
| Packaged test builds (`QRO_TEST_BUILD=1 node scripts/package.mjs`) | **Final build** (asar SHA-256 `9756CE1B5EA2F2C62389362858E505C88B3EBCF2D236F4473168B2B4D9C01859`, 60,029,288 bytes): `ui-revision.desktop`, `office3d.desktop`, `desktop.e2e` pass. The build before it (`F640D86D…0BCA`; the only later change is one CSS colour on the provider glyph) also passed `office-chat.desktop` and `revision.desktop`; the first packaged build passed `profile-paging.desktop` and `packaged-native.desktop` (the memory camera inset and a package script were added afterwards) |

What the new and rewritten checks actually exercise, in the real window with WebGL on:
- **`tests/office3d.desktop.ts`** — the canvas reports `data-engine=webgl` and six people, each a labelled name-tag button; the Names switch hides every name (`.tag-name` count 0 while off); Rotate / Zoom / Reset buttons, mouse-wheel zoom and keyboard rotation change and restore the camera (read back from the canvas); a chip focuses the camera and opens the drawer (Escape closes it); a hover card appears and the tag opens the drawer; a settings write starts **no walk**; CHAT shows and hides the chat; Settings → Appearance → Classic swaps to the flat floor and 3D restores it; no page errors.
- **`tests/ui-revision.desktop.ts`** (populated: 24 findings, 23 proposed links) — the brain draws 24 nodes; the Local graph shows ≤ 3 and returns to 24; the Names switch flips `data-names`; arrow keys step the selection; wheel zoom changes `data-zoom`; Fit works; Settings sections (Appearance → Agent isolation "Not set up" → Data & recovery → Connections); screenshots at 1440 and 1000 px, light and dark, with no horizontal overflow on any page.
- **`tests/brain-sim.test.ts`** — determinism in any input order, no overlaps after settling, hubs inside their spokes and a round cloud, pins exact and positions preserved across a refresh, bad/duplicate links ignored, empty and single-node graphs, 2,000 findings (120 ticks ≈ 0.5 s), label thinning. **`tests/office3d-layout.test.ts`** — every desk × several table seats, both directions: routes start and end in the right seats and never cross a desk.
- Real faults the new checks caught (and that are fixed): **a theme change rebuilt the 3D world and left the floor empty** (the app applies the saved theme after first paint, so a light-theme user would have seen no people); the canvas **flashed blank on resize**. The theme now arrives as a prop from the saved settings and a rebuild re-seats everyone.
- Two assertions that were **already failing at the base commit** were corrected: `office-chat.desktop.ts` expected an empty-state title with a trailing full stop that the component dropped in an earlier round, and `revision.desktop.ts` looked for a `data-bucket=canceled` queue group that the attention-first queue renamed `settled`.

Screens inspected with eyes (evidence folder): office dark/light at 1440 and 1000 px, working / meeting-walk / meeting-seated / 14-agent light / 40-agent crowd-thinning / empty floor; memory brain at 26, 140 and 600 findings, dark and light, selected, names off, local graph, settings panel; Settings connections, isolation (off and active), appearance, notifications, data; agents, projects, history and usage pages for the type-scale and palette change.

**Not run:** `agents.e2e.ts` (reads the official Codex account/catalog — AGENTS.md live-provider rule; only its `.office-person` selector was updated) and `three-agent.live.ts`; the release (fuses-on) package and the installed-`App\` mirror; CI; a screen-reader pass; frame-rate measurement on a weak or integrated GPU; a real meeting walking with live agents (walking was exercised with synthetic activity in the preview harness and by the route unit tests).

## 6. Not done, risks, and decisions that are yours

- **Dependency sign-off.** `three` + `@types/three` (see decision 1).
- **Merge conflict with the LR-16b session.** `Worktrees\revision-20261001` has uncommitted edits to `agents.tsx` (per-provider "Sign in / Check subscription" buttons inside `AgentIsolation`) and `types.ts`/`preload.ts`. This branch deleted `AgentIsolation` from `agents.tsx` and rebuilt it in `settings.tsx`. When both land, re-apply those buttons as a **"Provider sign-ins"** group of rows between the account and check steps of the new card, each row with its own status — that is the shape the redesign asks for. Nothing of theirs was changed or read-modified.
- **No live-agent presence acceptance.** The 3D floor draws what the same activity derivation already reported; no live provider run was started. Meeting walking was exercised with synthetic activity in the preview harness, not with a real meeting.
- **Software WebGL.** On a machine with no usable GPU the office falls back to the flat floor; the 3D scene was only judged here on this machine's GPU/software path.
- **Not measured:** frame rates on weak integrated GPUs; screen-reader walkthrough of the new canvas (the findings list and the name-tag buttons are the accessible twins).
- **Cosmetic limits:** the 3D avatars are voxel figures with no faces visible from the default angle (they face their screens); zone signs are painted on the floor and can be partly hidden under desks; names above 200 px are truncated with an ellipsis.
- Old SVG-only helpers (`layoutMemory`, `fitMemory`, `memoryLabels`, `memoryRadius`, `memoryEdgeTrim`) and their tests were deleted with the SVG graph.

## 7. Records and evidence

- Evidence: `ui-3d-redesign-2026-10-01/` — `before/` (09-29 build), `after/` (this build), `tools/` (read-only preview harness and README).
- In the branch: `records/reviews/ui-3d-redesign-2026-10-01.md` (copy of this log) and a roadmap §17 entry.
- Revert: delete the branch/worktree; nothing outside `Worktrees\ui-3d-office-20261001` and `Docs\Reviews` changed.

## 8. Corrections (2026-10-01, integration)

- **Status line and §7 "Revert" were wrong about `App\`.** The work was committed as `c25f1ab`, and the packaged **test** build `9756CE1B…` (inspector fuse on) was mirrored into `Quant Office\App\`; the previous App is in `Archive\App-before-3d-office-20261001` (asar `7E7C7FE4…`). The integration replaces it with a release build; see the roadmap's newest §17 entry.
- **Decision 5 is superseded.** "Subscription sign-in … needs saved API keys" described LR-16 v1. LR-16b (`e4494fe`) removed that requirement, so the hard-coded blocked step was false. In `070c297` the step is derived from isolated-host checks, the card has per-provider Sign in / Check buttons in its existing styles, and the setup confirmation no longer mentions API keys. No graphics changed.
- **§6 hand-off is done:** `codex/revision-20261001` was committed and merged into this branch (`070c297`).

## 9. Glass-building revision of the 3D office (2026-10-01, user feedback)

Six requests after the first delivery, all in `app/src/renderer/office3d/` (`layout.ts`, `world.ts`, new `environment.ts`, `engine.ts`, `visuals.ts`, `avatar.ts`) and `office-stage.tsx`:

| # | Request | What changed |
|---|---|---|
| 1 | Floor not a clean rectangle sideways | The building is one rectangle on a stepped slab; the old cut-away walls and their uneven edges are gone. Checked at 45° and at 0° (front-on): the footprint is a crisp rectangle. A coplanar slab/floor z-fight found on the way was fixed. |
| 2 | Fixed, slightly taller walls | Every wall is 3.1 m (was 2.4 m far / 0.85 m cut-away near) and never changes with the camera. The engine's wall easing is removed. |
| 3 | Transparent windows, screen-door entrance, real surroundings | Walls are glass curtain walls (white sill, header and posts, transparent glass) on all four sides, so nothing hides from any angle. The front has a double sliding glass door under a canopy with the office sign. Outside: paved plaza, entry path, road with cars and a bus, street lamps, cherry and green trees, a canal with a footbridge, and glass towers behind. Day for the light theme, dusk with lit windows for the dark theme. |
| 4 | Bright, white-focused interior | White desks and walls, pale-oak floor, graphite and light-grey seating, a few colour accents. The interior is equally bright in both themes; only the outside changes. |
| 5 | Isolated meeting rooms | Each meeting room is a glass room with black frames, a frosted band, a door, a long table with chairs on both sides and at the ends, and a whiteboard. People walk out through the door and along the aisle. |
| 6 | Rest area where the purple carpet was | A glass rest area: kitchenette with stools, a ping-pong table (two players, ball in motion), sofas and armchairs, a rug, lamp and plants. An agent goes there when its recorded allowance is below 5%. |

Rest rule, so it stays honest: it uses only recorded sign-in observations (`state.connections`) for the agent's provider and account, ignores observations older than 12 h and windows that have already reset, and sends someone to rest only when they are not working or waiting on you and not in a meeting. A working agent stays at its desk (its tag card still shows the allowance). Spots are stable while someone rests and fill in a fixed order (sofa, armchair, ping-pong pair, then the rest); 15 spots, beyond which people stay at their desks. Resting people walk to the rest area only on a change of location; reduced motion seats them at once.

Also: the camera now frames the office in the band between the chip row and the status line, which fixed a desk hiding under a chip (caught by `ui-revision.desktop`).

Verification: format and typecheck clean; unit suite 1,060 tests (1,059 pass, 0 fail, 1 existing skip) including new layout, routing, rest-order and allowance tests; dev-build desktop suites `office3d`, `ui-revision`, `desktop.e2e`, `office-chat`, `revision` pass on empty scratch data dirs. The rest area itself was inspected in the preview harness with a synthetic 3% allowance (there is no way to seed a real low allowance without a provider call). Evidence: `ui-3d-redesign-2026-10-01/after/office-glass-*.png`. Not run: packaged-build suites for this revision, screen reader, weak-GPU frame rates.

## 10. Stage controls revision (2026-10-01, user feedback)

- Tool rail moved to the left. Each tool grows to the right on hover or keyboard focus and shows its name inside the same pill (no native tooltip).
- New **Agents** tool opens a scrolling menu of every agent with its status (search box once there are more than eight); choosing one focuses the camera and opens its details. It replaces the top chip row, which could not hold an unbounded team.
- Removed Rotate left/right (drag and arrow keys remain) and the full-screen button, which did not work.
- Status line: a vertical rule between the counts and the hints, and the hints read `drag: rotate`, `scroll: zoom`, `space + drag: pan`, `double-click: focus`.
- The meeting banner moved to the top right so it no longer overlaps the rail. Tests updated (`office3d.desktop` now drags to rotate and picks agents from the menu). Dev-build `office3d`, `ui-revision` and `desktop.e2e` pass. Evidence: `after/office-tools-*.png`.
