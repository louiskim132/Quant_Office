> Historical architecture specification. Current runtime status and superseding constraints: [readiness matrix](../app/docs/readiness.md). Fixed-team and API-budget provisions below are not active product defaults.

# Desktop experience — architecture 0.3

The initial product is a Windows desktop app launched by an EXE or Start-menu shortcut. Normal operation requires no terminal, localhost URL, browser tab, local Python environment or Docker service. The office is the primary visual workspace; structured panels make the research record accessible without navigating a game.

## Visual direction

[DeskRPG](https://github.com/dandacompany/deskrpg) is the reference for a pixel-art office with agent characters, task interactions and a meeting area. Use an original quant research office layout and assets. Reusing repository code or third-party art is a separate licensing/engineering decision; this architecture adopts the interaction direction, not its deployment stack.

The office contains a Director desk, four labeled PM desks, two worker desks, a review room, a task board and an artifact cabinet. Each senior character has a fixed role/name label and a provider/model badge. Worker characters display their current supervising PM and task. Desks remain visible while inactive; an idle avatar generates no provider calls.

The scene uses a subdued dark workspace, warm desk lighting, crisp pixel characters, readable interface typography, and distinct status badges with text as well as color. Pixel art is confined to the office; dense metrics, forms, diffs and reports use normal accessible text. A reduced-motion setting replaces walking and desk animations with status changes.

## Window layout

```text
┌ Quant Research Office ─ Project ▾ ─ Experiment ▾ ─ Connected ─ Spend ┐
│ Projects     │                         │ Selected agent / record    │
│ Experiments  │   DIRECTOR              │ Role and model             │
│              │       desk             │ Current bounded task       │
│ Office       │                        │ Input bundle and progress  │
│ Tasks        │ PM-A desk   PM-B desk   │                            │
│ Research     │                        │ Messages / submitted report│
│ Reviews      │ PM-C desk   PM-D desk   │                            │
│ Artifacts    │                        │ Evidence / limits / actions│
│ History      │ WORKER 1    WORKER 2    │                            │
│ Spend        │                        │                            │
│ Settings     │ Review room · Task board · Artifact cabinet         │
├──────────────┴────────────────────────┴────────────────────────────┤
│ To: Director ▾  [Describe the research goal…] [Attach] [Send]        │
│ Activity: verification report received · 1/2 worker slots occupied │
└───────────────────────────────────────────────────────────────────┘
```

At smaller window sizes, the right inspector becomes a drawer. All actions are also available through labeled navigation and keyboard controls. Office movement is optional presentation; the user never has to walk a character to approve a package or inspect a report.

## Screen specifications

| Screen | Required content | Main interactions |
| --- | --- | --- |
| Setup | Provider target/access badges, hosted execution capabilities, credential status, budgets, archive/Git configuration | Connect accounts, run a bounded capability probe under approved budget, save settings |
| Projects | Mandate, owner, priority, current experiments, budget and blockers | Create project, select project, archive completed project through recorded action |
| Office | Role characters, task badges, worker capacity, selected project context | Select agent, open task, send scoped prompt |
| Agent inspector | Role, requested/resolved model, task contract, public activity, report and tool receipts | Message role, inspect evidence, request pause/cancel within authority |
| Task board | Queued, dispatched, running, awaiting PM review, blocked, failed and accepted tasks | Inspect lineage, request bounded retry, see remaining repair/runtime budget |
| Research contract | Hypothesis, model/output meaning, data rules, metrics, scientific policy, exposures and budget | Edit draft, compare versions, submit review, inspect freeze decision |
| Review room | Shared bundle identity, independent first-report submission status, revealed reports, objections, rebuttals, Director decision | Submit position, reveal automatically when eligible, inspect evidence, record bounded decision |
| Artifacts | Source release, tests, dependency lock, reports, inventories and approved package versions | Preview safe text, export archive, import user-selected result files |
| Results | Imported provenance, integrity/consistency status, hosted verification and C/D findings | Submit imported copy for provider analysis, compare contract-defined metrics |
| History | Append-only events, amendments, abandoned attempts and invalidations | Filter, inspect original positions, export audit trail |
| Spend | Reservations, estimated/actual usage, unknown charges, task/project caps | Set user-owned limits, reconcile provider usage, inspect blocked dispatch |

## Prompt-to-task interaction

1. The user types a mandate, such as “Research a volatility forecast using this dataset,” and attaches explicitly selected inputs.
2. The Director receives the mandate on provider infrastructure and returns a proposed research contract and bounded plan.
3. The UI shows meaningful scientific choices and open facts in a readable contract card. Routine task decomposition continues under accepted scope; required user decisions are shown in one action inbox.
4. PM tasks appear on the board and workers take seats when their actual provider jobs start. Selecting a badge opens the exact task and evidence.
5. Completed worker output appears first at the supervising PM's desk. The Director receives PM-reviewed positions through the recorded review protocol.

The prompt composer displays its recipient and experiment. A casual chat message is not silently treated as an approval, spending increase or claim that an execution gate passed. Structured decisions are derived from authenticated user/role actions and validated against the current bundle.

## Animation and truthfulness

| Recorded state | Office behavior |
| --- | --- |
| Idle / queued | Character seated, with an explicit idle/queued badge |
| Provider inference active | Working animation; show “Reasoning on provider” rather than invented detailed thought |
| Hosted tool job active | Execution badge and actual job elapsed time |
| Worker output awaiting PM | Report marker at supervising PM; no completion celebration yet |
| Review pending | Review-room badge; report content remains hidden to counterpart until disclosure gate |
| Blocked | Named blocker and owner; no looping busy animation |
| Waiting for user-run results | Characters idle for this experiment; “Waiting for your imported files” |
| Accepted | Brief completion animation linked to an acceptance event |
| Connection lost | “Status unknown; last update …”; do not display a fabricated failure or completion |

Meetings display submitted reports, authorized exchanges and summaries. They do not expose hidden model reasoning. Replayed event animations are marked as history, not live work. The meeting button cannot bypass independent first reports or launch unbounded discussion.

## Colab-free user flow

The artifact screen offers “Export finalized code” and “Import my results.” It may display static instructions explaining that the user runs the package independently in Colab. There is no “Connect Colab,” “Open Colab,” “Run notebook,” “Check runtime,” “Mount Drive,” session selector, embedded Colab window or background poll.

An imported notebook is displayed as sanitized text and metadata only. No notebook cells are run locally, and links are not followed by agents. The user selects actual result files; entering a Colab URL is not an import mechanism. A user-import event is the only trigger for analysis of returned external results.

## Desktop lifecycle and distribution

Use Electron Forge to produce a Windows installer and executable launch entry. Build dependencies, renderer assets and compatible SQLite bindings are bundled; development tooling is not required on the user's device. Verify install, launch, file selection, credential persistence, restart and uninstall in a clean Windows environment. [Electron packaging](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)

Persist user data outside the installation directory. Before a schema migration, save a consistent recovery snapshot and verify compatibility. Updates apply only at an idle/safe point and never invalidate project records silently. Release signing material stays in the build service; it is not accessible to research workers. Uninstall must not silently delete research history.

Closing the main window defaults to stopping new coordination and exiting after persisting state. If jobs are active, show that they may continue remotely and offer explicit cancellation. A later optional tray mode requires an explicit user setting and a visible “controller active” indicator. No hidden always-running agent service is required.

## UI acceptance

- A clean Windows user can complete setup, submit a task, inspect independent review, export code and import results without a terminal.
- Office badges and the task board reflect the same controller events, including restart and offline states.
- Keyboard navigation and reduced motion cover the same actions as the office scene.
- No demo metric or mock task is presented as measured live research.
- Provider secrets never appear in renderer state or logs; hostile report markup cannot execute.
- Search of menus, commands, routes and dependency bindings finds no Colab control capability.

This document specifies the interface; an EXE and visual prototype have not yet been built.
