import test from 'node:test';
import assert from 'node:assert/strict';
import { previewCsv } from '../src/renderer/preview-data';

test('CSV preview retains quoted commas, newlines and escaped quotes with a bounded row count', () => {
  assert.deepEqual(previewCsv('name,value\r\n"a,b","line 1\nline 2"\r\n"a""b",3')?.rows, [
    ['name', 'value'],
    ['a,b', 'line 1\nline 2'],
    ['a"b', '3'],
  ]);
  assert.equal(previewCsv('"unfinished'), null);
  assert.equal(previewCsv('a\nb\nc', 2)?.truncated, true);
});
