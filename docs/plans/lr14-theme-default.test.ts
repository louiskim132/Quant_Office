import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OfficeStore, downgradeWorkspaceToV3 } from '../src/core/store';
import { canonical } from '../src/core/canonical';

const workspace = () => path.join(mkdtempSync(path.join(tmpdir(), 'qro-lr14-')), 'workspace.sqlite');
/** Rewrites a workspace's stored projection to what a version-3 build wrote: theme dark unless the user chose one. */
function makeVersion3(file: string, theme: 'dark' | 'light') {
  const db = new DatabaseSync(file);
  const state = JSON.parse(String((db.prepare('SELECT state FROM projection WHERE singleton=1').get() as { state: string }).state));
  state.settings.theme = theme;
  db.prepare('UPDATE projection SET state=? WHERE singleton=1').run(canonical(state));
  db.exec('PRAGMA user_version=3');
  db.close();
}

test('LR-14: a new workspace starts in the light theme', t => {
  const store = new OfficeStore(workspace());
  t.after(() => store.close());
  assert.equal(store.snapshot().settings.theme, 'light');
});

test('LR-14: an upgraded workspace that never chose a theme becomes light; downgrading restores dark', t => {
  const file = workspace();
  new OfficeStore(file).close();
  makeVersion3(file, 'dark');
  let store = new OfficeStore(file);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  assert.equal(store.snapshot().settings.theme, 'light');
  store.close();
  downgradeWorkspaceToV3(file);
  const db = new DatabaseSync(file);
  assert.equal(JSON.parse(String((db.prepare('SELECT state FROM projection WHERE singleton=1').get() as { state: string }).state)).settings.theme, 'dark');
  db.close();
});

test('LR-14: a theme the user chose is kept through the upgrade', t => {
  const file = workspace();
  let store = new OfficeStore(file);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  store.execute({ type: 'settings.update', idempotencyKey: randomUUID(), settings: { theme: 'dark', reducedMotion: false, globalBudgetCents: 0 } } as never);
  store.close();
  makeVersion3(file, 'dark');
  store = new OfficeStore(file);
  assert.equal(store.snapshot().settings.theme, 'dark');
});
