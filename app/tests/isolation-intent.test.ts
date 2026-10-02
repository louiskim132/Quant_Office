import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Secrets, type SecretBox } from '../src/main/secrets.js';

const box: SecretBox = {
  available: () => true,
  encrypt: plain => Buffer.from(plain),
  decrypt: blob => blob.toString(),
};
const unavailable: SecretBox = { ...box, available: () => false };
const failing: SecretBox = {
  ...box,
  decrypt: () => {
    throw new Error('DPAPI failed');
  },
};
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-isolation-intent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('saved isolation intent survives decryption failure, missing credentials, and process restart', t => {
  const root = fixture(t);
  const secrets = new Secrets(root, box);
  secrets.saveProviderKey('openai', 'synthetic-provider-key');
  secrets.saveAgentUser('QRO-Agent', 'synthetic-password');
  const file = path.join(root, 'secrets.dat');
  const original = readFileSync(file);
  const restarted = new Secrets(root, failing);
  assert.equal(restarted.hasAgentCredential(), false);
  assert.equal(restarted.isolationRequired(), true);
  assert.equal(new Secrets(root, unavailable).isolationRequired(), true);
  assert.deepEqual(readFileSync(file), original);
  assert.throws(() => restarted.saveProviderKey('claude', 'replacement'), /could not be read/);
  assert.deepEqual(readFileSync(file), original);
  unlinkSync(file);
  assert.equal(new Secrets(root, box).isolationRequired(), true, 'missing secret bytes cannot disable intent');
  const intent = readFileSync(path.join(root, 'agent-isolation.json'), 'utf8');
  assert.deepEqual(JSON.parse(intent), { version: 1, required: true });
  assert.equal(intent.includes('synthetic'), false);
});

test('explicit disable survives restart with encrypted storage unavailable and preserves credential bytes', t => {
  const root = fixture(t);
  new Secrets(root, box).saveAgentUser('QRO-Agent', 'synthetic-password');
  const file = path.join(root, 'secrets.dat');
  const original = readFileSync(file);
  const secrets = new Secrets(root, unavailable);
  secrets.removeAgentUser();
  assert.equal(secrets.isolationRequired(), false);
  assert.equal(new Secrets(root, failing).isolationRequired(), false);
  assert.equal(new Secrets(root, box).isolationRequired(), false, 'recovering DPAPI does not undo explicit disable');
  assert.deepEqual(readFileSync(file), original);
  new Secrets(root, box).saveAgentUser('QRO-Agent', 'new-synthetic-password');
  assert.equal(new Secrets(root, unavailable).isolationRequired(), true, 'explicit setup re-enables intent');
});

test('readable legacy agent credentials migrate independently of the encrypted file', t => {
  const root = fixture(t);
  const file = path.join(root, 'secrets.dat');
  const bytes = box
    .encrypt(
      JSON.stringify({
        version: 1,
        providers: {},
        agentUser: {
          user: 'QRO-Agent',
          password: 'legacy-synthetic-password',
          savedAt: '2026-10-02T00:00:00Z',
        },
      }),
    )
    .toString('base64');
  writeFileSync(file, bytes);
  assert.equal(new Secrets(root, box).isolationRequired(), true);
  assert.equal(new Secrets(root, unavailable).isolationRequired(), true);
  assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('unreadable legacy secrets conservatively migrate without credential loss', t => {
  for (const primitive of [unavailable, failing, box]) {
    const root = fixture(t);
    const file = path.join(root, 'secrets.dat');
    writeFileSync(file, 'corrupt legacy bytes');
    assert.equal(new Secrets(root, primitive).isolationRequired(), true);
    assert.equal(new Secrets(root, unavailable).isolationRequired(), true);
    assert.equal(readFileSync(file, 'utf8'), 'corrupt legacy bytes');
  }
});

test('legacy quarantine and malformed intent cannot authorize ordinary execution', t => {
  const root = fixture(t);
  new Secrets(root, box).saveProviderKey('claude', 'synthetic-key');
  writeFileSync(path.join(root, 'secrets.broken-2026-10-01.dat'), 'preserved ciphertext');
  assert.equal(new Secrets(root, box).isolationRequired(), true);
  const intent = path.join(root, 'agent-isolation.json');
  for (const malformed of ['broken', '{"version":1,"required":"false"}', '{"version":2,"required":false}']) {
    writeFileSync(intent, malformed);
    assert.equal(new Secrets(root, box).isolationRequired(), true);
  }
});

test('unreadable isolation intent fails closed rather than being treated as absent', t => {
  const root = fixture(t);
  mkdirSync(path.join(root, 'agent-isolation.json'));
  assert.equal(new Secrets(root, box).isolationRequired(), true);
  assert.throws(() => new Secrets(root, box).removeAgentUser());
  assert.equal(new Secrets(root, box).isolationRequired(), true, 'failed disable cannot change intent');
});

test('fresh and readable provider-only configurations keep isolation opt-in; readable disable preserves keys', t => {
  const root = fixture(t);
  const secrets = new Secrets(root, box);
  assert.equal(secrets.isolationRequired(), false);
  secrets.saveProviderKey('claude', 'synthetic-key');
  assert.equal(secrets.isolationRequired(), false);
  secrets.saveAgentUser('QRO-Agent', 'synthetic-password');
  secrets.removeAgentUser();
  const restarted = new Secrets(root, box);
  assert.equal(restarted.isolationRequired(), false);
  assert.equal(restarted.agentCredential(), null);
  assert.equal(restarted.providerKey('claude'), 'synthetic-key');
});
