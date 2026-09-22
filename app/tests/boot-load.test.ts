import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWindowWithRetry, type LoadableWindow } from '../src/main/boot-load';

/** A scripted window: each queued entry resolves or rejects the next loadFile call. */
function fakeWindow(script: ('ok' | Error)[]) {
  const calls: string[] = [];
  const win: LoadableWindow = {
    loadFile: (file: string) => {
      calls.push(file);
      const next = script.length ? script.shift()! : 'ok';
      return next === 'ok' ? Promise.resolve() : Promise.reject(next);
    },
  };
  return { win, calls };
}

/** Records the requested delays; never actually waits. */
function fakeSleep() {
  const delays: number[] = [];
  const sleep = (ms: number) => { delays.push(ms); return Promise.resolve(); };
  return { sleep, delays };
}

test('resolves with a single loadFile call on first success', async () => {
  const { win, calls } = fakeWindow(['ok']);
  const { sleep, delays } = fakeSleep();
  await loadWindowWithRetry(win, 'index.html', { sleep });
  assert.deepEqual(calls, ['index.html']);
  assert.deepEqual(delays, [], 'no sleep happens before a success');
});

test('retries once after the injected delay and resolves when the second attempt succeeds', async () => {
  const { win, calls } = fakeWindow([new Error('did-fail-load'), 'ok']);
  const { sleep, delays } = fakeSleep();
  await loadWindowWithRetry(win, 'index.html', { sleep, delayMs: 250 });
  assert.deepEqual(calls, ['index.html', 'index.html']);
  assert.deepEqual(delays, [250], 'exactly one injected delay separated the attempts');
});

test('rejects with the FIRST attempt error when both attempts fail', async () => {
  const first = new Error('did-fail-load');
  const second = new Error('renderer crashed on retry');
  const { win } = fakeWindow([first, second]);
  const { sleep } = fakeSleep();
  await assert.rejects(loadWindowWithRetry(win, 'index.html', { sleep }), error => error === first);
});

test('performs no retry when retries is 0', async () => {
  const failure = new Error('did-fail-load');
  const { win, calls } = fakeWindow([failure]);
  const { sleep, delays } = fakeSleep();
  await assert.rejects(loadWindowWithRetry(win, 'index.html', { retries: 0, sleep }), error => error === failure);
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test('the injected sleep is the only delay — the real clock is never consulted', async () => {
  const { win, calls } = fakeWindow([new Error('did-fail-load'), 'ok']);
  const delays: number[] = [];
  const started = Date.now();
  await loadWindowWithRetry(win, 'index.html', { sleep: ms => { delays.push(ms); return Promise.resolve(); }, delayMs: 400 });
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [400]);
  assert.ok(Date.now() - started < 200, 'the test must not actually wait the configured delay');
});
