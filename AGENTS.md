# Repository agent instructions

This repository supports parallel Codex and Claude Code sessions through Git worktrees.

- Before changing code, read `docs/ROADMAP.md` section 1, the progress table in section 11, and the exact current task packet. The roadmap is the single source of truth; do not create a competing plan or continuation file.
- Record `git status --short --branch`, the current commit, branch, and worktree before editing. Treat stale roadmap hashes as navigation hints, not proof.
- Use one writer per checkout. Every parallel implementation session must use its own worktree and feature branch based on `origin/main`. Never let Codex and Claude Code edit the same directory concurrently.
- Keep each branch scoped to one task packet and avoid overlapping file ownership across active sessions. Commit only that session's changes. Do not force-push, rewrite shared history, delete another session's branch/worktree, or push directly to `main`.
- Preserve the execution and safety boundaries in roadmap section 1.1. Local tests do not establish hosted-provider, scientific, brokerage, or live-research capability.
- For product changes, update the affected roadmap map/progress entry with actual changed files, commands, results, and remaining blockers. Do not claim tests or provider operations that did not run.
- Run application commands from `app`. If `node` is not on `PATH`, use `C:\Program Files\nodejs\node.exe` as recorded in the roadmap. Do not run live-provider fixtures unless the current task explicitly authorizes them.
- Finish by reporting the branch and commit, verification performed, unresolved blockers, and any likely merge conflicts. A human reviews and merges into `main`.
