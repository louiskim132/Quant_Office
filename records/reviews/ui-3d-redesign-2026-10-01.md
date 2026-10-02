<!-- Copy of Quant Office/Docs/Reviews/ui-3d-redesign-2026-10-01-execution.md. The screenshots and the preview harness referenced below live in Quant Office/Docs/Reviews/ui-3d-redesign-2026-10-01/, outside Git. -->

# UI redesign — execution log (2026-10-01)

Status (latest, 2026-10-02): **section 12 (board, sharp text, full name, faster open, themed loading) is committed on the branch (`084a823`) and installed in `App\` as a release build; it is not pushed.** The campus revision (section 11) is on `origin/main`. Sections 1–10 describe the earlier steps as they stood at the time; section 11.6 corrects what they left unrecorded. Status of the first delivery: implemented locally and verified, not pushed.

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

## 11. Campus revision: a 64 Degrees-style pavilion (2026-10-01, user feedback)

The request: the 3D office looked unrealistic and unnatural. Use UC San Diego's Revelle College **64 Degrees** café and its surroundings (the user's dusk photograph) as the general approach, with the office standing where 64 Degrees stands; research natural office design; make the office **twice as large** because everything was packed; move the idle/working dashboard from the entrance to **beside the director's desk**; and when the pointer is on the left tool rail, show **the names of all icons**, not only the one under the pointer. Then push `main` and `origin`, update the taskbar App, the roadmap and this log, and clean up old files and sessions.

| # | Request | Delivered |
|---|---|---|
| 1 | 64 Degrees as the model, office in its place | A single-storey glass pavilion with a deep roof edge, round concrete columns and a faceted dark-metal entrance canopy with brass "QRO" letters standing on it (the office's own name in place of the 64° sign), set in a campus courtyard: umbrella dining, a yellow court with Adirondack chairs, drought-tolerant beds, lawns, bike racks, light poles, pines, eucalyptus and concrete campus buildings. Day and blue-hour dusk. |
| 2 | Research natural office design | See 11.1; applied as planting, materials, light, views, prospect and refuge. |
| 3 | Twice as large | Default team (1 director, 4 PMs, 1 worker): **35.0 × 19.9 m = 697 m²**, was 26.2 × 13.7 m = 359 m² (1.94×). Street 3 m (was 2.4 m), 2.7 m between a chair back and the next desk, 2.4 m lanes between meeting rooms, larger rooms and a 17 × 11 m café lounge. Unit-tested. |
| 4 | Dashboard beside the director | The status board left the entrance. It now stands in the director's row, in the slot right of the last director desk, turned 45° to face the default camera, at 3.3 × 1.65 m (was 2.4 × 0.9 m). The placement is computed in `layout.ts` and unit-tested for 1, 3 and 5 directors: in the row, beside the desk, clear of every desk and of the aisle. |
| 5 | Rail shows every name on hover | Pointing anywhere on the rail, or reaching it from the keyboard, widens **every** tool and shows all the names at once; the tool under the pointer is highlighted. While the agents menu is open the rail stays narrow so the menu does not jump. Checked in `office3d.desktop`. |

### 11.1 Research

| Source | What it showed | What was taken |
|---|---|---|
| 64 Degrees: [Studio E Architects](https://www.studioearchitects.com/work/ucsd-64degrees/), [FE&S project profile](https://fesmag.com/topics/project-profiles/facility-design-project-of-the-month/12314-64-degrees-in-revelle-college-at-the-university-of-california,-san-diego), the user's photograph | A. Quincy Jones's 1966 Revelle dining commons, reopened in 2014: dividing walls removed, skylights and natural light, the kitchen brought to the front, reclaimed-wood community tables, booths and counter seating, a double-sided fireplace, mesh curtains defining "neighbourhoods", expansive outdoor dining. The photograph: floor-to-ceiling glass under a thick flat roof edge, round columns, a faceted canopy under brass letters, blue umbrellas, a yellow court with yellow umbrellas and dark Adirondack chairs, agaves, grasses, pale boulders, a river-rock swale, lawn, bikes, slim poles, pines and eucalyptus, mid-rise concrete buildings with fins, louvres and an open stair, and warm interior light at blue hour | The building, canopy and sign treatment, the patio and court, the planting palette, the campus buildings and the dusk palette; inside, the café lounge (counter with stools, fireplace, seating groups) and neighbourhoods divided by planting |
| [Terrapin Bright Green, *14 Patterns of Biophilic Design*](https://www.terrapinbrightgreen.com/reports/14-patterns/) (2014) | Nature in the space (visual connection, water, dynamic and diffuse light), natural analogues (natural materials, biomorphic forms, complexity and order), nature of the space (prospect, refuge, mystery) | Planter dividers, indoor trees along the street, a living wall behind the director, a water rill on the patio, oak, walnut, stone, linen and wool, views out through glass from every desk, a long sightline down the street (prospect), and the sofa and fireside groups and the director's studio as refuges |
| Open-plan planning standards ([Arcedior clearances 2025](https://arcedior.com/blog/open-office-layout-standards-clearances-2025), [OfficeSpace density 2026](https://www.officespacesoftware.com/blog/recommended-office-space-per-employee/)) | Main circulation 1.5–2.4 m, row aisles 0.9–1.2 m, 0.9–1.05 m behind chairs, 12–19 m² per person in open plan | A 3 m street, 2.7 m behind every chair and 2.4 m lanes. The larger floor is generous by these numbers on purpose, because the user found the previous plan packed. |

### 11.2 What changed (`app/src/renderer/office3d/`, `office-stage.tsx`, `office3d.css`)

- **Floor plan (`layout.ts`).** New dimensions (pods 3.4 × 4.2 m, first desk at 4.4/3.6 m, zone gap 1.6 m, street 3 m, rooms 2.55 m half-depth, lounge 11 m deep), the board slot, planter `dividers`, `streetPlants` placed only where no aisle, lane or door crosses the street, an `EAST_WALK` of 1.4 m inside the meeting wing's east glass, and a re-laid lounge: counter and stools at the back, ping-pong, a sofa that faces the room with an armchair at each end of a low table, and a fireside group of four armchairs. Every lounge exit has explicit waypoints that avoid the furniture.
- **The roof-edge strip.** The building is drawn without a roof so the inside stays visible; the roof is suggested by a 0.36 m fascia with a 0.5 m overhang. Seen from the default camera (34° above the horizon, 45° to each wall), that edge hides a head-height strip roughly 1–2 m inside the two near walls, so no seat sits there: lounge seats keep 2.4 m from the front glass and meeting chairs 2.4 m from the east glass (unit-tested). The first lounge draft put the sofa in that strip and it vanished behind the roof edge, which is why the lounge was turned round.
- **Interior (`world.ts`).** A polished-concrete floor with oak planks in the work neighbourhoods; oak desks on white legs with monitor arms, lamps, plants, notebooks and mugs; task chairs with five-star bases; a walnut director's desk and credenza on a wool rug; the status board on an oak stand; oak planter boxes with grasses, ferns and snake plants between neighbourhoods, and wooden zone plaques; a living wall across the back of the work area; bookshelves along the west wall; potted trees along the street and the east walkway; glass meeting rooms with oak tables, upholstered chairs, a linear pendant, a wall screen and a credenza; the café lounge with a reclaimed-oak counter, an espresso machine, stools, a linen sofa, armchairs, rugs, a stone fireplace with a fire, and planters along the front glass. Rounded edges throughout (`Batch.rbox`).
- **People (`avatar.ts`).** Rounded figures (capsule limbs and torso, a sphere head, a hair cap, ears, nose and eyes) instead of voxel boxes, with trouser and shoe colours and three hair styles varied per person. The rig, the poses and the honest-state rules are unchanged.
- **Courtyard (`environment.ts`).** Replaces the road, cars, bus, canal and glass towers. Tall things keep at least their height ÷ 0.67 from the building (the camera's slope), so orbiting to the back or a side still shows the whole office; the first draft's pines and buildings hid the office from behind and were moved out. Contact shadows under trees and umbrellas; at dusk, lamp and bollard light pools and lit windows.
- **Rendering (`engine.ts`).** Neutral tone mapping; a `RoomEnvironment` for ambient light and glass reflections; soft PCF shadows (radius 3) with a 4096² map over the larger floor; haze toward the sky colour; a front-left sun by day, and a cool blue-hour light with warm interior lamps at dusk. Maximum zoom is now 12× the fit and agent focus 3.2×. The stage backdrop is a sky gradient.
- **Rail (`office-stage.tsx`, `office3d.css`).** Hover-names-all as above. The rail's agents button and its menu are now named **"Agents on the floor"**: since `f5f953f` they shared the name "Agents" with the sidebar's Agents page, which is ambiguous for screen readers and made `revision.desktop` fail (a strict-mode match on two buttons).

### 11.3 Decisions

1. **No new dependencies.** `RoundedBoxGeometry`, `RoomEnvironment` and `BufferGeometryUtils.mergeVertices` are add-ons inside the already pinned `three@0.186.1`.
2. **Still one draw call** for the static office, plus small glass, frost, glow, shade and light-pool batches. The cost of the realism is the 4096² shadow map and, at dusk only, up to 15 unshadowed interior lights (8 for the default team).
3. **Honesty rules unchanged.** Monitors, typing, walking, meetings and resting still come only from the derived activity; `visuals.ts` is untouched; routes stay on aisles and lanes (unit-tested for every desk against room and lounge seats).
4. **No copied branding.** The pavilion, canopy, courtyard and buildings are original geometry modelled on the photograph's arrangement. The sign reads "QRO", not "64°", and no UC San Diego mark is used.

### 11.4 Verification

| Check | Result |
|---|---|
| `prettier --check`, `tsc --noEmit` | clean |
| Unit suite | **1,065 tests — 1,064 pass, 0 fail, 1 existing skip** (+5 floor-plan tests: area, board placement, clear walking lines, no seat in the hidden strip, lounge exits) |
| Dev-build desktop suites, scratch `QRO_USER_DATA_DIR` | `office3d` (webgl=true, with the new rail check), `ui-revision`, `desktop.e2e`, `office-chat`, `revision`, `pipeline-request`, `pipeline`: all pass |
| Packaged **test** build of `7192eb2` (asar SHA-256 `BC1C83385BC5430B27E546A77727CB0E1FA3D7C1CD7A4354E1DABE6C41F18B41`) | `office3d` (webgl=true, packaged=true), `desktop.e2e`, `ui-revision`, `revision`: all pass |
| Packaged **release** build of `7192eb2` | The same asar `BC1C8338…8B41`, 95 files; the RunAsNode and NodeCliInspect fuses disabled |
| Installed `App\` | The App was not running. The previous App was copied to `Archive\App-before-campus-office-20261001` (asar `A1AD4D94…`, the release build of `f5f953f`); the release was mirrored with `robocopy /MIR`, 95 of 95 files hash-identical. Started on an empty scratch data folder: the "Quant Research Office" window opened, a fresh workspace was created and the log was clean. Only the processes started by the check were closed. |
| Eyes | Harness screenshots `after/office-campus-01…09` (day, dusk, director and board close-up, café lounge, meeting room, rail with all names, back view, 14 agents, empty floor); `00` is the glass office before this revision |

Not run: `agents.e2e.ts` and `three-agent.live.ts` (live providers), CI (no PR, and pushes to `main` trigger none), a screen-reader pass, frame rates on a weak or integrated GPU.

### 11.5 Risks and limits

- The 4096² shadow map takes about 64 MB of GPU memory. If a weak GPU struggles, it is the first thing to lower.
- At the default zoom the board's numbers are about 14 px tall; zoom in for its labels.
- People face their screens, so faces show mainly in the lounge and the meeting rooms. From behind, the brass letters read mirrored, as real letters would.
- The courtyard is generated from fixed seeds; it does not depict the real Revelle site.

### 11.6 Record corrections

- Sections 9 and 10 said nothing was pushed and that the glass build was not installed. In fact `origin/main` was pushed directly, with no PR or CI run: `beab1ce` → `c25f1ab` at 2026-10-01 18:42 UTC and `c25f1ab` → `f5f953f` at 2026-10-02 02:30 UTC (GitHub's activity log). The release build of `f5f953f` (asar `A1AD4D94…`, fuses off, containing the section 10 rail) was installed in `App\`, with `Archive\App-before-glass-office-20261001` (the `070c297` release, `2F1BD1DF…`) as its rollback. The roadmap had no entry for either; its new section 17 entry records them.

## 12. Board, sharp text, full name and a faster open (2026-10-01/02, user feedback)

The request, after the campus office: put the status board **behind** the director and move the director right so the two never overlap; the graphics turned **blurry** on a small zoom-in, so the board's letters could not be read; spell the building's name **in full** (not "QRO") and remove the small white letters below it; the app had become **slow to start**, so audit and optimise it; and the office's **loading screen** stayed blue for a while. During the work the user added that the letters still blurred and the office still took long to load (the installed App had not been rebuilt yet), and then asked for a loading screen in the theme's colours that says only "Loading…", instead of 1–2 s of blue, or a better idea.

| # | Request | Delivered |
|---|---|---|
| 1 | Board behind the director, director moved right | The director's row now starts one desk slot to the right, and the board takes that first slot, set 1.6 m back toward the living wall and 0.2 m left, still turned 45° to the default camera. From that camera the board stands above and to the left of the director, clear of the director, their name tag and the zone sign. Unit-tested for 1, 3, 4 and 5 directors, including a screen-space overlap test from the default camera. The studio rug and tree follow the new footprint. |
| 2 | Sharp at any zoom | Text is no longer a fixed-size texture. Each sign is a `TextSurface` that repaints at the resolution the current zoom needs (device pixels per metre = camera zoom × pixel ratio; up to 4,096 px wide, 160 ms after the zoom settles; 16× anisotropic filtering). That covers the board, the zone plaques, the floor lettering, the monitors and the building sign. The board was redrawn for it (header, three tiles WORKING / IDLE / MEETING with large numbers, and a "needs you" or "No alerts" line). The concrete texture doubled to 1,024² over 4 m. Shadows follow the view: the shadow camera is fitted to what is on screen, in 1.25× steps and snapped to whole texels so edges do not shimmer, so a 2,048² map is sharper close up than the old fixed 4,096² one. |
| 3 | Full building name | The canopy plate reads **QUANT RESEARCH OFFICE** in brass with a dark edge (7.0 × 0.62 m, fitted to the plate). The small white fascia letters are gone. |
| 4 | Faster start | See 12.1. Opening the store on a copy of the real workspace dropped from 1.17 s to 0.35–0.41 s (0.17–0.20 s once the integrity checkpoint has caught up). Building the 3D world dropped from 0.7–0.8 s to about 0.1 s. The page now appears about 1.0 s after launch (warm) instead of about 2.6 s, and the first office frame about 1.9–2.1 s after launch instead of about 2.7 s. |
| 5 | Loading screen in the theme's colours | The window and its startup page open in the last theme used (warm dark or light), and the startup page says only "Loading…". The page paints before the 3D engine starts. Until the first office frame, the stage is a plain panel in the theme's colours with "Loading…" in the middle and nothing else, which fades out in 0.25 s (no fade under reduced motion). The blue sky shows only once the office is drawn. |

### 12.1 What made the open slow, and what changed

Measured with a startup probe: a Playwright-driven dev build on empty scratch `QRO_USER_DATA_DIR`s with six fixture agents (never dispatched), dusk theme, renderer CPU profiles over CDP, and `node --cpu-prof` for the store on a read-only copy of the workspace file (the app itself was never started on that copy).

| Step | Cause | Change |
|---|---|---|
| Store open (`src/core/store.ts`) | Replaying events cloned the whole projection once per event (`structuredClone`). The background full-history check never finished: events written during startup changed the tip mid-scan, so the integrity checkpoint stayed where it was and every open replayed the same long tail. | Replays run in place (the commit path still clones). The background check resumes from where it stopped when the tip moves (up to 40 tries, 1.5 s apart), so the checkpoint reaches the tip. In the app, the background check starts 4 s after launch instead of competing with the first paint. On the workspace copy, the checkpoint moved to the tip (event 1,476). |
| Startup log (`src/main/main.ts`) | No timings. | `main.log` gets one line per launch: `startup window=… store=… services=… reconcile=… page=…`. |
| WebGL probe (`office-stage.tsx`) | A throwaway WebGL context on every open just to test support (about 0.12 s). | Removed. A GPU that refuses WebGL still makes the engine throw, and the page falls back to the classic floor as before. |
| World building (`office3d/kit.ts`) | Every box, cylinder and rounded box was a separate three.js geometry, then merged (and welded) into one: 0.7–0.8 s. | Unit shapes are cached once and written straight into growable typed arrays with their transform; one indexed mesh per batch, as before. A new test (`tests/office3d-kit.test.ts`) requires the same vertices, normals and triangles as the three.js geometry for every shape and rotation. |
| First frame (`office3d/engine.ts`) | Shader programs linked synchronously during the first draw and froze the page for about half a second. | Programs compile off the main thread (`compileAsync`, `KHR_parallel_shader_compile`) before the first draw, and fewer of them: materials that differed only in a flag share one program, and the transparent two-sided ones (rings, halos, the ball, floor lettering, the building sign) draw in one pass instead of a back-then-front pair. 11 programs on open. |
| Paint order (`office-stage.tsx`) | The engine was built inside the page's first render, about 0.65 s of work, so nothing appeared until it was done. The stage's sky showed blue while the canvas was still empty. | The engine starts after the first paint, as two tasks (start the GPU, then lay out the floor), with a fallback timer for a window that paints no frames. The stage shows the theme-coloured "Loading…" panel until the engine reports its first frame (`onReady`). |
| Window colour (`main.ts`, `main.tsx`, `scripts/build.mjs`) | The window and its startup page were always dark (`#101414`, "Opening your workspace…"), and the page's own colours were dark until the workspace was read, whatever the theme. | The main process keeps the last theme in a one-word file, `window-theme`, in the data folder (outside `workspace/`, so not part of backups), and the page keeps it in its local storage (`qro.theme`). Both follow the workspace setting. The window background is the page colour (`#171614` dark, `#f1f0e9` light), and the build writes `loading.html` and `loading-light.html`. |

**Found while testing: a backup race (`src/core/store.ts`, `src/main/artifacts.ts`).** `desktop.e2e` failed once with "Backup lineage tip does not match its manifest.". A backup copies the database, then reads the stored objects, and only then wrote the last event's hash into the manifest. An event recorded in between, such as a startup account check, made the manifest name an event the copy did not have, so the backup's own round-trip check refused it. A user could have seen a backup fail for no visible reason shortly after launch. The faster page now reaches that window sooner, which exposed it. `store.backup()` now returns the copy's own last event, read in the same synchronous step as the copy, and both manifest formats use it. A new test in `tests/artifacts.test.ts` records an event right after the copy; it fails with exactly that error on the old code and passes now.

What is left (warm, after the page has painted, on this laptop's integrated AMD GPU through ANGLE/Direct3D 11): about 0.2 s waiting for the GPU to finish the page's first paint, before the office's context can start; about 0.07 s for the room environment map; about 0.3 s laying out the floor; about 0.45 s compiling 11 programs; and about 0.2 s for the first draw. Two things were tried and dropped. Creating the context earlier only moved the 0.2 s wait. Warming WebGL from the startup page did not help, because WebGL's one-time setup is cheap here (40–60 ms). The next step would be to restructure the engine so the floor is laid out while the GPU is still busy (about 0.2 s). That was not done.

### 12.2 Measurements

Startup probe, warm (the same scratch folder relaunched), dusk, six agents, times from launch:

| | Before (`7192eb2`) | After |
|---|---|---|
| Page painted | about 2.6 s (blocked by the engine) | about 1.0 s |
| First office frame | about 2.7 s | about 1.9–2.1 s |
| Between them | blue sky | the theme's "Loading…" panel |
| First launch on a fresh folder (no caches) | 3.4–3.9 s to the office | about 2.7–2.8 s |
| Store open, copy of the real workspace | 1,173 ms | 354–412 ms; 173–195 ms once the checkpoint has caught up |
| Background full-history check | about 4 s of CPU, never conclusive | about 2.1–2.5 s in background slices, conclusive |

The light (day) theme is about 0.1 s faster to the first frame; it has no interior point lights.

### 12.3 Verification

| Check | Result |
|---|---|
| `prettier --check`, `tsc --noEmit` | clean |
| Unit suite | **1,073 tests: 1,072 pass, 0 fail, 1 existing skip** (+8: four batch-geometry tests in `tests/office3d-kit.test.ts`, two integrity-checkpoint tests, the board's screen-overlap test, and the backup-race test) |
| Dev-build desktop suites, scratch `QRO_USER_DATA_DIR` | `office3d` (webgl=true), `ui-revision`, `desktop.e2e`, `office-chat`, `revision`, `pipeline-request` and `pipeline` all pass with the loading-screen changes. `desktop.e2e` failed once on the backup race (12.1). After that fix, which touches the main process only, `desktop.e2e` and the unit suite were run again and pass. |
| Theme memory (scratch folder, dark workspace) | Three launches on a fresh folder with a dark workspace. **First:** opens light (`loading-light.html`, `#F1F0E9`), since nothing is remembered yet; turns `#171614` and saves `dark` once the workspace is read. **Second:** opens dark (`loading.html`, `#171614`); switching to Light in Settings saves `light` (file and local storage) and turns the window `#F1F0E9`. **Third:** opens light. |
| Packaged **test** build | Built from `084a823` (asar SHA-256 `31695F621196DECF8124CAFF2BEBBA07FE0842AFF0C6D15148F10C2BABD27DEA`): `office3d` (webgl=true), `desktop.e2e`, `ui-revision` and `revision` all pass. |
| Packaged **release** build and installed `App\` | Release build of `084a823`: the same asar, 95 files, with the RunAsNode, NodeOptions and NodeCliInspect fuses disabled. The App was not running. The previous App (the release of `7192eb2`, asar `BC1C8338…8B41`) was copied to `Archive\App-before-office-speed-20261002` (95 of 95 files hash-identical). The release was mirrored with `robocopy /MIR` (95 of 95 identical). Started on an empty scratch data folder: the "Quant Research Office" window opened, a workspace was created, and `main.log` was clean: `startup window=211ms store=227ms services=234ms reconcile=235ms page=377ms`. Only the processes the check started were closed. |
| Eyes | Board behind-left of the director with no overlap, crisp at zoom 80 and 245; the sign reads in full and crisp at zoom 140; the loading panel in both themes. Screenshots `after/office-speed-01…05` (dusk with the board, day, sign at zoom 140, loading dark, loading light) |

Not run: `agents.e2e.ts` and `three-agent.live.ts` (live providers), CI (no PR), a screen-reader pass, other GPUs.

### 12.4 Risks and limits

- The first launch after this update has no remembered theme yet, so it opens in the light colours and turns dark when the workspace is read if the workspace is dark. Every later launch opens in the right colours. The first launch also has no shader or code cache, so it is the slow case (about 2.8 s to the office).
- The fitted shadow camera re-fits only in 1.25× steps, so a slow zoom can show a small, rare jump in shadow sharpness.
- Chromium uses the integrated AMD GPU, not the RTX 3060; nothing here changes that.
- The status board lost its old "beside the last director desk" slot; the layout test and the roadmap rule were updated to "behind and left of the director".
