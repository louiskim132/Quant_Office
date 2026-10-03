import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Secrets, agentEnvironment, type SecretBox } from '../src/main/secrets.js';
import { Subscriptions } from '../src/main/subscriptions.js';
import { OfficeStore } from '../src/core/store.js';

const KEY = 'sk-test-DEADBEEF-0123456789-abcdef';

/** A deterministic fake SecretBox — XOR-masked bytes, so ciphertext never equals plaintext. */
function stubBox(available = true): { box: SecretBox; setAvailable(next: boolean): void } {
  let on = available;
  return {
    box: {
      available: () => on,
      encrypt: plain => Buffer.from(Array.from(Buffer.from(plain, 'utf8'), byte => byte ^ 0x5a)),
      decrypt: blob => Buffer.from(Array.from(blob, byte => byte ^ 0x5a)).toString('utf8'),
    },
    setAvailable(next: boolean) {
      on = next;
    },
  };
}

function dir() {
  return mkdtempSync(path.join(tmpdir(), 'qro-secrets-'));
}

test('a saved key lands in an encrypted secrets.dat with no plaintext material or field names', () => {
  const root = dir();
  const secrets = new Secrets(root, stubBox().box);
  secrets.saveProviderKey('claude', KEY);
  const file = path.join(root, 'secrets.dat');
  assert.equal(existsSync(file), true, 'secrets.dat sits at the userData root, a workspace sibling');
  const raw = readFileSync(file, 'utf8');
  for (const leak of [KEY, 'sk-test', '"key"', 'savedAt', 'providers', 'claude', 'DEADBEEF'])
    assert.equal(raw.includes(leak), false, `secrets.dat carries no plaintext "${leak}"`);
  assert.equal(secrets.providerKey('claude'), KEY, 'the key round-trips through the box');
  const state = secrets.providerKeyState('claude');
  assert.equal(state.saved, true);
  assert.ok(typeof state.savedAt === 'string' && Date.parse(state.savedAt), 'savedAt is a timestamp');
  assert.equal(secrets.providerKey('openai'), null);
  assert.deepEqual(secrets.providerKeyState('openai'), { saved: false });
});

test('rotating a key overwrites it with a new savedAt; removing it clears the mode', () => {
  const root = dir();
  let tick = 0;
  const secrets = new Secrets(root, stubBox().box, undefined, () => `2026-09-28T00:00:0${++tick}.000Z`);
  secrets.saveProviderKey('openai', KEY);
  const first = secrets.providerKeyState('openai');
  secrets.saveProviderKey('openai', KEY + '-rotated');
  const second = secrets.providerKeyState('openai');
  assert.notEqual(second.savedAt, first.savedAt, 'a rewrite records a fresh save time');
  assert.equal(secrets.providerKey('openai'), `${KEY}-rotated`, 'the old key is fully replaced');
  const raw = readFileSync(path.join(root, 'secrets.dat'), 'utf8');
  assert.equal(raw.includes(`${KEY}-rotated`), false, 'the rotated key never appears in plaintext');
  secrets.removeProviderKey('openai');
  assert.deepEqual(secrets.providerKeyState('openai'), { saved: false });
  assert.equal(secrets.providerKey('openai'), null);
  assert.equal(existsSync(path.join(root, 'secrets.dat')), true, 'the encrypted file remains, minus the entry');
});

test('with encrypted storage unavailable a save fails closed and writes nothing', () => {
  const root = dir();
  const secrets = new Secrets(root, stubBox(false).box);
  assert.throws(
    () => secrets.saveProviderKey('claude', KEY),
    /Windows encrypted storage is unavailable; the key was not saved\./,
  );
  assert.equal(existsSync(path.join(root, 'secrets.dat')), false, 'fail closed: no plaintext fallback');
});

test('a corrupt secrets.dat is preserved and credential mutations refuse to overwrite it', () => {
  const root = dir();
  const file = path.join(root, 'secrets.dat');
  writeFileSync(file, '%%% not the encrypted payload %%%', 'utf8');
  const lines: string[] = [];
  const secrets = new Secrets(root, stubBox().box, line => lines.push(line));
  assert.throws(() => secrets.providerKey('claude'), /could not be read/);
  assert.throws(() => secrets.providerKeyState('claude'), /could not be read/);
  assert.equal(readFileSync(file, 'utf8'), '%%% not the encrypted payload %%%');
  assert.throws(() => secrets.saveProviderKey('claude', KEY), /could not be read/);
  assert.throws(() => secrets.removeProviderKey('claude'), /could not be read/);
  const broken = readdirSync(root).filter(name => /^secrets\.broken-.+\.dat$/.test(name));
  assert.equal(broken.length, 0, 'credentials remain at their original recovery path');
  assert.equal(lines.length, 1, 'the caller logged exactly one line');
});

test('unreadable saved API keys refuse execution and observation without subscription fallback', async () => {
  for (const failure of ['unavailable', 'decrypt'] as const) {
    const root = dir();
    const primitive = stubBox();
    new Secrets(root, primitive.box).saveProviderKey('claude', KEY);
    const bytes = readFileSync(path.join(root, 'secrets.dat'));
    if (failure === 'unavailable') primitive.setAvailable(false);
    else
      primitive.box.decrypt = () => {
        throw new Error('synthetic decrypt failure');
      };
    const secrets = new Secrets(root, primitive.box);
    const service = new Subscriptions(root, async () => {}, undefined, secrets);
    let contacted = 0;
    service.status = async () => {
      contacted++;
      throw new Error('subscription status must not run');
    };
    service.version = async () => {
      contacted++;
      throw new Error('subscription version must not run');
    };
    try {
      assert.throws(() => agentEnvironment('claude', secrets), /unavailable|could not be read/);
      await assert.rejects(service.observe('claude'), /unavailable|could not be read/);
      assert.equal(contacted, 0);
      assert.deepEqual(readFileSync(path.join(root, 'secrets.dat')), bytes);
    } finally {
      service.close();
    }
  }
});

test('agentEnvironment injects exactly the provider key var over the subscription scrub', () => {
  const touched = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'DEVIN_API_KEY',
    'DEVIN_TOKEN',
    'ACP_TEST_MARKER',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ];
  const prior: Record<string, string | undefined> = {};
  for (const name of touched) {
    prior[name] = process.env[name];
    process.env[name] = 'ambient-' + name;
  }
  try {
    const keyed = agentEnvironment('claude', { providerKey: p => (p === 'claude' ? KEY : null) });
    assert.equal(keyed.ANTHROPIC_API_KEY, KEY, 'the saved key is the one var injected for claude');
    for (const name of touched.filter(n => n !== 'ANTHROPIC_API_KEY'))
      assert.equal(keyed[name], undefined, `${name} stays stripped for the spawned CLI`);
    const bare = agentEnvironment('claude', { providerKey: () => null });
    for (const name of touched)
      assert.equal(bare[name], undefined, `without a saved key ${name} is absent like subscription mode`);
    const openai = agentEnvironment('openai', { providerKey: p => (p === 'openai' ? KEY : null) });
    assert.equal(openai.OPENAI_API_KEY, KEY);
    assert.equal(openai.ANTHROPIC_API_KEY, undefined);
    assert.equal(openai.DEVIN_API_KEY, undefined);
    const devin = agentEnvironment('devin', { providerKey: p => (p === 'devin' ? KEY : null) });
    assert.equal(devin.DEVIN_API_KEY, KEY);
    assert.equal(devin.ANTHROPIC_API_KEY, undefined);
  } finally {
    for (const name of touched)
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
  }
});

test('an api-key observation records honestly and the durable log carries no key material', async () => {
  const root = dir();
  const secrets = new Secrets(root, stubBox().box);
  secrets.saveProviderKey('claude', KEY);
  const service = new Subscriptions(root, async () => {}, undefined, secrets);
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  try {
    const { connection, observation } = await service.observe('claude');
    assert.equal(connection.connected, false, 'an unverified key is never reported as connected');
    assert.equal(connection.account, '', 'no account identity was observed');
    assert.equal(observation.state, 'UNKNOWN', 'configured but unverified — never SIGNED_IN');
    assert.equal(observation.identity, '');
    assert.equal(observation.credentialContext, 'api-key-local');
    assert.deepEqual(
      observation.operations,
      [
        {
          operation: 'ACCOUNT_STATUS',
          level: 'UNKNOWN',
          detail: 'API key saved locally (encrypted with Windows DPAPI). The provider was not contacted.',
          evidence: 'DOCUMENTED',
          verifiedAt: observation.observedAt,
          source: 'local API-key entry',
        },
      ],
      'one honestly-scoped operation row, DOCUMENTED evidence only',
    );
    store.recordAccountObservation(observation);
    const snapshotText = JSON.stringify(store.snapshot());
    assert.equal(snapshotText.includes(KEY), false, 'the workspace snapshot carries no key material');
    assert.equal(snapshotText.includes('api-key@'), false, 'no invented api-key identity lands in state');
    // The raw events table — what outlives the projection — carries no key and no minted identity.
    const db = new DatabaseSync(path.join(root, 'workspace.sqlite'));
    try {
      const rows = db.prepare('SELECT record FROM events').all();
      const raw = JSON.stringify(rows);
      assert.equal(raw.includes(KEY), false, 'event history carries no key material');
      assert.equal(raw.includes('api-key@'), false, 'event history mints no api-key identity');
    } finally {
      db.close();
    }
  } finally {
    store.close();
    service.close();
  }
});

test('observe() in api-key mode spawns no provider process and never falls back to status', async () => {
  const root = dir();
  const secrets = new Secrets(root, stubBox().box);
  secrets.saveProviderKey('openai', KEY);
  const service = new Subscriptions(root, async () => {}, undefined, secrets);
  // Every real check in this class flows through status() and version() — counting them proves
  // observe() returned before any CLI spawn could be reached.
  let statusCalls = 0,
    versionCalls = 0;
  service.status = async () => {
    statusCalls++;
    throw new Error('status must not run in api-key mode');
  };
  service.version = async () => {
    versionCalls++;
    throw new Error('version must not run in api-key mode');
  };
  try {
    const { connection, observation } = await service.observe('openai');
    assert.equal(statusCalls + versionCalls, 0, 'api-key mode contacted nothing');
    assert.equal(
      connection.note,
      'API key saved locally (encrypted with Windows DPAPI). The provider was not contacted.',
    );
    assert.equal(observation.credentialContext, 'api-key-local');
  } finally {
    service.close();
  }
});

test('observe() runs the real subscription check when no key is saved', async () => {
  const root = dir();
  const secrets = new Secrets(root, stubBox().box);
  const service = new Subscriptions(root, async () => {}, undefined, secrets);
  let statusCalls = 0;
  service.status = async () => {
    statusCalls++;
    return {
      provider: 'claude',
      connected: true,
      account: 'researcher@example.test',
      models: [],
      windows: [],
      checkedAt: new Date().toISOString(),
      note: '',
    };
  };
  try {
    const { observation } = await service.observe('claude');
    assert.equal(statusCalls, 1, 'subscription mode still runs the official check');
    assert.equal(observation.state, 'SIGNED_IN');
    assert.equal(observation.identity, 'researcher@example.test');
  } finally {
    service.close();
  }
});
