# C12 local verification — 2026-10-01

Worktree: `Quant Office/Worktrees/revision-20261001`, branch `codex/revision-20261001`, base `beab1ce75b2791d8fa8be944f69bd716713f8deb`. Product changes: `af1127bc9777ea7edc9158c11426b7aa0e109318`. Fixture/desktop assertion correction: `01834ae`. Local only; no new GitHub PR, CI run, integration or installed mirror.

| Check | Actual result |
| --- | --- |
| Locked dependency install | PASS |
| Full bounded unit suite on `af1127b` | 1,031 tests, 1,030 pass, 0 fail, one existing skip |
| Typecheck / format on `01834ae` | PASS |
| Build | PASS; product source identical to `af1127b` |
| Packaged profile paging | PASS, 50 → 100 → 125 unique ordered events, tab reset |
| Packaged research pipeline | PASS after stale archived-panel assertion corrected; real archive IPC write refusal retained |
| Packaged general desktop acceptance | PASS; report retained with raw evidence |
| 100-row local package/return pipeline | PASS; dataset schema, planning, analysis, wait/restart and return rejections; stop at S7 |
| Real B5 local CLI planning/lifecycle | PASS for the recorded Devin/Codex chain and failure/cancel/restart scope |
| Final release package | PASS, test-inspection fuse disabled |
| Release startup smoke | PASS, empty scratch data, owned `Quant Research Office` window, no early exit |

The pipeline desktop check initially waited for an archived banner on a panel that the existing selection-clear behavior unmounts. The corrected assertion verifies the cleared selector, absence of the panel and archived-write refusal. It does not change product behavior. Two smoke-harness attempts failed (hidden windows do not populate `Process.MainWindowHandle`; a generic P/Invoke delegate was not marshalable). The final owned-PID window enumeration passed. Those harness failures are not product-pass evidence.

Release asar SHA-256: `1C7693A964FA790E4F101D43207B13272D0DFF7B86B026FBFA1346E7516A39D9`. Fuse readback: RunAsNode=false, NodeOptions=false, NodeCliInspectArguments=false, CookieEncryption=true. The installed App remains `81714c7`, asar `7E7C7FE471D15530F04B8AFF44CC624F348F45AAA7FC6D5B1EA7AD9237212C44`. Its pre-revision rollback copy is `Quant Office/Archive/App-before-revision-20261001` with the same hash. No database schema migration was added.

Raw logs/reports live outside Git at `Quant Office/Docs/Reviews/revision-2026-10-01/verification/`; the release smoke record is in `release-smoke-e581ef2505cd4bdc8a5f9e06b6d2e6d8/acceptance.json`. Related records: [synthetic pilot](c8-s3-pilot-2026-10-01.md), [window/paging](window-readiness-2026-10-01.md), [B5 live acceptance](codex-local-e2e-2026-10-01.md), [routes/ACP](hosted-routes-2026-10-01.md), [isolation design](lr16b-design-2026-10-01.md), [legal/release notes](release-gates-2026-10-01.md).

Legal review remains incomplete by the user's instruction. Real Colab was excluded and NOT_RUN. Subscription-isolation implementation/acceptance, complete hosted/ACP routes and D-3 release work remain open as recorded in the roadmap.
