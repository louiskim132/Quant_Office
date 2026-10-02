import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BINDINGS, parseBindings, bindKey, bindMouse, shortcutKey } from '../src/renderer/office3d/bindings';
import { modelLabel } from '../src/renderer/model-label';
import { OfficeStore } from '../src/core/store';

test('custom controls persist, swap conflicts, and reject malformed preferences', () => {
  assert.deepEqual(parseBindings('broken'), DEFAULT_BINDINGS);
  assert.deepEqual(parseBindings('{}'), DEFAULT_BINDINGS);
  const bindings = bindKey(bindMouse(parseBindings(''), 0, 'rotate'), 'panLeft', 'ArrowLeft');
  assert.deepEqual(bindings.mouse, ['rotate', 'zoom', 'pan']);
  assert.equal(bindings.keys.rotateLeft, 'a');
  assert.equal(bindings.keys.panLeft, 'ArrowLeft');
  assert.deepEqual(parseBindings(JSON.stringify(bindings)), bindings);
  assert.deepEqual(parseBindings(JSON.stringify({ ...bindings, mouse: ['pan', 'pan', 'zoom'] })), DEFAULT_BINDINGS);
  assert.equal(shortcutKey({ key: 'K', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }), 'Ctrl+k');
  assert.equal(shortcutKey({ key: 'Tab', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }), '');
});

test('Devin model variant labels separate requested model and effort without changing records', () => {
  const agent = { provider: 'devin' as const, model: 'swe-2-max', effort: 'default' as const };
  assert.equal(modelLabel(agent), 'devin · swe-2 · max effort');
  assert.equal(agent.model, 'swe-2-max');
  assert.equal(agent.effort, 'default');
  assert.equal(modelLabel({ ...agent, model: 'swe-2', effort: 'max' }), 'devin · swe-2 · max effort');
  assert.equal(
    modelLabel({ ...agent, provider: 'openai', model: 'some-model-max' }),
    'openai · some-model-max · default effort',
  );
  assert.equal(modelLabel({ ...agent, model: 'swe-2-experimental' }), 'devin · swe-2-experimental · default effort');
});

test('workspace history sorts all providers before paginating, without changing stored order', () => {
  const sessions = Array.from({ length: 30 }, (_, i) => ({
    id: String(i).padStart(3, '0'),
    projectId: 'p1',
    provider: i < 26 ? 'claude' : i % 2 ? 'devin' : 'openai',
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  }));
  const store = { readProjection: () => ({ localSessions: sessions }) } as unknown as OfficeStore;
  const first = OfficeStore.prototype.localSessionFeed.call(store, { limit: 25 });
  const second = OfficeStore.prototype.localSessionFeed.call(store, { limit: 25, offset: 25 });
  assert.equal(first.total, 30);
  assert.deepEqual([...new Set(first.entries.map(s => s.provider))].sort(), ['claude', 'devin', 'openai']);
  assert.equal(first.entries[0].id, '029');
  assert.equal(second.entries.length, 5);
  assert.equal(new Set([...first.entries, ...second.entries].map(s => s.id)).size, 30);
  assert.equal(sessions[0].id, '000');
});
