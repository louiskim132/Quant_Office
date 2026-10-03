import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRelease, isReleaseDownloadUrl, parseLatestRelease, RELEASE_REPO } from '../src/main/updates.js';

const commit = 'a'.repeat(40);
const base = `https://github.com/${RELEASE_REPO}/releases/download/v0.6.0`;
const release = (overrides: Record<string, unknown> = {}) => ({
  tag_name: 'v0.6.0',
  published_at: '2026-10-10T00:00:00Z',
  draft: false,
  assets: [
    { name: `qro-${commit}-win-x64-setup.exe`, browser_download_url: `${base}/qro-${commit}-win-x64-setup.exe` },
    {
      name: `qro-${commit}-win-x64-setup.exe.sha256`,
      browser_download_url: `${base}/qro-${commit}-win-x64-setup.exe.sha256`,
    },
  ],
  ...overrides,
});

test('a release with an installer and its digest is understood', () => {
  const latest = parseLatestRelease(release());
  assert.ok(latest);
  assert.equal(latest.version, '0.6.0');
  assert.equal(latest.commit, commit);
  assert.equal(latest.publishedAt, '2026-10-10T00:00:00Z');
});

test('a release without its digest, a draft, or foreign download links is ignored', () => {
  assert.equal(parseLatestRelease(release({ assets: [release().assets[0]] })), null);
  assert.equal(parseLatestRelease(release({ draft: true })), null);
  const foreign = release();
  foreign.assets[0].browser_download_url = 'https://example.com/qro.exe';
  assert.equal(parseLatestRelease(foreign), null);
  assert.equal(parseLatestRelease(null), null);
});

test('only the project release downloads are allowed', () => {
  assert.equal(isReleaseDownloadUrl(`${base}/x.exe`), true);
  assert.equal(isReleaseDownloadUrl(`https://github.com/someone/else/releases/download/v1/x.exe`), false);
  assert.equal(isReleaseDownloadUrl(`http://github.com/${RELEASE_REPO}/releases/download/v1/x.exe`), false);
});

test('the same commit is the latest; a later release from another commit is an update', () => {
  const latest = parseLatestRelease(release())!;
  assert.equal(compareRelease({ commit, releasedAt: '2026-10-02T00:00:00Z' }, latest).status, 'latest');
  assert.equal(
    compareRelease({ commit: 'b'.repeat(40), releasedAt: '2026-10-02T00:00:00Z' }, latest).status,
    'available',
  );
  // A release published before this build cannot be an upgrade.
  assert.equal(compareRelease({ commit: 'b'.repeat(40), releasedAt: '2026-10-20T00:00:00Z' }, latest).status, 'latest');
  // Development builds carry no stamp and always see a published release as available.
  assert.equal(compareRelease({ commit: '', releasedAt: '' }, latest).status, 'available');
});
