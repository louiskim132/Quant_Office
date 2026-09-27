import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { removeTreeSync } from '../src/main/fsx';
import { createProviderLifecycle, type ProviderSessionBinding } from '../src/main/local-provider-lifecycle';
import * as records from '../src/main/local-provider-records';
import { claudeProjectKey } from '../src/main/local-provider-records';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-provider-lifecycle-'));
  t.after(() => removeTreeSync(root));
  return { root };
}

/** A fake Devin sessions store; `uniqueIds` controls whether id is a PRIMARY KEY. */
function sessionsDb(
  dir: string,
  rows: { id: string; working_directory: string; title?: string }[],
  uniqueIds = true,
): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sessions.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (
    id TEXT ${uniqueIds ? 'PRIMARY KEY' : ''}, working_directory TEXT, backend_type TEXT, model TEXT, agent_mode TEXT,
    created_at TEXT, last_activity_at TEXT, title TEXT)`);
  for (const row of rows)
    db.prepare('INSERT INTO sessions (id, working_directory, title) VALUES (?, ?, ?)').run(
      row.id,
      row.working_directory,
      row.title ?? null,
    );
  db.close();
  return file;
}

/** A rollout file whose name is the provider-side record identity. */
function rollout(file: string, cwd: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const meta = { timestamp: '2026-09-18T10:00:00.000Z', type: 'session_meta', payload: { id: 'x', cwd } };
  writeFileSync(file, `${JSON.stringify(meta)}\n`);
}

const bind = (provider: ProviderSessionBinding['provider'], providerSessionId: string): ProviderSessionBinding => ({
  provider,
  providerSessionId,
});

test('no callable export of the records module deletes provider files', () => {
  for (const name of Object.keys(records))
    assert.doesNotMatch(name, /retire|remove|delete/i, `export ${name} must not be a deletion path`);
  for (const file of ['local-provider-records.ts', 'local-provider-lifecycle.ts']) {
    const source = readFileSync(new URL(`../src/main/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /\brmSync\b|\brm\b\s*\(|\bunlink\b|\bunlinkSync\b/,
      `${file} must not reach fs deletion`,
    );
  }
});

test('devin inspect finds the exact session row, read-only', async t => {
  const { root } = fixture(t);
  const dbFile = sessionsDb(path.join(root, 'devin', 'cli'), [
    { id: 'mulberry-ferry', working_directory: 'C:\\packets\\one', title: 'Mulberry Ferry' },
    { id: 'mulberry-ferry-two', working_directory: 'C:\\packets\\two', title: 'Prefix sibling' },
  ]);
  const lifecycle = createProviderLifecycle({ sessionsDb: dbFile });
  const before = readFileSync(dbFile);
  const found = await lifecycle.inspect(bind('devin', 'mulberry-ferry'));
  assert.equal(found.status, 'FOUND');
  assert.match(found.detail, /Mulberry Ferry/);
  assert.deepEqual(readFileSync(dbFile), before, 'inspect never writes to sessions.db');
});

test('devin inspect reports missing and never prefix-matches', async t => {
  const { root } = fixture(t);
  const dbFile = sessionsDb(path.join(root, 'devin', 'cli'), [
    { id: 'mulberry-ferry-two', working_directory: 'C:\\packets\\two' },
  ]);
  const lifecycle = createProviderLifecycle({ sessionsDb: dbFile });
  const missing = await lifecycle.inspect(bind('devin', 'mulberry-ferry'));
  assert.equal(missing.status, 'MISSING');
  const absentStore = await createProviderLifecycle({ sessionsDb: path.join(root, 'no.db') }).inspect(
    bind('devin', 'x'),
  );
  assert.equal(absentStore.status, 'MISSING');
  const noStore = await createProviderLifecycle({ sessionsDb: null }).inspect(bind('devin', 'x'));
  assert.equal(noStore.status, 'UNKNOWN');
});

test('devin inspect reports ambiguity and store errors honestly', async t => {
  const { root } = fixture(t);
  const dbFile = sessionsDb(
    path.join(root, 'devin', 'cli'),
    [
      { id: 'dupe', working_directory: 'C:\\a' },
      { id: 'dupe', working_directory: 'C:\\b' },
    ],
    false,
  );
  const lifecycle = createProviderLifecycle({ sessionsDb: dbFile });
  const ambiguous = await lifecycle.inspect(bind('devin', 'dupe'));
  assert.equal(ambiguous.status, 'UNKNOWN');
  assert.match(ambiguous.detail, /ambiguous/);
  const busy = createProviderLifecycle({
    sessionsDb: dbFile,
    devinRows: () => ({ records: [], notes: ['The Devin sessions store could not be read: database is locked'] }),
  });
  assert.equal((await busy.inspect(bind('devin', 'x'))).status, 'BUSY');
  const broken = createProviderLifecycle({
    sessionsDb: dbFile,
    devinRows: () => ({
      records: [],
      notes: ['The Devin sessions store could not be opened read-only: not a database'],
    }),
  });
  assert.equal((await broken.inspect(bind('devin', 'x'))).status, 'UNKNOWN');
});

test('devin archive runs rm once and maps each outcome honestly', async t => {
  const { root } = fixture(t);
  const calls: string[] = [];
  const scripted = new Map<string, { ok: boolean; report: string }>([
    ['gone', { ok: true, report: 'session gone removed' }],
    ['live', { ok: false, report: 'the session is open in another process' }],
    ['absent', { ok: false, report: 'no session found with that id' }],
    ['weird', { ok: false, report: 'exit code 7 for an unstated reason' }],
  ]);
  const lifecycle = createProviderLifecycle({
    sessionsDb: path.join(root, 'unused.db'),
    devinRm: async id => {
      calls.push(id);
      return scripted.get(id) ?? { ok: false, report: 'unscripted' };
    },
  });
  assert.equal((await lifecycle.archive(bind('devin', 'gone'), 'op-1')).status, 'ARCHIVED');
  const busy = await lifecycle.archive(bind('devin', 'live'), 'op-2');
  assert.equal(busy.status, 'BUSY');
  assert.match(busy.detail, /open in another process/, "the tool's own wording rides home");
  const already = await lifecycle.archive(bind('devin', 'absent'), 'op-3');
  assert.equal(already.status, 'ALREADY_ARCHIVED');
  assert.match(already.detail, /already absent/);
  assert.equal((await lifecycle.archive(bind('devin', 'weird'), 'op-4')).status, 'UNKNOWN');
  assert.deepEqual(calls, ['gone', 'live', 'absent', 'weird'], 'one rm call per archive, exact ids');
});

test('devin archive without a resolved executable reports UNKNOWN and touches nothing', async t => {
  const { root } = fixture(t);
  const lifecycle = createProviderLifecycle({ sessionsDb: path.join(root, 'unused.db'), devinRm: null });
  const outcome = await lifecycle.archive(bind('devin', 'mulberry-ferry'), 'op-1');
  assert.equal(outcome.status, 'UNKNOWN');
  assert.match(outcome.detail, /devin\.exe could not be located/);
});

test('claude inspect finds the project key exactly; archive is UNSUPPORTED and preserves bytes', async t => {
  const { root } = fixture(t);
  const projectsRoot = path.join(root, '.claude', 'projects');
  const key = claudeProjectKey(path.join(root, 'packets', 'one'));
  mkdirSync(path.join(projectsRoot, key, 'nested'), { recursive: true });
  const lifecycle = createProviderLifecycle({ claudeProjects: projectsRoot });
  assert.equal((await lifecycle.inspect(bind('claude', key))).status, 'FOUND');
  assert.equal((await lifecycle.inspect(bind('claude', 'no-such-key'))).status, 'MISSING');
  assert.equal(
    (await createProviderLifecycle({ claudeProjects: null }).inspect(bind('claude', key))).status,
    'UNKNOWN',
  );
  const outcome = await lifecycle.archive(bind('claude', key), 'op-1');
  assert.equal(outcome.status, 'UNSUPPORTED');
  assert.match(outcome.detail, /preserved/);
  assert.ok(existsSync(path.join(projectsRoot, key)), 'the project dir is untouched');
});

test('codex inspect finds rollout names exactly and names ambiguity; archive is UNSUPPORTED', async t => {
  const { root } = fixture(t);
  const codexRoot = path.join(root, '.codex');
  const name = 'rollout-2026-09-18T10-00-00-aaaa.jsonl';
  rollout(path.join(codexRoot, 'sessions', '2026', '09', '18', name), 'C:\\packets\\one');
  const lifecycle = createProviderLifecycle({ codexHome: codexRoot });
  assert.equal((await lifecycle.inspect(bind('openai', name))).status, 'FOUND');
  assert.equal((await lifecycle.inspect(bind('openai', 'rollout-2026-01-01T00-00-00-zzzz.jsonl'))).status, 'MISSING');
  // The same file name under both record dirs is ambiguous — UNKNOWN, never a coin flip.
  rollout(path.join(codexRoot, 'archived_sessions', '2026', '09', '18', name), 'C:\\packets\\one');
  const ambiguous = await lifecycle.inspect(bind('openai', name));
  assert.equal(ambiguous.status, 'UNKNOWN');
  assert.match(ambiguous.detail, /ambiguous/);
  const outcome = await lifecycle.archive(bind('openai', name), 'op-1');
  assert.equal(outcome.status, 'UNSUPPORTED');
  assert.match(outcome.detail, /preserved/);
  assert.ok(existsSync(path.join(codexRoot, 'sessions', '2026', '09', '18', name)), 'the rollout is untouched');
});
