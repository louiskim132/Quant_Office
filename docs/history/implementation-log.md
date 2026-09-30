# Implementation failure log

Every command failure, refused operation and external blocker hit while working through
`docs/ROADMAP.md`, with its exact output, so it can be reviewed rather than summarized.

Entries are newest last. Passing checks and current status are maintained in sections 11–12 of `docs/ROADMAP.md`. This file contains raw historical failure evidence, not a separate roadmap.

---

## 2026-09-07 · Claude cloud attach rejected by approval review

Operation: official CLI attach to the existing cloud session `session_01Aj1hpgmeoZLdgYVR9eQ6PB`
(`claude --cloud <session-id>`, not `--teleport`).

Outcome: **did not execute.** Automatic approval review rejected the escalation because the review
service reported a usage limit. The rejection explicitly prohibited a workaround or indirect bypass.

Status: unresolved, external. Not routed around. The session's completion, output, applied settings
and cancellation therefore remain unverified, and the office records hosted execution as UNKNOWN
rather than DOCUMENTED for those operations.

---

## 2026-09-08 · `npm install node-pty@1.1.0` crashed on a pnpm-managed tree

Command, run in `app/`:

~~~
npm install node-pty@1.1.0 --save
~~~

Output:

~~~
npm error Cannot read properties of null (reading 'matches')
npm error A complete log of this run can be found in:
C:\Users\louis\AppData\Local\npm-cache\_logs\2026-09-08T07_50_00_094Z-debug-0.log
~~~

From that log:

~~~
verbose stack TypeError: Cannot read properties of null (reading 'matches')
    at Link.matches (...\@npmcli\arborist\lib\node.js:1183:41)
    at Link.canDedupe (...\@npmcli\arborist\lib\node.js:1127:15)
    at PlaceDep.pruneDedupable (...\@npmcli\arborist\lib\place-dep.js:426:14)
...
idealTree:node_modules/.pnpm/lucide-react@1.41.0_react@19.2.8/node_modules/lucide-react
~~~

Cause: `app/node_modules` is a pnpm store layout (`node_modules/.pnpm/...`); npm's arborist crashed
walking the symlinked tree. Not a defect in this application.

Resolution: use `pnpm` for dependency changes in this project. Nothing was written to
`package.json` or `node_modules` by the failed run.
