import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedLoginArgs } from '../src/main/agent-isolation-login.js';

test('isolated sign-in uses each CLI official flow that needs no browser in the agent account', () => {
  assert.deepEqual(isolatedLoginArgs('openai'), ['login', '--device-auth']);
  assert.deepEqual(isolatedLoginArgs('devin'), ['auth', 'login', '--force-manual-token-flow']);
  assert.deepEqual(isolatedLoginArgs('claude'), ['auth', 'login', '--claudeai']);
});
