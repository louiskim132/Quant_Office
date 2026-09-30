import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Agent } from '../src/shared/types';

// office-scene.tsx imports its stylesheets for the bundler; Node can't load .css, so the
// unit-level import stubs them. This tests the scene's real zone helper, not a copy.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { seatZones } = await import('../src/renderer/office-scene');

const seat = (id: string, role: Agent['role']) => ({ id, name: id, role }) as Agent;

test('seatZones groups the floor into director / PM / worker zones', () => {
  const zones = seatZones([
    seat('w1', 'WORKER'),
    seat('d1', 'DIRECTOR'),
    seat('pa', 'PM_A'),
    seat('w2', 'WORKER'),
    seat('pd', 'PM_D'),
  ]);
  assert.deepEqual(
    zones.directors.map(a => a.id),
    ['d1'],
  );
  assert.deepEqual(
    zones.pms.map(a => a.id),
    ['pa', 'pd'],
  );
  assert.deepEqual(
    zones.workers.map(a => a.id),
    ['w1', 'w2'],
  );
});

test('seatZones preserves join order inside a zone and drops vacated seats', () => {
  const zones = seatZones([seat('w2', 'WORKER'), null, seat('w1', 'WORKER'), seat('pb', 'PM_B')]);
  assert.deepEqual(
    zones.workers.map(a => a.id),
    ['w2', 'w1'],
  );
  assert.deepEqual(zones.directors, []);
});

test('seatZones leaves every zone empty on an empty floor', () => {
  assert.deepEqual(seatZones([null, null]), { directors: [], pms: [], workers: [] });
});
