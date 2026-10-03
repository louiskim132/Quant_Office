# Free portable release procedure

This procedure prepares an **unsigned Windows x64 portable candidate** using the existing
Electron runtime. It costs no signing or hosting fees. It does not complete legal review,
trusted code signing, SmartScreen reputation, a signed installer, an automatic update
service, or clean Windows VM acceptance. Public distribution remains subject to the
roadmap's open gates. No artifact is published by these commands.

Build from a reviewed integrated commit with locked dependencies. Run the required unit,
typecheck, format and desktop checks from `app` before calling this a release. Record exact
source commit and check outcomes. Ensure `QRO_TEST_BUILD` is unset; test builds leave the
inspector fuse enabled and are not release artifacts.

```powershell
Remove-Item Env:QRO_TEST_BUILD -ErrorAction SilentlyContinue
pnpm build
pnpm package
node scripts/release-audit.mjs "release/Quant Research Office-win32-x64" "release/privacy-report.json"
$releaseCommit = (git rev-parse HEAD).Trim()
node scripts/portable-release.mjs create "release/Quant Research Office-win32-x64" "release/qro-$releaseCommit-win-x64.zip" $releaseCommit
```

Build replaces only this checkout's generated `dist` tree; packaging replaces only its
`dist/package-input` staging tree and the packager's named app output. Unrelated releases
are preserved. Obsolete build outputs or old staging files cannot accumulate into the next
package. Never reuse a previously extracted directory as the destination for an update.

The ZIP contains `qro-release.json`: source commit and a closed inventory of file lengths
and SHA-256 hashes. Its adjacent `.sha256` covers the entire ZIP including that manifest.
Output names are exclusive: an existing ZIP is not overwritten. Preserve the exact bytes
after acceptance; any signing or other modification requires new hashes and acceptance.
The privacy scan is heuristic and must be reviewed; passing it is not proof that no secret
exists. A manifest or hash authenticates no publisher: obtain the expected ZIP digest from
the release publisher through a separately trusted channel. A matching hash only establishes
that the downloaded bytes match that digest.

## Download and first launch

1. Compare `(Get-FileHash -LiteralPath '<download.zip>' -Algorithm SHA256).Hash` with the
   separately obtained expected digest. Stop on any difference.
2. Extract into a new versioned folder owned by your account, such as
   `%LOCALAPPDATA%\QuantResearchOffice\versions\<commit>`, using Windows Explorer or
   `Expand-Archive -LiteralPath '<download.zip>' -DestinationPath '<new-folder>'`.
3. From a trusted copy of the repository, run
   `powershell -NoProfile -ExecutionPolicy Bypass -File app/scripts/verify-portable.ps1 -PackageDirectory '<new-folder>'`.
   This requires no Node installation. The verifier rejects changed, missing and additional
   files, including obsolete files that a privacy scan might allow.
   `-ExecutionPolicy Bypass` applies only to that PowerShell process; review the trusted
   verifier first. It changes no machine-wide or user-wide execution policy.
4. Open `Quant Research Office.exe`. Windows may show an unsigned publisher warning.
   Review the source and provenance before deciding whether to run it; the release does
   not claim a trusted publisher. Provider CLIs and their official sign-ins remain separate
   prerequisites for the features that use them. No provider account is bundled.

The per-user folder above supports ordinary use as your own account. A separately enabled
QRO-Agent account also needs read/execute access to the app runtime and standalone Node
runtime; do not assume it can read another user's `%LOCALAPPDATA%`. For that mode choose
an explicitly administered per-machine version folder (for example under Program Files),
verify read/execute access as QRO-Agent, and keep its writable session directories separate.
Do not grant QRO-Agent write access to application binaries or reuse a developer's runtime
path. Isolation acceptance and actual subscription sign-ins must still pass separately.

## Manual update and rollback

Close Quant Research Office and its active agent sessions before changing versions. Use
the application's backup action and preserve that backup outside every version folder.
Download, hash-check, extract and inventory-check the new version into its own new folder.
Keep the entire prior version. Launch the new executable and update your shortcut only
after local acceptance. Application data remains separate from the versioned binaries.

To roll back, close the new version and launch the retained prior executable. If the new
version changed the workspace schema, use the documented compatible downgrade/backup
procedure first; never assume old code can read new workspace data. The current candidate
introduces no schema change. Preserve backups rather than overwriting the live workspace
with an older copy without a recovery decision.

## Uninstall

Close the app and its agent sessions. Remove shortcuts and only the explicitly identified
version directories. Portable distribution installs no service or automatic updater. Your
workspace, backups and official provider CLI accounts remain separate. Delete workspace
data only if you intentionally want to lose those records; identify the actual workspace
location in Settings first. A separately configured QRO-Agent account/isolation setup is
not removed by deleting the portable app; manage it through the isolation workflow.

## Local acceptance and remaining clean-machine acceptance

Extract the ZIP into a fresh temporary folder, verify with both the Node and PowerShell
tools, and run the hardened startup check from `app`:

```powershell
node scripts/portable-release.mjs verify '<fresh-extracted-folder>'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-portable.ps1 -PackageDirectory '<fresh-extracted-folder>'
pnpm exec tsx tests/installed-smoke.desktop.ts '<fresh-extracted-folder>/Quant Research Office.exe'
```

That test uses fresh scratch user data and opens twice; it makes no provider call and does
not replace the installed App. It proves local startup only. In a clean Windows VM under
a standard account, separately record first launch, unsigned warning behavior, fresh
workspace, restart/persistence, provider CLI prerequisite messages, version-to-version
manual update, backup compatibility and rollback, and uninstall preserving user data.
Record OS/build, exact ZIP and asar hashes, results and limitations. No clean VM result or
trusted signing identity is supplied by this local tooling.
