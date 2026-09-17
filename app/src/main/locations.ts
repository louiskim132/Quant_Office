import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from './fsx.js';
import path from 'node:path';
import type { InputSnapshot, ProjectLocation, SnapshotFile } from '../shared/types.js';
import { MAX_SNAPSHOT_BYTES } from '../shared/types.js';
import { canonical, canonicalHash, sha256 } from '../core/canonical.js';
import type { OfficeStore } from '../core/store.js';

/** Selection is a strict allowlist. Nothing is included because it happens to sit under the folder. */
export interface SelectedFile { relative: string; absolute: string; bytes: number }

/**
 * Everything the office generates lives under one reserved directory, so a generated file can never
 * overwrite a selected one. A selection that names this directory is refused before anything is
 * copied, rather than silently losing the user's file to bookkeeping.
 */
export const RESERVED_DIRECTORY = '_office';
export const MANIFEST_PATH = `${RESERVED_DIRECTORY}/manifest.json`;

function isReserved(relative: string): boolean {
  return relative.toLowerCase() === RESERVED_DIRECTORY || relative.toLowerCase().startsWith(`${RESERVED_DIRECTORY}/`);
}

/**
 * Rejects a link at any level of a path, from its filesystem root downwards.
 *
 * Checking only the leaf, or comparing the path to its realpath, is not enough: realpath resolves
 * every component silently, so a junction three directories up is invisible in the result. Each
 * component is examined with lstat, which does not follow links.
 */
export function assertNoLinkedAncestor(target: string, describe: (component: string) => string): void {
  const parsed = path.parse(path.resolve(target));
  let walked = parsed.root;
  for (const component of parsed.dir.slice(parsed.root.length).split(path.sep).filter(Boolean).concat(parsed.base ? [parsed.base] : [])) {
    walked = path.join(walked, component);
    let stats;
    // A component that does not exist yet cannot be a link, and nothing below it exists either.
    try { stats = lstatSync(walked); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(describe(walked));
  }
}

function ensureLocalRoot(root: string): string {
  if (!path.isAbsolute(root)) throw new Error('The project folder must be an absolute path on this device.');
  // A UNC path is a network root; this first implementation refuses it rather than claiming safe support.
  if (/^\\\\/.test(root) || /^\/\//.test(root)) throw new Error('Network folders are not supported yet. Copy the inputs to a local folder first.');
  if (!existsSync(root)) throw new Error('The project folder no longer exists. Choose it again.');
  // Every ancestor, not only the folder itself: a junction further up redirects the whole subtree and
  // realpath would resolve it away without saying so.
  assertNoLinkedAncestor(root, component => `The project folder is reached through a link at ${component}. Choose a folder whose whole path is real.`);
  const real = realpathSync(root);
  if (!statSync(real).isDirectory()) throw new Error('The project folder is not a directory.');
  return real;
}

/**
 * A staging directory the office owns, reached by a path with no links in it.
 *
 * Everything below is created, verified and deleted by this process, so a redirected ancestor would
 * mean verifying one tree and shipping, or deleting, another.
 */
function ensureOwnedStaging(stagingPath: string, managedRoot?: string): void {
  assertNoLinkedAncestor(stagingPath, component => `The prepared directory is reached through a link at ${component}, so it cannot be trusted.`);
  if (managedRoot) {
    const inside = path.relative(path.resolve(managedRoot), path.resolve(stagingPath));
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside))
      throw new Error('The prepared directory is outside the workspace staging root this office owns.');
  }
}

/**
 * Rejects a link anywhere between the root and the file.
 *
 * Checking only the leaf is not enough: a junction on an intermediate directory redirects the whole
 * subtree, and a link that resolves back inside the root is still a redirection the user did not
 * select. Every component is examined with lstat, which does not follow links.
 */
function assertNoLinkedComponent(real: string, relative: string, raw: string): void {
  const parts = relative.split('/').filter(Boolean);
  let walked = real;
  for (const part of parts.slice(0, -1)) {
    walked = path.join(walked, part);
    const stats = lstatSync(walked);
    if (stats.isSymbolicLink()) throw new Error(`Selected file sits under a link, which is not supported yet: ${raw}`);
    if (!stats.isDirectory()) throw new Error(`Selected path is not inside a real folder: ${raw}`);
  }
}

/**
 * Resolves the selected relative paths against the project folder.
 * Rejects traversal, symlink and junction escapes, directories, and anything missing or unreadable.
 */
export function resolveSelection(root: string, relativePaths: string[]): SelectedFile[] {
  const real = ensureLocalRoot(root);
  const seen = new Set<string>();
  const files: SelectedFile[] = [];
  let total = 0;
  for (const raw of relativePaths) {
    const relative = raw.replaceAll('\\', '/').trim();
    if (!relative) continue;
    if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) throw new Error(`Selected files must be inside the project folder: ${raw}`);
    const candidate = path.resolve(real, relative);
    const inside = path.relative(real, candidate);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`Selected file escapes the project folder: ${raw}`);
    const normalized = inside.replaceAll('\\', '/');
    // The reserved namespace is refused here, before a single byte is copied.
    if (isReserved(normalized)) throw new Error(`${RESERVED_DIRECTORY}/ is reserved for the office's own manifest and notes. Rename or deselect: ${raw}`);
    if (!existsSync(candidate)) throw new Error(`Selected file is missing: ${raw}`);
    assertNoLinkedComponent(real, normalized, raw);
    // lstat, not stat: a symlink or junction must be rejected instead of silently followed out of the folder.
    const link = lstatSync(candidate);
    if (link.isSymbolicLink()) throw new Error(`Selected file is a link and is not supported yet: ${raw}`);
    if (link.isDirectory()) throw new Error(`Select individual files, not folders: ${raw}`);
    if (!link.isFile()) throw new Error(`Only regular files can be shared: ${raw}`);
    const resolved = realpathSync(candidate);
    const resolvedInside = path.relative(real, resolved);
    if (resolvedInside.startsWith('..') || path.isAbsolute(resolvedInside)) throw new Error(`Selected file resolves outside the project folder: ${raw}`);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    total += link.size;
    if (total > MAX_SNAPSHOT_BYTES) throw new Error(`The selection exceeds the ${Math.round(MAX_SNAPSHOT_BYTES / (1024 * 1024))} MiB snapshot limit. Select fewer files.`);
    files.push({ relative: normalized, absolute: resolved, bytes: link.size });
  }
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

/** Credentials and tool customizations never travel through the ordinary selected-file route. */
const EXCLUDED = [/(^|\/)\.git(\/|$)/i, /(^|\/)\.claude(\/|$)/i, /(^|\/)\.codex(\/|$)/i, /(^|\/)\.env(\.|$)/i, /(^|\/)\.npmrc$/i, /(^|\/)id_(rsa|ed25519)(\.pub)?$/i, /(^|\/)\.aws(\/|$)/i, /(^|\/)\.ssh(\/|$)/i];
export function excludedReason(relative: string): string | undefined {
  return EXCLUDED.some(pattern => pattern.test(relative)) ? relative : undefined;
}

/** A project-folder snapshot cannot grow past this many files, matching the record schema's cap. */
export const MAX_SNAPSHOT_FILES = 2000;

/**
 * Whole subtrees that are never inputs: version-control internals, tool configuration, dependency
 * and virtualenv roots, and caches. Skipping the directory once is cheaper and more honest than
 * enumerating thousands of files that could never be shared.
 */
const SKIPPED_DIRS = new Set([
  '.git', '.hg', '.svn', '.claude', '.codex', '.agents', '.devin', '.idea', '.vscode', '.vs',
  'node_modules', '__pycache__', '.venv', 'venv', '.env', '.env.d', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.tox', '.next', '.nuxt', '.cache', '.parcel-cache', '.gradle', '.terraform',
]);

/** Ordinary operating-system noise files carry no research content and are skipped silently. */
const SKIPPED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized']);

interface ScanResult { files: SelectedFile[]; warnings: string[] }

/**
 * Enumerates every shareable file under the project folder: the folder's contents are the inputs.
 * Credential patterns, tool configuration, dependency and cache subtrees, OS noise and links are
 * skipped, and each skip that a user could care about is recorded as a warning so the snapshot
 * honestly reports what it left behind. Byte and file-count limits refuse the whole snapshot rather
 * than silently truncating the folder.
 */
export function scanProjectFolder(root: string): ScanResult {
  const real = ensureLocalRoot(root);
  const files: SelectedFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  const seen = new Set<string>();
  const note = (entry: string, why: string) => { skipped.push(`${entry} — ${why}`); };
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { note(relative, 'links are not shared'); continue; }
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (SKIPPED_DIRS.has(lower)) { note(`${relative}/`, 'dependency, cache or tool folder'); continue; }
        if (isReserved(relative)) { note(`${relative}/`, `reserved for the office's own manifest and notes`); continue; }
        walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) { note(relative, 'not a regular file'); continue; }
      if (SKIPPED_FILES.has(entry.name.toLowerCase())) continue;
      const excluded = excludedReason(relative);
      if (excluded) { note(relative, 'credentials and tool configuration are never shared'); continue; }
      const stats = lstatSync(absolute);
      // A link planted between enumeration and stat is refused outright: this is the last cheap
      // moment to stop a redirection before any byte of it is hashed or copied.
      if (stats.isSymbolicLink()) { note(relative, 'links are not shared'); continue; }
      if (!stats.isFile()) { note(relative, 'not a regular file'); continue; }
      const resolved = realpathSync(absolute);
      const resolvedInside = path.relative(real, resolved);
      if (resolvedInside.startsWith('..') || path.isAbsolute(resolvedInside)) { note(relative, 'resolves outside the project folder'); continue; }
      const dedupeKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      total += stats.size;
      if (files.length + 1 > MAX_SNAPSHOT_FILES) throw new Error(`The project folder holds more than the ${MAX_SNAPSHOT_FILES}-file snapshot limit. Keep research inputs in a smaller folder or archive older runs elsewhere.`);
      if (total > MAX_SNAPSHOT_BYTES) throw new Error(`The project folder exceeds the ${Math.round(MAX_SNAPSHOT_BYTES / (1024 * 1024))} MiB snapshot limit. Move large datasets or model checkpoints out of the folder and keep them out of the shared scope.`);
      files.push({ relative, absolute: resolved, bytes: stats.size });
    }
  };
  walk(real, '');
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  // Warnings on the record are capped; an enormous skip list still says exactly how much was left out.
  const warnings = skipped.length <= 60 ? skipped : [...skipped.slice(0, 60), `…and ${skipped.length - 60} more skipped entries.`];
  return { files, warnings };
}

/**
 * Git for staging bookkeeping only, isolated from everything the user's environment could inject.
 *
 * Inherited GIT_* variables are dropped rather than overridden, because one missed name (GIT_DIR,
 * GIT_WORK_TREE, GIT_INDEX_FILE, GIT_ALTERNATE_OBJECT_DIRECTORIES) redirects the whole operation.
 * System, global and template configuration are switched off, and hooks, filters and attributes are
 * pointed at nothing, so staging a snapshot can never run code from the machine or the selection.
 */
function gitEnvironment(cwd: string, isoDate?: string): NodeJS.ProcessEnv {
  // Windows environment names are case-insensitive, so a lower-cased git_dir would survive a
  // case-sensitive prefix test and still be honoured by the process.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  return {
    ...inherited,
    // Pinning both dates makes the commit a pure function of the tree, so the same bytes always
    // produce the same commit hash. That is what lets a restored snapshot be checked against the
    // identifier frozen at preparation, rather than merely resembling it.
    ...(isoDate ? { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate } : {}),
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    HOME: cwd, USERPROFILE: cwd, XDG_CONFIG_HOME: cwd,
  };
}

/**
 * Repository metadata the office refuses to run Git against.
 *
 * Git will happily execute a configured helper, filter, or hook found inside the repository it is
 * asked about. The staging directory is created by this process and should contain none of these, so
 * their presence means the tree is not the one we prepared, and Git must not be run on it at all.
 */
const UNTRUSTED_GIT_METADATA = ['info/attributes', 'info/grafts', 'objects/info/alternates', 'commondir', 'modules'];

/**
 * Configuration keys that can make Git run a program or read objects from elsewhere.
 *
 * `git init` writes a config of its own, so the file's presence proves nothing; its contents do.
 * Anything here is refused rather than stripped, because a staging repository the office created
 * should never contain them, and their presence means the tree is not the one we prepared.
 */
const EXECUTABLE_CONFIG = /^\s*(hookspath|fsmonitor|sshcommand|pager|editor|askpass|external|smudge|clean|process|helper|alternateobjectdirectories|attributesfile|excludesfile|templatedir)\s*=/im;

/**
 * Confirms the staging repository is the plain one this office created before Git executes on it.
 *
 * A `.git` file rather than a directory is an indirection to somewhere else. A repository-level
 * config, hooks directory, alternate object store or grafts file can all cause Git to run code or
 * read objects from outside the tree, so any of them is a refusal rather than something to sanitize.
 */
function assertPlainStagingRepository(stagingPath: string): void {
  const dotGit = path.join(stagingPath, '.git');
  if (!existsSync(dotGit)) throw new Error('The prepared directory has no staging repository.');
  const stats = lstatSync(dotGit);
  if (stats.isSymbolicLink()) throw new Error('The staging repository is a link, so it cannot be trusted.');
  if (!stats.isDirectory()) throw new Error('The staging repository is an indirection to another location, so it cannot be trusted.');
  for (const name of UNTRUSTED_GIT_METADATA) {
    const candidate = path.join(dotGit, ...name.split('/'));
    if (existsSync(candidate))
      throw new Error(`The staging repository carries ${name}, which the office never writes. It will not run Git against a tree it did not prepare.`);
  }
  const config = path.join(dotGit, 'config');
  if (existsSync(config) && EXECUTABLE_CONFIG.test(readFileSync(config, 'utf8')))
    throw new Error('The staging repository configuration names a program or an external object store. The office will not run Git against it.');
  // `git init` installs disabled `.sample` hooks. Anything else in there would actually run.
  const hooks = path.join(dotGit, 'hooks');
  if (existsSync(hooks)) {
    const live = readdirSync(hooks).filter(name => !name.endsWith('.sample'));
    if (live.length) throw new Error(`The staging repository carries an installed hook (${live[0]}), which the office never writes.`);
  }
  // Only the single frozen branch and its head may exist; unrelated refs can carry extra history.
  const refsRoot = path.join(dotGit, 'refs', 'heads');
  const heads = existsSync(refsRoot) ? readdirSync(refsRoot) : [];
  if (heads.length > 1 || (heads.length === 1 && heads[0] !== 'office-snapshot'))
    throw new Error(`The staging repository carries unexpected branches (${heads.join(', ')}), so its history is not the frozen one.`);
}

/**
 * The commit identity, supplied per invocation.
 *
 * These values are inputs to the commit object, so they are recorded here as part of the supported
 * reconstruction contract rather than left to whatever the machine happens to be configured with.
 */
const COMMIT_IDENTITY = ['-c', 'user.email=office@localhost', '-c', 'user.name=Quant Research Office'];

/** Configuration forced on every invocation, so a repository-level setting cannot re-enable code. */
const GIT_SAFETY = [
  '-c', 'core.hooksPath=',
  '-c', 'init.templateDir=',
  '-c', 'core.fsmonitor=',
  '-c', 'core.autocrlf=false',
  '-c', 'core.symlinks=false',
  '-c', 'protocol.allow=never',
  '-c', 'uploadpack.allowFilter=false',
  '-c', 'core.attributesFile=',
  '-c', 'core.excludesFile=',
  '-c', 'diff.external=',
  '-c', 'core.sshCommand=',
  '-c', 'credential.helper=',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.process=',
  '-c', 'gc.auto=0',
];

function git(args: string[], cwd: string, executable: string, isoDate?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => execFile(executable, [...GIT_SAFETY, ...args], { cwd, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024, env: gitEnvironment(cwd, isoDate) },
    (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout || stderr || (error?.message ?? '')).trim() })));
}

/**
 * The workspace's content-addressed object store, shared with imported artifacts.
 *
 * Staging is disposable; these bytes are not. A request's frozen inputs are workspace-owned once the
 * user deliberately selected them, so they are stored here, travel in backups, and can rebuild a
 * staging directory after a restore without ever reading the original source folder again.
 */
export function snapshotObjectPath(objectRoot: string, sha256Hex: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256Hex)) throw new Error('An object is addressed by its SHA-256 and nothing else.');
  return path.join(objectRoot, 'objects', sha256Hex.slice(0, 2), sha256Hex);
}

function storeObject(objectRoot: string, sha256Hex: string, bytes: Buffer): void {
  const target = snapshotObjectPath(objectRoot, sha256Hex);
  if (existsSync(target)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

export interface PrepareInput {
  store: OfficeStore; stagingRoot: string; projectId: string; requestId?: string | null; requestRevision?: number | null;
  objective?: string; gitExecutable?: string; now?: () => string;
  /** Where durable copies of the staged bytes are kept. Without it, the snapshot is unreconstructable. */
  objectRoot?: string;
}

/**
 * Copies exactly the selected bytes into a disposable staging directory, hashes what was copied,
 * writes a manifest, and makes one commit so the supported transfer route has a bundle-able source.
 * Nothing is uploaded here, and the source folder is never read again after this point.
 */
export async function prepareInputSnapshot(input: PrepareInput): Promise<InputSnapshot> {
  const state = input.store.snapshot({history:false});
  const project = state.projects.find(p => p.id === input.projectId);
  if (!project) throw new Error('Project not found.');
  if (project.archived) throw new Error('Restore this project before preparing work.');
  const location: ProjectLocation | undefined = input.store.location(input.projectId);
  const now = input.now ?? (() => new Date().toISOString());
  const warnings: string[] = [];

  // A snapshot is frozen against one request at one revision. This is checked for a text-only
  // request exactly as it is for a selected-file one, so the two routes cannot drift apart.
  if (input.requestId) {
    const request = (state.requests ?? []).find(item => item.id === input.requestId);
    if (!request) throw new Error('Request not found.');
    if (request.projectId !== project.id) throw new Error('That request belongs to a different project.');
    if (input.requestRevision !== undefined && input.requestRevision !== null && input.requestRevision !== request.revision)
      throw new Error('The request changed in another view. Reload before preparing its inputs.');
  } else if (input.requestRevision !== undefined && input.requestRevision !== null) {
    throw new Error('A request revision cannot be frozen without a request.');
  }

  // The project folder's contents are the inputs. The scan skips credentials, tool configuration,
  // dependency trees and links, and reports each skip as a warning on the snapshot record.
  let selection: SelectedFile[] = [];
  if (location?.localFolder) {
    const scan = scanProjectFolder(location.localFolder);
    selection = scan.files;
    warnings.push(...scan.warnings);
  }
  // Defense in depth: an excluded path reaching this point means the scan's filter regressed.
  for (const file of selection) {
    const excluded = excludedReason(file.relative);
    if (excluded) throw new Error(`Credentials and tool configuration are never shared through file selection: ${excluded}`);
  }
  const route = selection.length ? 'PROJECT_FOLDER_SNAPSHOT' as const : 'GENERATED_REQUEST_ONLY' as const;
  const id = randomUUID();
  const staging = path.join(input.stagingRoot, id);
  mkdirSync(staging, { recursive: true });
  try {
    const files: SnapshotFile[] = [];
    let totalBytes = 0;
    for (const file of selection) {
      const destination = path.join(staging, file.relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(file.absolute, destination);
      // The source is re-examined after the copy: a file swapped for a link between validation and
      // copy would otherwise have been followed while the bytes were read.
      const after = lstatSync(file.absolute);
      if (!after.isFile()) throw new Error(`${file.relative} stopped being a regular file while it was being staged. Prepare the request again.`);
      if (lstatSync(destination).isSymbolicLink()) throw new Error(`${file.relative} was staged as a link. Prepare the request again.`);
      // Hash the staged copy, so the record describes the bytes that will actually travel.
      const bytes = readFileSync(destination);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error('The selection grew past the snapshot limit while staging. Prepare it again with fewer files.');
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (input.objectRoot) storeObject(input.objectRoot, digest, bytes);
      files.push({ path: file.relative, bytes: bytes.byteLength, sha256: digest });
      if (bytes.byteLength !== file.bytes) warnings.push(`${file.relative} changed size while it was being staged; the snapshot keeps the copied bytes.`);
    }

    // Generated bookkeeping is written into the reserved directory and inventoried like any other
    // byte, so tampering with it is as detectable as tampering with a selected file.
    const reserved = path.join(staging, RESERVED_DIRECTORY);
    mkdirSync(reserved, { recursive: true });
    const readmeBody = `# Prepared request input\n\nThis directory holds the contents of the project folder at prepare time, minus skipped credential,\ntool, dependency and cache entries the office never shares.\nOffice bookkeeping lives under ${RESERVED_DIRECTORY}/ and is listed in ${MANIFEST_PATH}.\n\nSnapshot: ${id}\nFiles: ${files.length}\nBytes: ${totalBytes}\n`;
    const readmePath = `${RESERVED_DIRECTORY}/README.md`;
    writeFileSync(path.join(staging, readmePath), readmeBody);
    const readmeBytes = Buffer.from(readmeBody);
    const generated: SnapshotFile[] = [{ path: readmePath, bytes: readmeBytes.byteLength, sha256: sha256(readmeBytes) }];
    if (input.objectRoot) storeObject(input.objectRoot, generated[0].sha256, readmeBytes);

    const manifest = {
      snapshotId: id, projectId: project.id, projectName: project.name, requestId: input.requestId ?? null,
      objective: input.objective ?? '', locationRevision: location?.revision ?? 0, route,
      files: files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
      generated: generated.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
      createdAt: now(),
    };
    const manifestBytes = Buffer.from(canonical(manifest));
    writeFileSync(path.join(staging, MANIFEST_PATH), manifestBytes);
    // The manifest is inventoried in the record but not inside itself, which would be circular.
    generated.push({ path: MANIFEST_PATH, bytes: manifestBytes.byteLength, sha256: sha256(manifestBytes) });
    if (input.objectRoot) storeObject(input.objectRoot, sha256(manifestBytes), manifestBytes);

    const executable = input.gitExecutable ?? 'git';
    let stagingCommit = '';
    const init = await git(['init', '--quiet', '-b', 'office-snapshot'], staging, executable);
    if (init.ok) {
      const add = await git(['add', '--all', '--force'], staging, executable);
      // Identity is passed per invocation rather than written into the repository, so the staging
      // config stays exactly as `git init` created it and has nothing of ours to tamper with.
      const commit = add.ok ? await git([...COMMIT_IDENTITY, 'commit', '--quiet', '--no-gpg-sign', '--no-verify', '-m', `Office snapshot ${id}`], staging, executable, manifest.createdAt) : add;
      const head = commit.ok ? await git(['rev-parse', 'HEAD'], staging, executable) : commit;
      if (head.ok && /^[a-f0-9]{40}$/.test(head.out)) stagingCommit = head.out;
      else warnings.push(`The staging commit could not be created: ${head.out || 'unknown git failure'}. This snapshot is a local preview only and cannot be transferred.`);
    } else {
      warnings.push(`Git is unavailable for staging: ${init.out || 'git could not be started'}. This snapshot is a local preview only and cannot be transferred.`);
    }
    const snapshot: InputSnapshot = {
      ...(input.objectRoot ? { objectsStored: true as const } : {}),
      id, projectId: project.id, requestId: input.requestId ?? null, locationRevision: location?.revision ?? 0,
      requestRevision: input.requestRevision ?? null, route, files, generated, totalBytes,
      manifestHash: canonicalHash(manifest), stagingCommit, stagingPath: staging, warnings, provenance: 'OFFICE_STAGED', createdAt: manifest.createdAt,
    };
    input.store.recordInputSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    removeTreeSync(staging);
    throw error;
  }
}

/** Every path under the staging directory, relative and slash-separated, excluding Git's own store. */
function walkStaged(root: string, prefix = ''): { paths: string[]; links: string[] } {
  const paths: string[] = [];
  const links: string[] = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relative === '.git') continue;
    if (entry.isSymbolicLink()) { links.push(relative); continue; }
    if (entry.isDirectory()) {
      const nested = walkStaged(root, relative);
      paths.push(...nested.paths);
      links.push(...nested.links);
    } else if (entry.isFile()) paths.push(relative);
    else links.push(relative);
  }
  return { paths, links };
}

/**
 * Verifies a staged snapshot still matches its recorded hashes, before anything is transferred.
 *
 * The whole tree is compared against the frozen inventory, not only the selected files: an added
 * file travels just as surely as a changed one, and a rewritten manifest would otherwise describe
 * a payload nobody approved. The manifest is re-hashed to the value frozen in the snapshot record,
 * which is held in the workspace database rather than in the directory being checked.
 */
export function verifyStagedSnapshot(snapshot: InputSnapshot): string[] {
  const problems: string[] = [];
  if (!existsSync(snapshot.stagingPath)) return [`The prepared directory for this snapshot is gone: ${snapshot.stagingPath}`];
  try { ensureOwnedStaging(snapshot.stagingPath); }
  catch (error) { return [error instanceof Error ? error.message : 'The prepared directory could not be trusted.']; }
  const inventory = [...snapshot.files, ...(snapshot.generated ?? [])];
  for (const file of inventory) {
    const staged = path.join(snapshot.stagingPath, file.path);
    if (!existsSync(staged)) { problems.push(`Missing staged file ${file.path}`); continue; }
    if (lstatSync(staged).isSymbolicLink()) { problems.push(`Staged file was replaced by a link: ${file.path}`); continue; }
    const bytes = readFileSync(staged);
    if (bytes.byteLength !== file.bytes) { problems.push(`Staged file changed size since preparation: ${file.path}`); continue; }
    if (sha256(bytes) !== file.sha256) problems.push(`Staged file changed since preparation: ${file.path}`);
  }

  const { paths, links } = walkStaged(snapshot.stagingPath);
  for (const link of links) problems.push(`Staged tree contains a link, which is never transferred: ${link}`);
  const expected = new Set([...inventory.map(file => file.path), MANIFEST_PATH]);
  for (const found of paths) if (!expected.has(found)) problems.push(`Unexpected extra file in the prepared directory: ${found}`);

  // The manifest is the payload's own description; a tampered one must not be able to describe itself.
  const manifestFile = path.join(snapshot.stagingPath, MANIFEST_PATH);
  if (!existsSync(manifestFile)) problems.push(`Missing staged file ${MANIFEST_PATH}`);
  else {
    try {
      const parsed = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
      if (canonicalHash(parsed) !== snapshot.manifestHash) problems.push('The prepared manifest no longer matches the frozen record for this snapshot.');
    } catch {
      problems.push('The prepared manifest is not readable JSON.');
    }
  }
  return problems;
}

/**
 * The complete check the transfer path runs: the staged bytes, plus the Git commit and tree the
 * supported route actually ships. A snapshot without a commit is a local preview and is refused
 * here rather than being uploaded as though it were reproducible.
 */
export async function verifySnapshotForTransfer(snapshot: InputSnapshot, gitExecutable = 'git', managedRoot?: string): Promise<string[]> {
  const problems = verifyStagedSnapshot(snapshot);
  if (!existsSync(snapshot.stagingPath)) return problems;
  try { ensureOwnedStaging(snapshot.stagingPath, managedRoot); }
  catch (error) { problems.push(error instanceof Error ? error.message : 'The prepared directory could not be trusted.'); return problems; }
  if (!snapshot.stagingCommit) {
    problems.push('This snapshot has no staging commit, so it is a local preview and cannot be transferred. Prepare the request again once Git is available.');
    return problems;
  }
  try { assertPlainStagingRepository(snapshot.stagingPath); }
  catch (error) {
    // Refusing to run Git at all is the point: a tree carrying repository metadata we did not write
    // could make the verification itself execute code.
    problems.push(error instanceof Error ? error.message : 'The staging repository could not be trusted.');
    return problems;
  }
  const head = await git(['rev-parse', 'HEAD'], snapshot.stagingPath, gitExecutable);
  if (!head.ok || head.out !== snapshot.stagingCommit) {
    problems.push(`The prepared commit changed since it was frozen: expected ${snapshot.stagingCommit}, found ${head.ok ? head.out : 'no readable HEAD'}.`);
    return problems;
  }
  // Every Git check must succeed. A command that fails tells us nothing, and treating "not unequal"
  // as agreement is how a broken check passes for a passing one.
  const status = await git(['status', '--porcelain', '--untracked-files=all'], snapshot.stagingPath, gitExecutable);
  if (!status.ok) problems.push(`The prepared directory could not be checked against its commit: ${status.out}`);
  else if (status.out) problems.push(`The prepared directory no longer matches its commit: ${status.out.split('\n')[0]}`);
  // The index can record a file as unchanged while the working copy differs; --no-optional-locks with
  // a refreshed comparison against HEAD catches what a cached status would miss.
  const staged = await git(['diff', '--no-ext-diff', '--name-only', 'HEAD'], snapshot.stagingPath, gitExecutable);
  if (!staged.ok) problems.push(`The prepared directory could not be compared to its commit: ${staged.out}`);
  else if (staged.out) problems.push(`The prepared directory differs from its commit in ${staged.out.split('\n')[0]}.`);
  const count = await git(['rev-list', '--count', 'HEAD'], snapshot.stagingPath, gitExecutable);
  if (!count.ok) problems.push(`The prepared history could not be counted: ${count.out}`);
  else if (count.out !== '1') problems.push(`The prepared history is no longer the single frozen commit: ${count.out} commits found.`);
  const parents = await git(['rev-list', '--parents', '-n', '1', 'HEAD'], snapshot.stagingPath, gitExecutable);
  if (!parents.ok) problems.push(`The prepared commit's parents could not be read: ${parents.out}`);
  else if (parents.out.trim().split(/\s+/).length !== 1) problems.push('The prepared commit is no longer parentless.');
  const refs = await git(['for-each-ref', '--format=%(refname)'], snapshot.stagingPath, gitExecutable);
  if (!refs.ok) problems.push(`The prepared refs could not be listed: ${refs.out}`);
  else {
    const unexpected = refs.out.split('\n').map(line => line.trim()).filter(line => line && line !== 'refs/heads/office-snapshot');
    if (unexpected.length) problems.push(`The prepared repository carries unexpected refs: ${unexpected[0]}.`);
  }

  // The committed tree itself, path by path, with modes and blob identities, against the frozen
  // manifest. Status and diff describe the working copy; this describes what would actually ship.
  const tree = await git(['ls-tree', '-r', '--full-tree', '-z', 'HEAD'], snapshot.stagingPath, gitExecutable);
  if (!tree.ok) problems.push(`The committed tree could not be read: ${tree.out}`);
  else {
    const committed = new Map<string, { mode: string; blob: string }>();
    for (const record of tree.out.split('\0').filter(Boolean)) {
      const [meta, file] = record.split('\t');
      const [mode, type, blob] = meta.split(/\s+/);
      if (type !== 'blob') { problems.push(`The committed tree contains a ${type} at ${file}, which the office never commits.`); continue; }
      if (mode !== '100644') problems.push(`The committed tree records ${file} with mode ${mode}, not the regular file mode the office writes.`);
      committed.set(file, { mode, blob });
    }
    const inventory = [...snapshot.files, ...(snapshot.generated ?? [])];
    for (const file of inventory) {
      const found = committed.get(file.path);
      if (!found) { problems.push(`The committed tree is missing ${file.path}.`); continue; }
      const hashed = await git(['hash-object', '--', file.path], snapshot.stagingPath, gitExecutable);
      if (!hashed.ok) problems.push(`The staged copy of ${file.path} could not be hashed for comparison: ${hashed.out}`);
      else if (hashed.out !== found.blob) problems.push(`The staged copy of ${file.path} differs from the committed blob.`);
      committed.delete(file.path);
    }
    for (const extra of committed.keys()) problems.push(`The committed tree carries ${extra}, which is not in the frozen manifest.`);
  }
  return problems;
}

/**
 * Rebuilds a staging directory for one snapshot from the stored objects.
 *
 * The original source folder is never consulted: it may have changed, moved or gone, and re-reading
 * it would silently produce different inputs under the same snapshot identity. Because both commit
 * dates were pinned at preparation, replaying the same bytes reproduces the same commit, so the
 * result can be checked against the identifier frozen at the time rather than merely trusted.
 *
 * A snapshot prepared before this store existed has no objects to rebuild from. That is reported as
 * unreconstructable and requires explicit re-preparation; it never falls back to reading sources.
 */
export async function reconstructSnapshot(input: {
  snapshot: InputSnapshot; objectRoot: string; stagingRoot: string; gitExecutable?: string;
}): Promise<{ stagingPath: string; stagingCommit: string; problems: string[] }> {
  const { snapshot, objectRoot } = input;
  const inventory = [...snapshot.files, ...(snapshot.generated ?? [])];
  if (!snapshot.generated)
    throw new Error('This snapshot was prepared before its bytes were stored durably, so it cannot be reconstructed. Prepare the request again.');
  const absent = inventory.filter(file => !existsSync(snapshotObjectPath(objectRoot, file.sha256)));
  if (absent.length)
    throw new Error(`This snapshot cannot be reconstructed: ${absent.length} stored object${absent.length === 1 ? '' : 's'} are missing, starting with ${absent[0].path}. Prepare the request again.`);

  // The destination is derived from the immutable snapshot id under a validated root, and its whole
  // path is checked for links before anything is deleted. Recursive deletion through a redirected
  // ancestor would remove a tree the office does not own.
  assertNoLinkedAncestor(input.stagingRoot, component => `The staging root is reached through a link at ${component}.`);
  const staging = path.join(path.resolve(input.stagingRoot), snapshot.id);
  const inside = path.relative(path.resolve(input.stagingRoot), staging);
  if (inside !== snapshot.id) throw new Error('The reconstruction destination is not directly inside the staging root.');
  if (existsSync(staging)) {
    assertNoLinkedAncestor(staging, component => `The existing prepared directory is reached through a link at ${component}; it will not be deleted.`);
    removeTreeSync(staging);
  }
  mkdirSync(staging, { recursive: true });
  for (const file of inventory) {
    const bytes = readFileSync(snapshotObjectPath(objectRoot, file.sha256));
    if (sha256(bytes) !== file.sha256) throw new Error(`A stored object no longer matches its identity: ${file.path}`);
    const destination = path.join(staging, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }

  const executable = input.gitExecutable ?? 'git';
  let stagingCommit = '';
  const problems: string[] = [];
  const init = await git(['init', '--quiet', '-b', 'office-snapshot'], staging, executable);
  if (init.ok) {
    const add = await git(['add', '--all', '--force'], staging, executable);
    const commit = add.ok ? await git([...COMMIT_IDENTITY, 'commit', '--quiet', '--no-gpg-sign', '--no-verify', '-m', `Office snapshot ${snapshot.id}`], staging, executable, snapshot.createdAt) : add;
    const head = commit.ok ? await git(['rev-parse', 'HEAD'], staging, executable) : commit;
    if (head.ok && /^[a-f0-9]{40}$/.test(head.out)) stagingCommit = head.out;
  }
  if (snapshot.stagingCommit && stagingCommit !== snapshot.stagingCommit)
    problems.push(`The reconstructed commit ${stagingCommit || 'could not be created'} does not match the frozen ${snapshot.stagingCommit}.`);
  return { stagingPath: staging, stagingCommit, problems };
}

/** What one attempt's results may be written to, and exactly what would be shared to get there. */
export interface OutputDestination {
  /** The directory this attempt owns. It is created only when the caller commits to the transfer. */
  path: string;
  attempt: number;
  managed: boolean;
  /** Every file that would leave the office, so the user sees it before anything is shared. */
  files: SnapshotFile[];
  totalBytes: number;
}

/**
 * Confirms a chosen output folder can actually receive results, before anything is transferred.
 *
 * A readable but read-only input folder is perfectly valid; an output folder that cannot be written
 * is not, and the difference has to be established by writing, not by reading a permission bit that
 * the filesystem may not honour. The probe file is removed again immediately.
 */
export function assertWritableDestination(root: string): string {
  assertNoLinkedAncestor(root, component => `The output folder is reached through a link at ${component}.`);
  if (!path.isAbsolute(root)) throw new Error('The output folder must be an absolute path on this device.');
  if (/^\\\\/.test(root) || /^\/\//.test(root)) throw new Error('Network folders are not supported yet. Choose a local output folder.');
  if (!existsSync(root)) throw new Error('The output folder no longer exists. Choose it again.');
  const real = realpathSync(root);
  if (!statSync(real).isDirectory()) throw new Error('The output folder is not a directory.');
  if (path.resolve(root) !== real && lstatSync(path.resolve(root)).isSymbolicLink())
    throw new Error('The output folder is a link. Choose the real folder it points at.');
  const probe = path.join(real, `.office-write-check-${randomUUID()}`);
  try {
    writeFileSync(probe, '', { flag: 'wx' });
  } catch (error) {
    throw new Error(`The output folder cannot be written to: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`);
  } finally {
    rmSync(probe, { force: true });
  }
  return real;
}

/**
 * Reserves the managed, versioned directory one attempt may write into.
 *
 * This is a reservation, not a lookup. Two callers asking at the same moment, or a caller asking
 * twice, must not both be told they may use the same directory, and an empty directory another
 * attempt already reserved is not free merely because nothing has been written into it yet.
 * Exclusive directory creation is what settles it: `mkdir` fails if the name already exists, and
 * that failure is the signal to try the next attempt rather than something to ignore.
 *
 * `idempotencyKey` lets one logical attempt re-enter its own reservation after a crash or a retry.
 * Without a matching key, an existing reservation belongs to somebody else.
 */
export function reserveOutputDestination(input: {
  outputRoot: string; projectId: string; requestId: string; assignmentId: string; managed: boolean;
  idempotencyKey: string; snapshot?: InputSnapshot;
}): OutputDestination {
  const root = assertWritableDestination(input.outputRoot);
  // Generated path components are derived from recorded identifiers; anything else could escape the
  // destination the user chose.
  for (const [label, value] of [['project', input.projectId], ['request', input.requestId], ['assignment', input.assignmentId]] as const)
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(value) || value === '.' || value === '..')
      throw new Error(`The ${label} identifier is not a safe path component.`);
  const base = path.join(root, `project-${input.projectId}`, `request-${input.requestId}`, `assignment-${input.assignmentId}`);
  if (!input.idempotencyKey.trim() || input.idempotencyKey !== input.idempotencyKey.trim()) throw new Error('A nonempty reservation identity is required.');
  assertNoLinkedAncestor(base, component => `The output destination is reached through a link at ${component}.`);
  mkdirSync(base, { recursive: true });
  assertNoLinkedAncestor(base, component => `The output destination is reached through a link at ${component}.`);

  const files = input.snapshot ? [...input.snapshot.files, ...(input.snapshot.generated ?? [])] : [];
  const describe = (candidate: string, attempt: number): OutputDestination => ({
    path: candidate, attempt, managed: input.managed, files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  });

  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const candidate = path.join(base, `attempt-${String(attempt).padStart(3, '0')}`);
    const marker = path.join(candidate, RESERVATION_FILE);
    assertNoLinkedAncestor(marker, component => `The output reservation is reached through a link at ${component}.`);
    if (existsSync(candidate)) {
      // Somebody holds this attempt. It is ours only if it carries our own key.
      const held = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';
      if (held && held === input.idempotencyKey) return describe(candidate, attempt);
      continue;
    }
    try {
      // Exclusive: this throws rather than succeeding if another caller won the race.
      mkdirSync(candidate);
    } catch {
      continue;
    }
    writeFileSync(marker, input.idempotencyKey, { flag: 'wx' });
    return describe(candidate, attempt);
  }
  throw new Error('This assignment already has 999 reserved attempts. Retire it rather than adding another.');
}

/** Names the reservation holder, so a re-entry can be told apart from another caller's directory. */
export const RESERVATION_FILE = '.office-attempt';

/**
 * Releases a reservation that was never used.
 *
 * Only a directory holding our own key and nothing else is removed. A reservation somebody wrote
 * results into is evidence, and a failed preflight is not a reason to delete it.
 */
export function releaseUnusedReservation(destination: string, idempotencyKey: string): boolean {
  assertNoLinkedAncestor(path.join(destination, RESERVATION_FILE), component => `The output reservation is reached through a link at ${component}.`);
  const marker = path.join(destination, RESERVATION_FILE);
  if (!existsSync(marker) || readFileSync(marker, 'utf8').trim() !== idempotencyKey) return false;
  if (readdirSync(destination).some(name => name !== RESERVATION_FILE)) return false;
  removeTreeSync(destination);
  return true;
}
