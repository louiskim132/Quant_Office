# Bug and flaw log

Every bug, flaw or rough edge found in the product, open or fixed, in one place. Part of the basic packet
(AGENTS.md, "Finishing and merging"): each round adds what it found and updates what it fixed.

- **One row per issue.** Keep the ID when the status changes; never reuse one.
- **Status:** `OPEN`, `FIXED` (with the commit), `ACCEPTED` (known and deliberately kept, with the reason) or
  `WONT_FIX`.
- **Severity:** `high` (data loss, security, cannot use), `medium` (wrong or confusing behavior with a workaround),
  `low` (polish).
- Found where: the round or test that surfaced it, linking its record when there is one.

| ID | Found | Area | Severity | Issue | Status |
|---|---|---|---|---|---|
| BUG-001 | 2026-10-02 clean VM (portable) | Connections | low | With no provider CLI installed, the cards say "Not checked"; the "not installed" message appears only after clicking Sign in. | OPEN |
| BUG-002 | 2026-10-02 isolation page | Settings > Isolation | medium | Two "Check" controls; the top one refreshed nothing and per-provider Check was confusing. | FIXED `b51e9f3`, `80df107` (one Check isolation refreshes all providers) |
| BUG-003 | 2026-10-02 isolation page | Install / taskbar | medium | The taskbar `App\` kept an old build after a revision, so the fix looked missing. | FIXED by process: mirror `app/release` into `App\` after every app change (AGENTS.md) |
| BUG-004 | 2026-10-03 clean VM installer | Release tooling | low | `verify-portable.ps1` failed on an installed copy because Inno adds `unins000.exe/.dat`. | FIXED `f89bfd8` (`-Installed` allows exactly those two) |
| BUG-005 | 2026-10-03 clean VM installer | Projects | medium | A project could be created without a project folder. | FIXED `f89bfd8` (red-outlined folder field, creation refused) |
| BUG-006 | 2026-10-03 clean VM installer | Installer | medium | Uninstall left an empty `Program Files\Quant Research Office` folder. | FIXED `43b2f06` (`[UninstallDelete]` removes the folder) |
| BUG-007 | 2026-10-03 clean VM installer | Installer | medium | Uninstalling while the office was open left the program files behind. | FIXED `7c52025` (asks to close the office, retries; also from Settings > Apps) |
| BUG-008 | 2026-10-03 clean VM installer | Startup | medium | First launch after install or upgrade takes 10 s+; later launches are fast. Likely Defender's first scan of new unsigned files plus first-run caches. | OPEN: measure on real hardware; consider an immediate "Starting…" splash |
| BUG-009 | 2026-10-03 clean VM installer | Distribution | medium | Unsigned installer: SmartScreen "Windows protected your PC" and UAC "Unknown publisher". | ACCEPTED (user decision 2026-10-03, signing deferred; release notes explain it) |
| BUG-010 | 2026-10-03 Version tab | Updates | medium | Settings > Version > Update has not run end to end: it needs two published releases. | OPEN: test with the first release after v0.0.1 |
| BUG-011 | 2026-10-03 Version tab | Updates | low | "Released" shows the source commit date, which can precede the actual publish date. | ACCEPTED (deterministic per build) |
| BUG-012 | 2026-10-03 installer menu | Installer | low | Rollback lists only versions this PC installed before (up to 3); before the first update the list is empty. | ACCEPTED (offline and tamper-checked); revisit with a release-list download |
| BUG-013 | 2026-10-02 residual acceptance | Isolation | medium | Saved QRO-Agent Windows credential went stale (password mismatch); boundary check 0/5 until restored. | FIXED by user re-setup 2026-10-02 (gate #1 passed) |
