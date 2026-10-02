# Office behavior revision - 2026-10-02

Implemented and installed the user's three requested office revisions. Local changes only; nothing pushed or merged.

## Requested Behavior

- Agents begin in the rest area. When a related project has observed WORKING or MEETING activity, its request participants, leads, assigned agents and current project/team members attend their desks, even when their own job is idle. Their actual status and typing animation continue to follow their own recorded activity. Meeting participants still use their meeting room.
- A fresh, unreset allowance window with 5% or less remaining overrides project attendance and meetings, keeping the agent in the rest area. Unknown allowance is not displayed as 0%. Project completion returns related agents to rest.
- Campus roof slabs, parapets, pavilion roofs and office roof edges use white. Glazing ends below the roof slab and framing ends at its underside, eliminating overlapping blue and white top faces. Rooftop equipment retains its existing material.
- Holding the left mouse button moves the view; holding the right rotates it. Wheel zoom, keyboard rotation, reset, touch gestures and left-click agent selection remain available. Right-clicking the canvas no longer selects an agent, and releasing Space cannot restore the previous mouse mapping. Obsolete control hints were removed.

## Bugs Found During Verification

- Lounge capacity was fixed at 17. Extra cafe seating now grows with the roster. Stable high-numbered lounge slots remain valid when earlier agents are removed; changes in lounge geometry also rebuild the rendered scene.
- A queued walk could survive a newer location change or fire from an old arrival timer. The current walk now retains only the latest destination, and arrival pauses run through the same animation loop. Two deterministic walking regressions cover these cases.
- Lounge name tags could cover another agent's status dot and block its hover/click target. Tag placement reserves each agent's clickable dot, shifts crowded tags locally, and raises hovered/focused tags above their neighbors. All seven fixture tags and the packaged director tag were exercised successfully.

## Verification

- Locked install: `pnpm install --frozen-lockfile` passed; dependencies and lockfile unchanged.
- Full suite: `pnpm test` passed with 1,075 passing, 1 skipped, 0 failed (1,076 total). The run was started before the final walking and tag adjustments.
- After those adjustments, focused attendance, walking and layout tests passed: 22/22. Earlier activity/geometry/layout coverage also passed: 32/32.
- Final `pnpm typecheck`, changed-file Prettier check and `git diff --check` passed.
- `pnpm exec tsx tests/office3d-revision.desktop.ts` passed against the actual React/WebGL components with synthetic records. Checks cover rest defaults, project-wide attendance with only one agent active, unrelated agents, project completion, 5% versus 5.1%, meeting override, roster growth/removals, tag hover, left/right mouse drags and Space release.
- Roof inspection: 192 downward ray samples across six campus buildings in light and dark themes hit white roof geometry. The roof screenshot was visually checked and shows a solid white surface.
- Nonblank canvas pixels and screenshots were checked at 1440 x 1000, 1000 x 800 and 390 x 844, plus a 50-agent roster. Static preview screenshots use reduced motion; walking queue behavior is covered separately by the deterministic engine tests.
- Build and package passed. `QRO_EXECUTABLE=<packaged exe> pnpm exec tsx tests/office3d.desktop.ts` passed with WebGL enabled. This exercises the real window, default rest locations, hover/detail selection, names, tool rail, camera buttons/drag/wheel/keyboard, chat and Classic/3D switching.
- Test profiles: Test dir 1, Test PM A-D and Test worker 1-2 use synthetic Devin SWE-2 / max profiles, with additional synthetic overflow workers. No provider was dispatched.
- The test build's inspector fuse was disabled after acceptance. Both release and installed executables have RunAsNode, NodeOptions and Node CLI inspector fuses disabled.
- Installed hardened release smoke passed on a newly empty `QRO_USER_DATA_DIR`: `C:\Users\louis\AppData\Local\Temp\qro-office-install-53RxAc`. The Office heading and first WebGL frame rendered. User data was not accessed or modified.

## Source And Installation

- Base: `f4af1095d6b883c08b8228018bd282d86ca14e52`, retaining the preceding office/startup changes.
- Branch: `codex/office-behavior-20261002`.
- Worktree: `C:\Users\louis\Desktop\AI\Quant Office\Worktrees\office-behavior-20261002`.
- Installed app: `C:\Users\louis\Desktop\AI\Quant Office\App\Quant Research Office.exe`.
- Installed `resources\app.asar` SHA-256: `6618F0CCE8F3F8E4ED69E3A6F40231F19F5C89DADFB15C3EE5547508A717C500`. The release and installed hashes match.
- Rollback: `C:\Users\louis\Desktop\AI\Quant Office\Archive\App-before-office-behavior-20261002`. Its asar matches the previous install: `31695F621196DECF8124CAFF2BEBBA07FE0842AFF0C6D15148F10C2BABD27DEA`.
- Evidence: `C:\Users\louis\Desktop\AI\Quant Office\Docs\Reviews\office-behavior-2026-10-02\` contains screenshots, browser and packaged reports, installed smoke report and full unit output. The reusable synthetic preview and acceptance scripts are under `app/tests/`.

Organizer roadmap note: the office rest/project/allowance policy, white roof repair and left-pan/right-rotate controls are verified locally and installed on this branch; existing external release gates are unchanged.
