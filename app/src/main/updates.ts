import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Update check and install against the project's public GitHub Releases. Runs in the main
 * process with Node's fetch, so the renderer's no-network guard is untouched. A release must
 * carry `qro-<commit>-win-x64-setup.exe` plus its `.sha256`; the installer is unsigned, so the
 * digest proves only that the downloaded bytes match what the release published.
 */
export const RELEASE_REPO = 'louiskim132/Quant_Office';
const API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
const INSTALLER = /^qro-([0-9a-f]{40})-win-x64-setup\.exe$/;

export interface LatestRelease {
  version: string;
  publishedAt: string;
  commit: string;
  installerUrl: string;
  digestUrl: string;
}
export type UpdateCheck =
  { status: 'none' } | { status: 'latest'; latest: LatestRelease } | { status: 'available'; latest: LatestRelease };

/** Only the repository's own release downloads; GitHub redirects these to its asset host itself. */
export function isReleaseDownloadUrl(url: string): boolean {
  return url.startsWith(`https://github.com/${RELEASE_REPO}/releases/download/`);
}

export function parseLatestRelease(json: unknown): LatestRelease | null {
  if (!json || typeof json !== 'object') return null;
  const release = json as { tag_name?: unknown; published_at?: unknown; draft?: unknown; assets?: unknown };
  if (release.draft === true || typeof release.published_at !== 'string' || !Array.isArray(release.assets)) return null;
  const assets = release.assets as { name?: unknown; browser_download_url?: unknown }[];
  const installer = assets.find(asset => typeof asset.name === 'string' && INSTALLER.test(asset.name));
  if (!installer || typeof installer.browser_download_url !== 'string') return null;
  const digest = assets.find(asset => asset.name === `${installer.name}.sha256`);
  if (!digest || typeof digest.browser_download_url !== 'string') return null;
  if (!isReleaseDownloadUrl(installer.browser_download_url) || !isReleaseDownloadUrl(digest.browser_download_url))
    return null;
  return {
    version: String(release.tag_name ?? '').replace(/^v/, ''),
    publishedAt: release.published_at,
    commit: INSTALLER.exec(installer.name as string)![1],
    installerUrl: installer.browser_download_url,
    digestUrl: digest.browser_download_url,
  };
}

/** A release is newer when it was built from a different commit and published after this build was released. */
export function compareRelease(current: { commit: string; releasedAt: string }, latest: LatestRelease): UpdateCheck {
  if (latest.commit === current.commit) return { status: 'latest', latest };
  const builtAt = Date.parse(current.releasedAt);
  const published = Date.parse(latest.publishedAt);
  if (Number.isFinite(builtAt) && Number.isFinite(published) && published <= builtAt)
    return { status: 'latest', latest };
  return { status: 'available', latest };
}

async function get(url: string, accept: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { Accept: accept, 'User-Agent': 'QuantResearchOffice-Updater' },
    signal: AbortSignal.timeout(30_000),
  });
  return response;
}

export async function checkForUpdate(current: { commit: string; releasedAt: string }): Promise<UpdateCheck> {
  const response = await get(API, 'application/vnd.github+json');
  if (response.status === 404) return { status: 'none' };
  if (!response.ok) throw new Error(`The update server answered ${response.status}. Try again later.`);
  const latest = parseLatestRelease(await response.json());
  if (!latest) return { status: 'none' };
  return compareRelease(current, latest);
}

/** Downloads the installer, checks it against the published digest and returns its path. */
export async function downloadInstaller(latest: LatestRelease, directory: string): Promise<string> {
  if (!isReleaseDownloadUrl(latest.installerUrl) || !isReleaseDownloadUrl(latest.digestUrl))
    throw new Error('Refusing a download outside the project releases.');
  const digestResponse = await get(latest.digestUrl, 'text/plain');
  if (!digestResponse.ok) throw new Error(`Could not read the release digest (${digestResponse.status}).`);
  const expected = /^([0-9a-f]{64})\b/i.exec((await digestResponse.text()).trim())?.[1]?.toLowerCase();
  if (!expected) throw new Error('The release digest is malformed.');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `qro-${latest.commit}-win-x64-setup.exe`);
  await rm(file, { force: true });
  const response = await get(latest.installerUrl, 'application/octet-stream');
  if (!response.ok || !response.body) throw new Error(`Could not download the update (${response.status}).`);
  const hash = createHash('sha256');
  const out = createWriteStream(file, { flags: 'wx' });
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>(resolve => out.once('drain', () => resolve()));
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      out.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
  }
  if (hash.digest('hex') !== expected) {
    await rm(file, { force: true });
    throw new Error('The downloaded update does not match its published digest. Nothing was installed.');
  }
  return file;
}
