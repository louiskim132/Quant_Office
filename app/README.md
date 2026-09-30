# Quant Research Office desktop

The Electron app in this folder. Its version is in [package.json](package.json). The portable build is unsigned; signing, an installer and updates are deferred (roadmap decision D-3).

## What the app does

- **Projects** hold research work. A project may name a folder on this device, plus paths inside it that agents must never receive (withheld paths). Choosing a folder records a path; it does not scan, upload or run anything.
- **Agents** are profiles bound to the user's own provider sign-in (Claude Code, Codex or Devin) or the user's own API key, which is stored with Windows DPAPI. Local agents run on this machine through the office-spawned CLI route. Settings can move agent runs to a separate low-privilege Windows account (agent isolation) after the user accepts a UAC prompt.
- **Requests** go to one agent or through a pipeline of hops: brief, drafts, critiques, synthesis, implementation and verification. The office writes each hop a bounded packet, launches the CLI, verifies the returned receipt and output hashes, and asks the user to approve, revise or reject the result.
- **The research workflow (S0–S10)** freezes specifications, runs independent reviews and gates, and exports a run package that the user executes manually. Returned files are imported and bound to that package.
- **Memory, evidence and history** keep office-recorded findings, the evidence agents may query, and an append-only event history. Backups include the workspace database and stored objects, and are verified by restoring a staging copy before they are reported.

The app has no brokerage connection, runs no research compute locally, never controls Colab and has no hosted agent dispatch (roadmap R5).

## Development and validation

Use Node 24.19.0 and the locked dependencies, from this folder:

~~~powershell
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm package
~~~

`pnpm test:desktop` runs the desktop end-to-end suite; set `QRO_EXECUTABLE` to test the packaged exe. [Roadmap section 14](../docs/ROADMAP.md#14-commands-tooling-and-release-protocol) lists the other desktop suites and the release steps. Tests and manual checks use `QRO_USER_DATA_DIR` pointing at a scratch folder, never the live workspace in `%APPDATA%\Quant Research Office`. `tests/agents.e2e.ts` and `tests/three-agent.live.ts` use real accounts and are not part of routine validation.

Status and known limitations are in [roadmap section 11](../docs/ROADMAP.md#11-execution-checklist-and-progress-record).
