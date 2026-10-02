import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  buildLayout,
  clampTableSeats,
  placePose,
  routeBetween,
  samePlace,
  tableSeatDemand,
  MAX_COLS,
  MAX_TABLE_SEATS,
  MIN_TABLES,
  MIN_TABLE_SEATS,
  type OfficeLayout,
  type Place,
} from '../src/renderer/office3d/layout';
import { assignRooms, remainingAllowance, shouldRest } from '../src/renderer/office3d/visuals';
import type { AccountConnection } from '../src/shared/types';

const layoutOf = (director = 1, pm = 4, worker = 1, tables = 2, tableSeats = 6) =>
  buildLayout({ director, pm, worker, tables, tableSeats });

test('buildLayout seats every agent once and keeps vacant desks distinct', () => {
  const layout = layoutOf(1, 4, 2);
  assert.equal(layout.desks.length, 1 + 4 + 2);
  assert.equal(new Set(layout.desks.map(d => `${d.x}|${d.z}`)).size, layout.desks.length, 'no two desks overlap');
  assert.deepEqual(
    layout.desks.map(d => d.zone),
    ['director', 'pm', 'pm', 'pm', 'pm', 'worker', 'worker'],
  );
  assert.ok(layout.desks.every(d => !d.vacant));
});

test('a zone with nobody in it keeps one vacant desk, and an empty office shows four', () => {
  const missing = layoutOf(0, 2, 0);
  assert.deepEqual(
    missing.desks.map(d => [d.zone, d.vacant]),
    [
      ['director', true],
      ['pm', false],
      ['pm', false],
      ['worker', true],
    ],
  );
  const empty = buildLayout({ director: 0, pm: 0, worker: 0, tables: 0, tableSeats: 0, empty: true });
  assert.equal(empty.desks.length, 4);
  assert.ok(empty.desks.every(d => d.zone === 'worker' && d.vacant));
});

test('desk rows wrap at MAX_COLS and rows never overlap', () => {
  const layout = layoutOf(1, 4, 12);
  const workers = layout.desks.filter(d => d.zone === 'worker');
  assert.equal(new Set(workers.map(d => d.x)).size, MAX_COLS);
  const rows = [...new Set(layout.desks.map(d => d.z))].sort((a, b) => a - b);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i] - rows[i - 1] >= 2.9, 'rows leave room for chair + aisle');
});

test('the floor grows with the team and always fits every desk, room and the corridor', () => {
  const small = layoutOf(1, 1, 1);
  const large = layoutOf(1, 4, 30, 5, 12);
  assert.ok(large.bounds.maxZ > small.bounds.maxZ);
  for (const layout of [small, large]) {
    for (const d of layout.desks) {
      assert.ok(d.x < layout.corridorX && d.seat.z < layout.bounds.maxZ);
      assert.ok(d.aisleZ > d.seat.z, 'the aisle is on the chair side of the desk');
    }
    for (const r of layout.rooms) {
      assert.ok(r.x0 >= layout.wing.x0 && r.x1 <= layout.bounds.maxX && r.z1 < layout.rest.z0);
      for (const s of r.seats) assert.ok(s.seat.x > r.x0 && s.seat.x < r.x1 && s.seat.z > r.z0 && s.seat.z < r.z1);
    }
    assert.ok(layout.rest.z1 === layout.bounds.maxZ && layout.rest.x1 === layout.bounds.maxX);
  }
});

test('meeting rooms: at least two, chairs clamp, every chair faces the table', () => {
  assert.equal(layoutOf(1, 1, 1, 0, 0).rooms.length, MIN_TABLES);
  assert.equal(clampTableSeats(1), MIN_TABLE_SEATS);
  assert.equal(clampTableSeats(7), 8);
  assert.equal(clampTableSeats(99), MAX_TABLE_SEATS);
  assert.equal(tableSeatDemand([3, 9, 5]), 10);
  assert.equal(tableSeatDemand([]), MIN_TABLE_SEATS);
  const layout = layoutOf(1, 1, 1, 3, 10);
  assert.equal(layout.rooms.length, 3);
  for (const room of layout.rooms) {
    assert.equal(room.seats.length, 10);
    for (const s of room.seats) {
      const facing = { x: Math.sin(s.yaw), z: Math.cos(s.yaw) };
      const toTable = { x: room.x - s.seat.x, z: room.z - s.seat.z };
      assert.ok(facing.x * toTable.x + facing.z * toTable.z > 0, 'a chair faces toward the table');
    }
  }
});

test('the rest area fills in a fixed order and its spots are all reachable and distinct', () => {
  const layout = layoutOf(1, 4, 6);
  const { rest } = layout;
  assert.ok(rest.spots.length >= 12);
  assert.equal(new Set(rest.spots.map(s => `${s.seat.x}|${s.seat.z}`)).size, rest.spots.length);
  assert.equal(rest.spots.filter(s => s.kind === 'play').length, 2, 'one ping-pong pair');
  for (const spot of rest.spots) {
    assert.deepEqual(spot.exit.at(-1), rest.gate, 'every spot ends on the corridor gate');
    assert.ok(spot.seat.x > rest.x0 && spot.seat.x < rest.x1 && spot.seat.z > rest.z0 && spot.seat.z < rest.z1);
  }
  assert.equal(rest.spots[0].kind, 'sofa', 'the first person to rest takes a sofa');
});

test('the default team gets about twice the floor of the 2026-10-01 plan (26 x 13.7 m)', () => {
  const layout = layoutOf();
  const { maxX, maxZ } = layout.bounds;
  assert.ok(maxX * maxZ >= 2 * 26.2 * 13.7 * 0.95, `floor ${(maxX * maxZ).toFixed(0)} m2`);
  const rows = [...new Set(layout.desks.map(d => d.z))].sort((a, b) => a - b);
  // From the back of one row's chairs (desk centre + 1.1 m) to the next row's desk edge (centre - 0.4 m).
  for (let i = 1; i < rows.length; i++)
    assert.ok(rows[i] - 0.4 - (rows[i - 1] + 1.1) >= 2.4, 'at least 2.4 m behind every chair');
  assert.ok(layout.corridorWidth >= 3, 'the street is at least 3 m wide');
});

test('the status board stands behind and left of the director, faces the default camera and blocks no aisle', () => {
  for (const director of [1, 3, 4, 5]) {
    const layout = layoutOf(director, 4, 2);
    const dirs = layout.desks.filter(d => d.zone === 'director');
    const first = dirs[0];
    const { board } = layout;
    assert.ok(board.z < first.z - 1.2, 'behind the director row, toward the planted wall');
    assert.ok(board.x < first.x - 2.4, 'to the left of the first director desk');
    assert.ok(Math.abs(board.yaw - Math.PI / 4) < 1e-9, 'turned toward the default camera');
    // Its ends swing ±1.17 m in x and z at 45°: keep them off the wall's planter trough (to z 0.62).
    assert.ok(board.z - 1.17 > 0.7, 'clear of the planted wall');
    assert.ok(board.x - 1.3 > 0.9, 'clear of the west bookshelves');
    for (const d of layout.desks) assert.ok(Math.hypot(d.x - board.x, d.z - board.z) > 2.4, 'clear of every desk');
    assert.ok(board.z + 1.3 < first.aisleZ, 'clear of the row aisle');
  }
});

/** Bounds on screen (view-space metres) of world points, seen from the default camera. */
function screenBox(points: [number, number, number][]) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 600);
  camera.position.setFromSpherical(new THREE.Spherical(120, THREE.MathUtils.degToRad(56), Math.PI / 4));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const v = new THREE.Vector3();
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const [x, y, z] of points) {
    v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    x0 = Math.min(x0, v.x);
    x1 = Math.max(x1, v.x);
    y0 = Math.min(y0, v.y);
    y1 = Math.max(y1, v.y);
  }
  return { x0, x1, y0, y1 };
}
const corners = (x: number, z: number, w: number, d: number, y0: number, y1: number, yaw = 0) => {
  const out: [number, number, number][] = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      for (const y of [y0, y1]) {
        const lx = (sx * w) / 2,
          lz = (sz * d) / 2;
        out.push([x + lx * Math.cos(yaw) + lz * Math.sin(yaw), y, z - lx * Math.sin(yaw) + lz * Math.cos(yaw)]);
      }
  return out;
};
const apart = (a: ReturnType<typeof screenBox>, b: ReturnType<typeof screenBox>) =>
  a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;

test('from the default camera the board overlaps neither the director, their name tag nor the zone sign', () => {
  // A name tag is about 28 x 100 CSS px; at the default fit (about 20 px per metre) that is 1.4 x 5 m.
  const tag = { h: 1.4, halfW: 2.5 };
  for (const director of [1, 3, 4, 5]) {
    const layout = layoutOf(director, 4, 2);
    const { board } = layout;
    const panel = screenBox(corners(board.x, board.z, 3.3, 0.08, 1.2, 2.85, board.yaw));
    for (const d of layout.desks.filter(x => x.zone === 'director')) {
      const desk = screenBox([
        ...corners(d.x, d.z, 1.8, 0.8, 0, 1.32),
        ...corners(d.x, d.z - 1.45, 1.8, 0.45, 0, 0.9),
        ...corners(d.seat.x, d.seat.z, 0.7, 0.7, 0, 1.45),
      ]);
      assert.ok(apart(panel, desk), `${director} director(s): the board clears desk ${d.index}`);
      const anchor = screenBox([[d.seat.x, 1.78, d.seat.z]]);
      const label = { x0: anchor.x0 - tag.halfW, x1: anchor.x1 + tag.halfW, y0: anchor.y0, y1: anchor.y1 + tag.h };
      assert.ok(apart(panel, label), `${director} director(s): the board clears the name tag of desk ${d.index}`);
    }
    const sign = layout.signs.find(s => s.key === 'director')!;
    const plaque = screenBox(corners(sign.x, sign.z, 1.96, 0.05, 0.89, 1.41, Math.PI / 4));
    assert.ok(apart(panel, plaque), 'the board clears the DIRECTOR sign');
  }
});

test('street plants and dividers keep off every line people walk', () => {
  for (const layout of [layoutOf(), layoutOf(1, 4, 14, 4, 10)]) {
    const crossings = [...layout.desks.map(d => d.aisleZ), ...layout.rooms.map(r => r.laneZ), layout.rest.doorZ];
    assert.ok(layout.streetPlants.length >= 2);
    for (const p of layout.streetPlants) {
      assert.ok(Math.abs(p.x - layout.corridorX) > 0.8, 'off the street centre line');
      for (const c of crossings) assert.ok(Math.abs(p.z - c) >= 1.2, 'not beside a crossing');
    }
    for (const dv of layout.dividers) {
      assert.ok(dv.x1 < layout.corridorX - 1.5);
      for (const d of layout.desks) assert.ok(Math.abs(dv.z - d.aisleZ) > 0.6 && Math.abs(dv.z - d.z) > 1.0);
    }
  }
});

test('no seat sits in the strip the roof edge hides from the default camera', () => {
  for (const layout of [layoutOf(), layoutOf(1, 4, 9, 3, 12)]) {
    const { maxX, maxZ } = layout.bounds;
    for (const spot of layout.rest.spots)
      assert.ok(spot.seat.z <= maxZ - 2.4, 'lounge seats keep back from the front glass');
    for (const room of layout.rooms)
      for (const s of room.seats) assert.ok(s.seat.x <= maxX - 2.4, 'meeting chairs keep back from the east glass');
    for (const d of layout.desks) assert.ok(d.seat.z <= maxZ - 2.4);
  }
});

test('leaving any lounge spot never walks through its furniture', () => {
  const layout = layoutOf(1, 4, 6);
  const { rest } = layout;
  type Rect = { x0: number; x1: number; z0: number; z1: number; name: string };
  const box = (x: number, z: number, hx: number, hz: number, name: string): Rect => ({
    x0: x - hx,
    x1: x + hx,
    z0: z - hz,
    z1: z + hz,
    name,
  });
  const sofa = rest.sofas[1];
  const furniture: Rect[] = [
    box(sofa.x, sofa.z - 0.1, 1.6, 0.48, 'sofa'),
    box(rest.coffee.x, rest.coffee.z, 0.7, 0.35, 'coffee table'),
    box(rest.round.x, rest.round.z, 0.45, 0.45, 'round table'),
    box(rest.table.x, rest.table.z, rest.table.length / 2, 0.76, 'ping-pong'),
    { x0: rest.counter.x0, x1: rest.counter.x1, z0: rest.counter.z - 0.36, z1: rest.counter.z + 0.36, name: 'counter' },
    ...rest.chairs.map((c, i) => box(c.x, c.z, 0.43, 0.43, `armchair ${i}`)),
  ];
  const hits = (a: { x: number; z: number }, b: { x: number; z: number }, r: Rect) => {
    for (let i = 0; i <= 40; i++) {
      const x = a.x + ((b.x - a.x) * i) / 40;
      const z = a.z + ((b.z - a.z) * i) / 40;
      if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return true;
    }
    return false;
  };
  for (const spot of rest.spots)
    for (let k = 1; k < spot.exit.length; k++)
      for (const r of furniture)
        assert.ok(
          !hits(spot.exit[k - 1], spot.exit[k], r),
          `spot ${spot.index} (${spot.kind}) leg ${k} crosses the ${r.name}`,
        );
});

const desk = (layout: OfficeLayout, i: number): Place => ({ kind: 'desk', desk: layout.desks[i] });
const chair = (layout: OfficeLayout, t: number, s: number): Place => ({
  kind: 'room',
  room: layout.rooms[t],
  seat: s,
});
const lounge = (layout: OfficeLayout, spot: number): Place => ({ kind: 'rest', rest: layout.rest, spot });

/** A route may run along aisles, the corridor and room lanes — never through a desk. */
function crossesDesk(layout: OfficeLayout, a: { x: number; z: number }, b: { x: number; z: number }) {
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const z = a.z + ((b.z - a.z) * i) / steps;
    for (const d of layout.desks) if (Math.abs(x - d.x) < 0.78 && Math.abs(z - d.z) < 0.36) return true;
  }
  return false;
}

test('routes start in the origin seat, end in the destination seat and never cross a desk', () => {
  const layout = layoutOf(1, 4, 6, 2, 8);
  const destinations = [
    chair(layout, 0, 0),
    chair(layout, 0, 5),
    chair(layout, 1, 3),
    lounge(layout, 0),
    lounge(layout, 3),
  ];
  for (let i = 0; i < layout.desks.length; i++)
    for (const there of destinations) {
      for (const [from, to] of [
        [desk(layout, i), there],
        [there, desk(layout, i)],
      ]) {
        const route = routeBetween(layout, from, to);
        assert.deepEqual(route.points[0], placePose(from).pos);
        assert.deepEqual(route.points.at(-1), placePose(to).pos);
        for (let k = 1; k < route.points.length; k++)
          assert.ok(!crossesDesk(layout, route.points[k - 1], route.points[k]), `desk ${i} leg ${k}`);
        assert.ok(route.length > 0 && Number.isFinite(route.length));
      }
    }
});

test('walking from a room goes out through its door, and a rest spot leaves by the rest door', () => {
  const layout = layoutOf(1, 2, 2, 2, 8);
  const room = layout.rooms[0];
  const route = routeBetween(layout, chair(layout, 0, 1), desk(layout, 0));
  assert.ok(
    route.points.some(p => Math.abs(p.x - room.doorX) < 0.05 && Math.abs(p.z - room.z1) < 0.05),
    'passes the door',
  );
  const out = routeBetween(layout, lounge(layout, 4), desk(layout, 0));
  assert.ok(out.points.some(p => Math.abs(p.x - layout.rest.x0) < 0.05 && Math.abs(p.z - layout.rest.doorZ) < 0.05));
  assert.equal(placePose(lounge(layout, 2)).pose, 'standing', 'ping-pong players stand');
  assert.equal(placePose(lounge(layout, 0)).pose, 'seated');
});

test('desk to desk on one aisle slides along the aisle without visiting the corridor', () => {
  const layout = layoutOf(1, 4, 1);
  const pm = layout.desks.filter(d => d.zone === 'pm');
  const route = routeBetween(layout, { kind: 'desk', desk: pm[0] }, { kind: 'desk', desk: pm[3] });
  assert.ok(route.points.every(p => p.x < layout.corridorX));
});

test('samePlace tells identical seats from different ones', () => {
  const layout = layoutOf(1, 2, 2, 2, 6);
  assert.ok(samePlace(desk(layout, 0), desk(layout, 0)));
  assert.ok(!samePlace(desk(layout, 0), desk(layout, 1)));
  assert.ok(samePlace(lounge(layout, 2), lounge(layout, 2)));
  assert.ok(!samePlace(lounge(layout, 2), lounge(layout, 3)));
  assert.ok(samePlace(chair(layout, 1, 2), chair(layout, 1, 2)));
  assert.ok(!samePlace(chair(layout, 1, 2), chair(layout, 0, 2)));
  assert.ok(!samePlace(desk(layout, 0), chair(layout, 0, 0)));
});

test('resting follows the recorded allowance: below 5% left, not mid-task, not mid-meeting', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const connection = (remaining: number, over: Partial<AccountConnection> = {}): AccountConnection => ({
    id: 'c',
    provider: 'claude',
    identity: 'me@example.com',
    credentialContext: 'default',
    state: 'SIGNED_IN',
    allowance: [{ label: '5 hour', remainingPercent: remaining, resetsAt: now / 1000 + 3600 }],
    note: '',
    revision: 1,
    firstSeenAt: '2026-10-01T10:00:00Z',
    lastCheckedAt: '2026-10-01T11:30:00Z',
    ...over,
  });
  const agent = { provider: 'claude' as const, account: 'me@example.com' };
  assert.equal(remainingAllowance(agent, [connection(3)], now), 3);
  assert.equal(
    remainingAllowance(agent, [connection(40), connection(2, { lastCheckedAt: '2026-10-01T11:50:00Z' })], now),
    2,
    'the newest observation wins',
  );
  assert.equal(remainingAllowance(agent, [connection(3, { identity: 'other@example.com' })], now), null);
  assert.equal(remainingAllowance(agent, [connection(3, { state: 'SIGNED_OUT' })], now), null);
  assert.equal(
    remainingAllowance(agent, [connection(3, { lastCheckedAt: '2026-09-30T00:00:00Z' })], now),
    null,
    'a stale observation is ignored',
  );
  const reset = { allowance: [{ label: 'w', remainingPercent: 3, resetsAt: now / 1000 - 5 }] };
  assert.equal(
    remainingAllowance(agent, [connection(3, reset)], now),
    null,
    'a window that has reset no longer counts',
  );
  assert.equal(remainingAllowance(agent, undefined, now), null);
  assert.equal(shouldRest('idle', 4.9, false), true);
  assert.equal(shouldRest('idle', 5, false), false, 'exactly 5% is not below 5%');
  assert.equal(shouldRest('done', 0, false), true);
  assert.equal(shouldRest('working', 1, false), false, 'a working agent stays at the desk');
  assert.equal(shouldRest('idle', 1, true), false, 'a meeting keeps its people');
  assert.equal(shouldRest('idle', null, false), false, 'no observation, no rest');
  assert.deepEqual(assignRooms(['a', 'b'], ['b', 'c']), ['c', 'b'], 'a freed spot is reused, nobody else moves');
});
