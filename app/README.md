# Quant Research Office desktop

Open [Quant Research Office.exe](release/Quant%20Research%20Office-win32-x64/Quant%20Research%20Office.exe) with the adjacent files intact. The portable build is unsigned. Its version comes from package.json.

Create a project and optionally select **Project folder on this device**. Folder selection records a path; it does not scan, upload or execute its contents. The database stays in the managed application-data workspace. Cloud workspace references are saved as unverified setup notes.

Add Agent uses the official provider sign-in flow followed by Confirm. Account identity at setup is historical metadata, not proof of a current connection. Unlimited same-role membership is supported. Active/Archived/All, search, team, role and provider filters are available. Click a person to open its profile. Archived profiles are read-only. Profile saves use revisions; unsaved profile and Add Agent drafts survive navigation while the app remains open.

New request asks for a project, objective, work type, mode and participants. A single Worker can own a question without a Director or PM. Save draft queues nothing. Start request validates participants and shows the unverified cloud transport blocker. Edit a request through its participant/criteria details; Use as new request creates a distinct draft ID. Only empirical experiments create scientific contracts.

Cancel closes undispatched requests. Review revisions become Superseded and cannot determine the parent lifecycle. Cancel outstanding requests before archiving a project. Restore changes visibility only. Legacy archive inconsistencies are repaired by an appended migration after a database copy; prior event hashes remain unchanged.

The office uses normal-flow name/status labels. With no provider event feed, availability is Unknown. Imported transcripts never create live office activity. The queue, sidebar badge and footer use the same all-project request projection, excluding completed/canceled work from Active.

OpenAI effort preferences use the installed model catalog, retaining its default and descriptions. Cloud application of those settings remains unverified. Missing catalogs and unresolved Claude aliases expose only Provider default; saved unsupported preferences are retained and rejected on revalidation rather than silently lowered. Usage belongs to the currently checked provider account. Local transcript token counts remain separate from allowances.

Backups include the database, registered objects and imported logs, excluding credentials and external project folder contents. Before success, the writer validates 512 entries, 64 MiB per entry, 256 MiB total expanded/compressed bytes and a 1 MiB backup manifest, then restores a staging copy and verifies its event chain and objects. A larger workspace format remains planned. Project exports include native requests and their selected profiles; unscoped legacy conversations are excluded to prevent cross-project disclosure.

## Development and validation

Use Node 24 and the pinned dependencies:

~~~text
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run test:desktop
pnpm run test:revision-desktop
pnpm run package
~~~

Desktop tests use isolated fixture workspaces. QRO_EXECUTABLE selects the packaged executable. Revision layout checks use Chromium zoom at 100%, 125%, 150% and 200% in a minimum-size window; they do not constitute a physical multi-monitor DPI test. Reports and screenshots are in test-output. agents.e2e.ts is a separate opt-in real-account metadata test, not part of fixture validation.

See [readiness](docs/readiness.md) for limitations. There is no completed provider job, independent scientific approval or finalized executable deliverable in this release.
