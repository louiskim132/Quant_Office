# Desktop parallel-session operating manual

This is an operating manual for the D2 process in `docs/ROADMAP.md` section 1.5. It does not replace the roadmap. The roadmap remains the only product plan and current-state record. The files under the batch's shared directory are per-round coordination records only.

## 1. The fixed layout

Use eight persistent desktop sessions:

| Desktop session | Role | Writes product code? | Responsibility |
| --- | --- | --- | --- |
| 1–7 | `worker-1` through `worker-7` | Only when its current packet says `CODE`, and only inside its listed `allowedPaths` | Implement one bounded packet, test it, commit it and submit the exact commit for review |
| 8 | `organizer` | Yes, but only in the organizer checkout | Plan a round, publish seven slots, review exact worker commits, integrate accepted work, run combined checks and update the roadmap |

Each session has a different Git worktree and branch. All eight checkouts use one shared handoff directory. No chat-to-chat communication is assumed. `tools/desktop.mjs` is the mailbox and state machine.

The setup does **not** create Devin, Codex or Claude sessions, select a model, grant a GitHub repository, or make a hosted filesystem see Windows files. This workflow requires all eight sessions to have direct access to the listed local folders and the shared handoff directory. If Devin runs in an isolated hosted clone, use GitHub PRs and the general protocol in roadmap section 1.5 instead; do not pretend the local mailbox is connected.

## 2. One-time desktop setup

Open the generated `START-HERE.md` in the batch directory. It lists the exact eight folders. Create one desktop session per folder and keep that folder as the session's working directory. Do not open the parent repository for any of these eight roles.

Paste this once into **each** session:

> Read SESSION.md in this folder. Run `node tools/desktop.mjs status` from this folder and verify the reported session number, role, checkout and shared folder. Read `docs/DESKTOP-SESSIONS.md`. Confirm only the session number and role, then wait. Do not edit product code, change branch, publish a round or infer work from prior chat.

If `node` is not on `PATH`, the session uses:

```powershell
& 'C:/Program Files/nodejs/node.exe' tools/desktop.mjs status
```

Expected roles are Session 1 = `worker-1`, through Session 7 = `worker-7`, and Session 8 = `organizer`. A mismatch is a hard stop. Never edit `.session.json` or copy `SESSION.md` to another checkout.

After this one-time step, the normal human interaction is:

1. Send the complete feature request to Session 8.
2. Wait until Session 8 prints `WORK READY`, the round ID and the coding/idle slots.
3. Type `start` once in each of Sessions 1–7. An idle session will report `IDLE` and stop.
4. Wait for every coding session to report `READY FOR REVIEW` or `BLOCKED`.
5. Type `review` in Session 8.
6. Session 8 reviews, integrates, tests, updates the roadmap and reports the integration branch/commit and PR status.

Typing `start` before `WORK READY` is safe: the worker must run the helper, receive `NOT_READY`, make no edits and wait.

## 3. Session 8: prepare and publish a round

When the user gives a request, Session 8 follows every step below.

### 3.1 Establish current truth

From the organizer checkout:

```powershell
git status --short --branch
git rev-parse HEAD
git branch --show-current
git rev-parse --show-toplevel
node tools/desktop.mjs status
```

The organizer branch and checkout must match `status`; the checkout must be clean. Read:

- `AGENTS.md`;
- roadmap section 1, especially the execution boundaries in 1.1;
- the D2 progress row in roadmap section 11;
- the exact task packet or roadmap area implicated by the user's request;
- relevant source symbols and tests, using roadmap section 1.3 as navigation.

Do not convert a vague request into seven overlapping guesses. Inspect the current code first. Decide the smallest coherent slices. Fewer than seven code tasks is normal; every unused slot must be `IDLE`.

If workers need a shared interface, schema, dependency, IPC contract, agent-rule change, CI change or roadmap change, Session 8 owns that prerequisite. Implement and test the prerequisite in the organizer checkout, commit it, and only then publish. Publication freezes the organizer's current `HEAD` as the base for all seven worker branches.

### 3.2 Design disjoint packets

Every `CODE` packet must contain:

- one observable objective;
- exact `allowedPaths` that no other active packet owns;
- the small set of existing `readPaths` needed for context;
- ordered implementation steps with named modules, behavior and edge cases;
- acceptance criteria that can be evidenced;
- exact checks, including the directory from which the worker runs them.

Directory ownership ends with `/`, for example `app/src/renderer/components/`. File ownership names one exact file. Avoid assigning broad directories merely to bypass overlap checks. Workers cannot own `AGENTS.md`, `CLAUDE.md`, `.github/`, `.gitignore`, `SESSION.md`, `.session.json`, `tools/`, the roadmap/manual, shared types, preload, main registration, store schemas or dependency manifests. Session 8 handles those integration surfaces.

Do not split tightly coupled edits that cannot compile independently. Prefer vertical slices with separate files/tests. If two tasks need the same file, make them sequential rounds or keep that work in Session 8.

### 3.3 Create the plan

First ask the helper for a draft in Session 8's `draftFolder` shown by `status`:

```powershell
node tools/desktop.mjs template C:/absolute/shared/drafts/organizer/round-001-plan.json
```

Use a new lowercase round ID such as `ui-shell-001`. Never reuse an old round ID. Edit the draft so it has exactly seven workers. Example:

```json
{
  "id": "ui-shell-001",
  "request": "Improve the project shell without changing research execution boundaries.",
  "workers": [
    {
      "id": "worker-1",
      "mode": "CODE",
      "objective": "Add the bounded navigation component and its unit coverage.",
      "allowedPaths": [
        "app/src/renderer/navigation.tsx",
        "app/tests/navigation.test.ts"
      ],
      "readPaths": [
        "docs/ROADMAP.md",
        "app/src/renderer/main.tsx",
        "app/src/renderer/styles.css"
      ],
      "steps": [
        "Inspect the existing route state and renderer test conventions.",
        "Implement the component without adding authority to the renderer.",
        "Add positive and negative regressions for the named behavior."
      ],
      "acceptance": [
        "Navigation renders the existing destinations in the specified order.",
        "An unavailable destination remains visibly disabled and cannot mutate state."
      ],
      "checks": [
        "pnpm --dir app exec tsx --test tests/navigation.test.ts",
        "pnpm --dir app exec tsc --noEmit"
      ]
    },
    {
      "id": "worker-2",
      "mode": "IDLE",
      "objective": "No independent task in this round."
    }
  ]
}
```

The real file must include workers 1–7. Remove every `REPLACE_ME`. `readPaths` must already exist. An `IDLE` slot has no `allowedPaths`.

Before publication, Session 8 checks the request against product boundaries, ownership overlap, shared-interface dependencies and expected integration order. Then publish exactly once:

```powershell
node tools/desktop.mjs publish C:/absolute/shared/drafts/organizer/ui-shell-001-plan.json
```

Only a successful result with `"state": "WORK_READY"` authorizes the announcement. Session 8 replies in this exact shape:

```text
WORK READY
Round: ui-shell-001
Base: <full SHA>
Coding: worker-1, worker-3, worker-5
Idle: worker-2, worker-4, worker-6, worker-7
Type start in Sessions 1–7.
```

Never hand-edit `current.json`, `round.json`, `started/`, `results/`, `reviews/` or `decisions/`. They are generated coordination records. If publication fails, do not announce readiness.

## 4. Sessions 1–7: execute `start`

On the user's message `start`, the worker does not interpret the chat as its assignment. It runs:

```powershell
git status --short --branch
git rev-parse HEAD
git branch --show-current
git rev-parse --show-toplevel
node tools/desktop.mjs status
node tools/desktop.mjs start
```

Then obey the returned state:

| State | Required action |
| --- | --- |
| `RUNNING`, `resume: false` | Read and execute only the returned `task` |
| `RUNNING`, `resume: true` | Continue only if this is the same desktop session that already owns the work; otherwise stop because two writers may exist |
| `IDLE` | Say `IDLE for <round>; no edits made` and stop |
| `NOT_READY` or `PREPARING` | Say the round is not ready, make no edits and stop |
| `READY_FOR_REVIEW`, `INTEGRATED`, `REJECTED`, `BLOCKED` or `CLOSED` | Make no new edits; report the state and stop |

The JSON returned by `start` is authoritative. Do not copy work from another session, choose a roadmap item, expand `allowedPaths`, edit another worktree, switch branches, pull, merge, rebase or reset.

### 4.1 Implement safely

Read the packet's `readPaths` and only the additional callers needed to understand the assigned behavior. Before editing, confirm every file to be changed is covered by `allowedPaths`. If a necessary edit falls outside scope, stop and use `block`; do not make the edit and do not ask another worker directly.

Run application commands from `app`. Packet check strings should be directly executable from the checkout root, normally using `pnpm --dir app ...`. If dependencies are absent, each checkout installs its own locked dependencies:

```powershell
cd app
pnpm install --frozen-lockfile
```

Do not share or junction a writable `node_modules`. Do not use production app data. Do not run live-provider, paid API, brokerage, real holdout or research fixtures unless the packet explicitly authorizes the exact operation and roadmap gates allow it.

Implement the full packet, including specified negative cases. Do not weaken gates or tests to get green output. Run every required check exactly as listed and any narrow diagnostic checks needed. Preserve the real exit code and result; a check that did not run is not exit code 0.

Review the final diff:

```powershell
git status --short
git diff --check
git diff
```

Commit only owned paths. Never use `git add .`:

```powershell
git add -- app/src/renderer/navigation.tsx app/tests/navigation.test.ts
git diff --cached --check
git commit -m "Implement bounded navigation packet"
git status --short
git rev-parse HEAD
```

The checkout must be clean before submission.

### 4.2 Submit the immutable result

Create a JSON report in the worker's `draftFolder`, outside the Git checkout. The `round` and every `criterion` must exactly match the `start` output. Every required check command must exactly match the packet text. Example:

```json
{
  "round": "ui-shell-001",
  "summary": "Added bounded navigation with disabled-route coverage.",
  "checks": [
    {
      "command": "pnpm --dir app exec tsx --test tests/navigation.test.ts",
      "exitCode": 0,
      "result": "4 tests passed, 0 failed."
    },
    {
      "command": "pnpm --dir app exec tsc --noEmit",
      "exitCode": 0,
      "result": "TypeScript completed with no diagnostics."
    }
  ],
  "acceptance": [
    {
      "criterion": "Navigation renders the existing destinations in the specified order.",
      "passed": true,
      "evidence": "The new unit case asserts the complete ordered label list."
    },
    {
      "criterion": "An unavailable destination remains visibly disabled and cannot mutate state.",
      "passed": true,
      "evidence": "The negative case asserts disabled state and zero callback calls."
    }
  ],
  "roadmapEntry": "Changed navigation.tsx and navigation.test.ts; no schema, IPC, dependency or migration impact; targeted unit and typecheck passed; no provider operations ran."
}
```

Submit it:

```powershell
node tools/desktop.mjs finish C:/absolute/shared/drafts/worker-1/ui-shell-001-result.json
```

Success returns `READY_FOR_REVIEW` and the full submitted SHA. Reply:

```text
READY FOR REVIEW
Round: ui-shell-001
Worker: worker-1
Commit: <full SHA>
Checks: <brief actual results>
Blockers: none
```

Stop editing after submission. A second `finish` is correctly refused. Do not amend or add commits while waiting for review.

If work cannot honestly satisfy the packet, preserve the checkout and report the concrete blocker:

```powershell
node tools/desktop.mjs block "Required shared type is organizer-owned; current interface lacks the requested field."
```

Report `BLOCKED`, the round and the exact reason. Never invent passing evidence.

## 5. Session 8: review and integrate

On the user's message `review`, Session 8 runs:

```powershell
node tools/desktop.mjs review
git status --short --branch
git rev-parse HEAD
```

Read all seven rows. `ASSIGNED` or `RUNNING` means review is premature; wait for that worker. `IDLE` needs no decision. A `BLOCKED` worker may be rejected after understanding the blocker. A `READY_FOR_REVIEW` worker is eligible only when `scope` is `PASS`.

For each eligible worker, one at a time:

1. Record the submitted full SHA and round base from the review output.
2. Inspect the actual commit, not pasted code: `git show --stat <SHA>`, `git diff --check <base> <SHA>` and `git diff <base> <SHA> -- <allowed paths>`.
3. Read affected callers and tests. Check interfaces, persistence/replay, migrations, IPC/main/preload symmetry, authority boundaries, accessibility and old-record compatibility as applicable.
4. Independently run the packet checks where practical. A worker's report is provenance, not independent acceptance.
5. Check compatibility against the organizer's **current** `HEAD`. This changes after every accepted merge, so never reuse an earlier `againstHead`.
6. Create one assessment JSON in `drafts/organizer` and accept or reject.

Assessment example:

```json
{
  "round": "ui-shell-001",
  "workerSha": "<full submitted SHA>",
  "againstHead": "<full current organizer HEAD>",
  "summary": "Reviewed the exact diff and reran its focused tests.",
  "checks": [
    {
      "command": "pnpm --dir app exec tsx --test tests/navigation.test.ts",
      "exitCode": 0,
      "result": "Independent rerun: 4 passed, 0 failed."
    }
  ],
  "compatibility": [
    "No shared type, preload, IPC, schema or dependency change.",
    "Current organizer renderer callers still compile with the new component.",
    "Disabled route preserves the renderer-authority boundary."
  ]
}
```

Accept the exact SHA:

```powershell
node tools/desktop.mjs accept worker-1 <full-submitted-SHA> C:/absolute/shared/drafts/organizer/ui-shell-001-worker-1-review.json
```

The helper merges only into the organizer checkout. It never updates `main`. After each acceptance, inspect the merge and current `HEAD`. Review the next worker against that new head.

Reject a submitted or blocked packet with a specific reason:

```powershell
node tools/desktop.mjs reject worker-3 "The submission changes an unassigned contract and lacks old-record compatibility coverage."
```

When a rejected worker can fix the problem within the same round and scope, Session 8 may reopen the slot instead of planning a new round:

```powershell
node tools/desktop.mjs reopen worker-3 "Add the missing old-record compatibility test; the scope is unchanged."
```

`reopen` works only on a `CODE` worker whose decision is `REJECTED`. It keeps the rejection and the superseded result as archived records, and returns the slot to `RUNNING`. The same worker session then fixes, commits and runs `finish` again with a fresh report; the packet, base and allowed paths do not change.

Do not repair a worker by editing its checkout or copying its entire folder. A small integration-only correction may be made and committed in Session 8. A material redesign becomes a new round after the current round is resolved and closed.

### 5.1 Merge conflicts

If `accept` reports a merge conflict, worker files and the submitted SHA remain untouched. In the organizer checkout:

1. Run `git status` and inspect every conflict against the worker diff and current organizer behavior.
2. Resolve narrowly; never use blanket `ours` or `theirs`.
3. Run affected checks and `git diff --check`.
4. Stage the resolved files explicitly and commit the merge resolution.
5. Re-review the same worker SHA against the new organizer `HEAD`, create a fresh assessment with that `againstHead`, and call `accept` again with the same submitted SHA. Git will confirm ancestry and the helper will finalize the decision.

Do not reset, abort and discard someone else's work merely to clear the state.

## 6. Combined verification and round closure

When every worker is `IDLE`, `INTEGRATED` or `REJECTED`, Session 8 owns the combined result.

1. Inspect the organizer branch as a whole and make any narrow integration fixes.
2. Update the relevant roadmap map/progress/log entry with actual changed files, commands, results, compatibility/migration impact, fixture versus provider evidence, blockers and exact next item.
3. Commit the roadmap and integration fixes explicitly.
4. From `app`, run the combined checks required by the change. At minimum the close report requires actual unit, typecheck and build checks. UI/IPC changes also require the affected desktop fixture. Packaging/native checks are required only for a release/package scope.
5. Confirm the organizer checkout is clean and record its final full `HEAD`.

Typical full local source checks from `app` are:

```powershell
pnpm exec tsc --noEmit
pnpm exec tsx --test --test-concurrency=4 tests/*.test.ts
node scripts/build.mjs
```

Use the roadmap's current commands when they differ. Never claim a provider, custody, brokerage or scientific gate from these local checks.

Create the close report in `drafts/organizer`:

```json
{
  "round": "ui-shell-001",
  "head": "<full final organizer HEAD>",
  "summary": "Integrated accepted packets and verified the combined source.",
  "checks": [
    {
      "kind": "unit",
      "command": "pnpm --dir app exec tsx --test --test-concurrency=4 tests/*.test.ts",
      "exitCode": 0,
      "result": "382 passed, 0 failed."
    },
    {
      "kind": "typecheck",
      "command": "pnpm --dir app exec tsc --noEmit",
      "exitCode": 0,
      "result": "No diagnostics."
    },
    {
      "kind": "build",
      "command": "pnpm --dir app build",
      "exitCode": 0,
      "result": "Build completed successfully."
    }
  ],
  "roadmapEntry": "docs/ROADMAP.md section 11 entry committed in <full final organizer HEAD>."
}
```

Counts above are examples; record only the current actual outputs. Close:

```powershell
node tools/desktop.mjs close C:/absolute/shared/drafts/organizer/ui-shell-001-close.json
```

Only `CLOSED` is a completed round. Session 8 then pushes its integration branch and opens or updates one PR into protected `main`. Before merging it, Session 8 must perform this final gate against the exact PR-head SHA:

1. Fetch the remote and record `git rev-parse HEAD` and `git rev-parse origin/main`.
2. Run `git merge-base --is-ancestor origin/main HEAD`. Exit 0 means the organizer branch contains current main. If it does not, merge `origin/main` into the organizer branch, resolve narrowly, rerun combined verification, update the close evidence as required, push, and wait for replacement CI.
3. Confirm the PR targets `main`, its head is the recorded organizer SHA, every required conversation is resolved, GitHub reports it mergeable, and the required `verify` check completed successfully for that exact SHA. A green check on an older SHA is stale and does not authorize a merge.
4. Session 8 may merge the integration PR through the authenticated GitHub PR interface. Direct pushes such as `git push origin HEAD:main` remain prohibited. Sessions 1–7 never merge into `main`.
5. If Session 8 cannot inspect or perform the protected PR merge through an authenticated GitHub route, it reports the PR URL and exact blocker to the user. It never asks for, prints or stores a raw GitHub token and never substitutes a direct push.

After the PR merge, Session 8 reports the merged PR URL, merge commit, exact checks and any remaining local-sync/package step. Preserve round records and worker branches until the accepted integration is safely merged.

The next user request may reuse the same eight desktop sessions. Session 8 publishes a unique new round from its accepted clean `HEAD`; the helper switches each clean worker checkout to a new branch. The user again types `start` in Sessions 1–7.

## 7. Recovery rules

| Symptom | Meaning and required response |
| --- | --- |
| `NOT_CONFIGURED` | Wrong folder or setup missing. Open the exact folder from `START-HERE.md`; do not create a new identity file. |
| `NOT_READY` | Session 8 has not published. No edits. |
| `PREPARING` | Publication did not finish switching all workers. No worker edits. Session 8 inspects every checkout, branch and the preserved round record before recovery; never delete the round to hide a partial operation. |
| `Wrong worker branch` / `Unexpected branch` | Stop. Do not switch, reset or rebase manually. Session 8 reconciles the exact preserved branch and uncommitted state. |
| `Uncommitted work` | Preserve and inspect it. It may belong to a live session. Never clean, stash or discard it blindly. |
| `STATE_LOCKED` | Another operation may be updating the mailbox. The helper already retries for ten seconds. Wait and retry once; never delete the lock while another process may be active. |
| `RUNNING` in a second desktop chat | Possible second writer. Do not edit. Return to the original session or let Session 8 resolve ownership. |
| `READY_FOR_REVIEW` | Submission is immutable. No worker edits or amended commits. |
| Worker moved after submission | The submitted SHA is still preserved, but the checkout changed. Session 8 rejects it or preserves the new commit for a later round; never approve a different SHA silently. |
| Failed or unexecuted check | Worker uses `block`; reviewer rejects. Do not record exit code 0. |
| Out-of-scope path | Submission is refused. Preserve the commit and let Session 8 rescope it in a later round. |
| Stale round/report/review/head | Regenerate the report or assessment from current `status`/`review`. Never edit published state to make stale evidence fit. |
| `MERGE_CONFLICT` | Resolve only in Session 8 using section 5.1. Worker remains untouched. |
| `BLOCKED` | Session 8 reads the blocker and rejects or plans a later round. Worker makes no further edits. |
| `REJECTED`, fixable in this round | Session 8 may `reopen` the slot with a reason (section 5). The worker then continues in the same session and submits a fresh report. |
| `CLOSED` | No further work belongs to that round. Wait for a newly published round. |
| Published packet hash changed | Stop all sessions. The immutable task record was modified; recover from Git/filesystem evidence instead of trusting it. |

## 8. Guarantees and limits

The helper enforces role/folder binding, one immutable current packet, seven complete slots, disjoint declared write scope, protected integration files, frozen base commits, clean preconditions, exact submitted SHAs, stale-review refusal, atomic result records and organizer-only merging. Its regression suite launches seven simultaneous `start` commands.

It cannot prove that a human did not open the same folder in two applications, authenticate a model/provider, independently verify the truth of a reported test, make a hosted clone see local files, or guarantee semantic compatibility. GitHub protection remains a separate control. Session 8 must independently review and test and may merge only through the protected exact-head PR gate above.
