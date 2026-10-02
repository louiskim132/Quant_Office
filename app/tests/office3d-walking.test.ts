import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OfficeEngine, type AgentVisual } from '../src/renderer/office3d/engine';
import { buildLayout, placePose } from '../src/renderer/office3d/layout';

function walkingEngine() {
  const engine = Object.create(OfficeEngine.prototype) as any;
  const layout = buildLayout({ director: 1, pm: 0, worker: 0, tables: 2, tableSeats: 6 });
  const place = { kind: 'rest' as const, rest: layout.rest, spot: 0 };
  const pose = placePose(place);
  const root = new THREE.Group();
  root.position.set(pose.pos.x, 0, pose.pos.z);
  const walker = {
    avatar: { id: 'a', root, setPose() {}, update() {} },
    place,
    route: null,
    pending: null,
    pause: 0,
    fade: 1,
    leg: 0,
    yaw: pose.yaw,
    halo: {},
  };
  Object.assign(engine, {
    layout,
    walkers: new Map([['a', walker]]),
    world: { setMonitor() {} },
    opts: { labels: new Map() },
    painted: true,
    reduced: false,
    teleport: false,
    haloMaterial() {},
    updateSelection() {},
    wake() {},
  });
  const visual = (kind: 'desk' | 'rest'): AgentVisual => ({
    id: 'a',
    colors: { shirt: '#fff', hair: '#fff', skin: '#fff' },
    status: '--st-idle',
    monitor: 'off',
    home: 0,
    location: kind === 'rest' ? { kind, spot: 0 } : { kind, index: 0 },
    typing: false,
    talking: false,
    resting: kind === 'rest',
  });
  return { engine, walker, visual };
}

test('a walk discards an obsolete queued return when its destination becomes current again', () => {
  const { engine, walker, visual } = walkingEngine();
  engine.setAgents([visual('desk')]);
  assert.ok(walker.route);
  engine.setAgents([visual('rest')]);
  assert.equal((walker.pending as any)?.kind, 'rest');
  engine.setAgents([visual('desk')]);
  assert.equal(walker.pending, null);
  for (let i = 0; i < 1000; i++) engine.advanceWalkers(0.1);
  assert.equal(walker.route, null);
  assert.equal(walker.place.kind, 'desk');
});

test('a location change during the arrival pause cancels the pending departure', () => {
  const { engine, walker, visual } = walkingEngine();
  engine.setAgents([visual('desk')]);
  engine.setAgents([visual('rest')]);
  for (let i = 0; i < 1000 && walker.route; i++) engine.advanceWalkers(0.1);
  assert.ok(walker.pause > 0);
  engine.setAgents([visual('desk')]);
  for (let i = 0; i < 1000; i++) engine.advanceWalkers(0.1);
  assert.equal(walker.place.kind, 'desk');
  assert.equal(walker.route, null);
  assert.equal(walker.pending, null);
});
