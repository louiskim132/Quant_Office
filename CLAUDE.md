# Claude Code project instructions

Follow [AGENTS.md](AGENTS.md). It holds the rules for every coding agent in this repository; this file adds only what is specific to Claude Code.

- When the checkout has a `SESSION.md`, it belongs to the fixed desktop batch. Read `SESSION.md` and `docs/DESKTOP-SESSIONS.md`, and run `node tools/desktop.mjs status` before anything else. A worker implements only the packet `start` returns; the organizer announces `WORK READY` only after `publish` succeeds.
- Claude is the primary provider named by the roadmap, but that does not relax the hosted-execution, evidence, isolation or live-provider gates in roadmap section 1.1.
