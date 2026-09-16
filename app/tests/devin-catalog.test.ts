import test from 'node:test';
import assert from 'node:assert/strict';
import { devinModelCatalog, providerLogin, subscriptionEnvironment } from '../src/main/subscriptions';

// Unit coverage only: `devin auth status` is not logged in on this machine and the signed-in
// output shape is unverified, so no test here may spawn the real CLI.

test('a devin draft selects the devin login flow and never the claude executable', () => {
  const devin = providerLogin('devin')!;
  assert.equal(devin.provider, 'devin');
  assert.equal(devin.executable, 'devin.exe');
  assert.deepEqual(devin.args, ['auth', 'login']);
  assert.notEqual(devin.executable, providerLogin('claude')!.executable);
});

test('the login seam keeps the claude terminal flow and excludes the browser-flow provider', () => {
  const claude = providerLogin('claude')!;
  assert.equal(claude.provider, 'claude');
  assert.equal(claude.executable, 'claude.exe');
  assert.deepEqual(claude.args, ['auth', 'login']);
  assert.equal(providerLogin('openai'), null, 'openai signs in through the Codex app-server browser flow, not a login window');
});

test('the catalog collects family slugs and variant model_uids with label-derived display names', () => {
  // Shaped like the real `devin models list --format json`: family objects carrying variant
  // objects that expose only model_uid + label.
  const parsed = [
    { slug: 'swe', displayName: 'SWE family', variants: [
      { model_uid: 'swe-2-max', label: 'SWE-2 Max' },
      { model_uid: 'swe-2', label: 'SWE-2' },
    ] },
    { slug: 'devin', name: 'Devin', variants: [
      { model_uid: 'devin-latest', label: 'Devin latest' },
      { model_uid: 'swe-2', label: 'A duplicate id is collected once' },
    ] },
  ];
  const models = devinModelCatalog(parsed);
  const ids = models.map(m => m.id);
  for (const id of ['swe', 'devin', 'swe-2-max', 'swe-2', 'devin-latest'])
    assert.ok(ids.includes(id), `expected ${id} in ${ids.join(', ')}`);
  assert.equal(new Set(ids).size, ids.length, 'collection dedupes by id');
  assert.equal(models.find(m => m.id === 'swe-2-max')!.name, 'SWE-2 Max', 'a variant without displayName is labeled by label');
  assert.equal(models.find(m => m.id === 'swe')!.name, 'SWE family', 'a family keeps its displayName');
  for (const model of models) assert.equal(model.source, 'Installed Devin CLI models list --format json; cloud application unverified');
});

test('the collector accepts an object-wrapped catalog, stays deduped and respects the 512 cap', () => {
  const wrapped = { families: Array.from({ length: 600 }, (_, i) => ({ model_uid: `variant-${i}`, label: `Variant ${i}` })) };
  const models = devinModelCatalog(wrapped);
  assert.equal(models.length, 512, 'the catalog cap still holds');
  assert.equal(new Set(models.map(m => m.id)).size, 512);
});

test('empty and shapeless catalogs collect nothing rather than fabricating entries', () => {
  assert.deepEqual(devinModelCatalog([]), []);
  assert.deepEqual(devinModelCatalog({}), []);
  assert.deepEqual(devinModelCatalog('not a catalog'), []);
  assert.deepEqual(devinModelCatalog({ items: [{ label: 'label without any id' }] }), []);
});

test('provider CLI environments strip ACP_* variables while unrelated variables survive', () => {
  // Agent-spawned shells set ACP_BACKEND (e.g. windsurf); passing it to `devin auth status`
  // makes the CLI report signed-out even when its own credential is valid.
  const saved = {
    ACP_BACKEND: process.env.ACP_BACKEND,
    ACP_SESSION_ID: process.env.ACP_SESSION_ID,
    QRO_UNRELATED: process.env.QRO_UNRELATED,
  };
  process.env.ACP_BACKEND = 'windsurf';
  process.env.ACP_SESSION_ID = 'session-fixture';
  process.env.QRO_UNRELATED = 'survives';
  try {
    const env = subscriptionEnvironment();
    assert.equal(env.ACP_BACKEND, undefined, 'ACP_BACKEND must not reach provider CLI probes');
    assert.equal(env.ACP_SESSION_ID, undefined, 'the ACP_ prefix is stripped, not one variable');
    assert.equal(env.QRO_UNRELATED, 'survives', 'unrelated variables pass through');
    assert.equal(process.env.ACP_BACKEND, 'windsurf', 'the parent process environment is not mutated');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
