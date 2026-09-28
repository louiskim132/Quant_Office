import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeError, writeLog } from '../src/main/diagnostics';

test('writeLog appends one line per call and flattens newlines', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qro-log-'));
  writeLog(dir, 'INFO', 'first', 1000, new Date('2026-09-25T00:00:00Z'));
  writeLog(dir, 'ERROR', 'two\nlines', 1000, new Date('2026-09-25T00:00:01Z'));
  assert.equal(
    readFileSync(path.join(dir, 'main.log'), 'utf8'),
    '2026-09-25T00:00:00.000Z INFO first\n2026-09-25T00:00:01.000Z ERROR two | lines\n',
  );
});

test('writeLog rotates at the size bound and keeps three files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qro-log-'));
  for (let i = 0; i < 40; i++) writeLog(dir, 'INFO', `line ${i} ${'x'.repeat(40)}`, 200);
  assert.ok(existsSync(path.join(dir, 'main.log')));
  assert.ok(existsSync(path.join(dir, 'main.1.log')));
  assert.ok(existsSync(path.join(dir, 'main.2.log')));
  assert.equal(existsSync(path.join(dir, 'main.3.log')), false, 'the oldest file is dropped');
  assert.match(readFileSync(path.join(dir, 'main.log'), 'utf8'), /line 39/);
});

test('writeLog never throws, even when the folder cannot be created', () => {
  assert.doesNotThrow(() => writeLog('\0invalid', 'ERROR', 'x'));
});

test('describeError keeps the name, message and first stack frames on one line', () => {
  const text = describeError(new TypeError('bad value'));
  assert.match(text, /^TypeError: bad value \| at /);
  assert.equal(text.includes('\n'), false);
  assert.equal(describeError('plain'), 'plain');
});
